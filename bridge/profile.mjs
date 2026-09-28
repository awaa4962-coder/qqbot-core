// bridge/profile.mjs — 用户画像生成
import { users, saveUsers } from "./storage.mjs";
import { callTaskApi } from "./api-providers/gateway.mjs";
import { createModelTaskBudget } from "./api-providers/task-budget.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { redactSensitiveText } from "./privacy.mjs";
import { getUserMemoryGeneration, getMemoryPrivacyGeneration } from "./memory-profile/generation.mjs";
import { chatRunSignal, chatRunStopReason } from "./cognition/chat-run.mjs";
import { memoryCorrectionSnapshot } from "./memory-profile/notes.mjs";
import { excludedMemorySource } from "./memory-profile/source-exclusions.mjs";
import { summaryPrivacy } from "./group-summary/state.mjs";
import { bindLayerMemoryReferences, createMemoryReadGuard } from "./memory-profile/read-guard.mjs";

function profileRequest(prompt) {
  return {
    messages: [
      { role: 'system', content: '你是一个用户画像生成器。请根据聊天记录总结用户特点，简洁、准确。' },
      { role: 'user', content: prompt },
    ],
    promptMetadata: { promptVersion: "profile-v1" },
    maxTokens: 100,
    temperature: 0.5,
    timeoutMs: 10000,
  };
}

async function generateProfileVia(prompt, position, prepared) {
  const result = await callTaskApi("profile", position, prepared);
  if (!result.ok) return "";
  const packet = buildOutputPacket(result.raw, { provider: result.provider });
  return packet.ok ? packet.text : "";
}

export async function generateProfile(uid, options = {}) {
  const u = users[uid];
  if (!u) return '';
  const generation = getUserMemoryGeneration(uid);
  const privacyGeneration = getMemoryPrivacyGeneration();
  const recent = profileHistory(uid, u.chats);
  if (!recent.length) return '';
  const guards = profileReadGuards(uid, recent);
  const isCurrent = () => users[uid] === u && generation === getUserMemoryGeneration(uid) &&
    privacyGeneration === getMemoryPrivacyGeneration() && !chatRunStopReason() && guards.every(guard => !guard.reason()) &&
    profileHistory(uid, recent).length === recent.length;

  const chatLog = recent.map(function(c) {
    return '[' + new Date(c.ts).toLocaleString('zh-CN') + '] 在' + c.group + '群说: ' + redactSensitiveText(c.text);
  }).join('\n');

  const prompt = '根据以下聊天记录，用一句话概括这个人的性格、兴趣和说话特点（20-50字）：\n\n' + chatLog;

  try {
    const budget = createModelTaskBudget("profile", { now: options.budgetClock,
      signal: globalThis.AbortSignal.any([chatRunSignal(), options.signal].filter(Boolean)),
      assertCurrent: () => {
        if (!isCurrent()) throw Object.assign(new Error("profile_context_changed"), { code: "CHAT_MEMORY_CHANGED" });
      },
    });
    for (const position of ["primary", "fallback"]) {
      const prepared = budget.prepare(profileRequest(prompt));
      let generated = '';
      try { generated = await (options.generate || generateProfileVia)(prompt, position, prepared); }
      catch {}
      finally { budget.assertCurrent(); }
      const desc = redactSensitiveText(generated).trim();
      if (desc) {
        budget.assertCurrent();
        u.profile = desc;
        saveUsers();
        return desc;
      }
    }
  } catch {}
  return '';
}

function profileReadGuards(uid, recent) {
  const groups = new Map();
  for (const item of recent) {
    const groupId = String(item.group);
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({ userId: String(uid), messageId: item.messageId, replyToMessageId: item.replyToMessageId, turnId: item.turnId });
  }
  return [...groups].map(([groupId, contextSources]) => {
    const scope = { surface: "group", userId: String(uid), groupId };
    const guard = createMemoryReadGuard(scope);
    const [layer] = bindLayerMemoryReferences([{ contextSources }], scope);
    guard.track(layer.contextMemorySources);
    return guard;
  });
}

function profileHistory(uid, chats) {
  try {
    const privacy = summaryPrivacy();
    const cutoff = privacy?.users?.[String(uid)] ?? 0;
    if (!privacy?.users || Array.isArray(privacy.users) || !Number.isFinite(cutoff) || cutoff < 0) return [];
    const exclusions = new Map();
    return (Array.isArray(chats) ? chats : []).slice(-20).filter(chat => {
      if (!chat || chat.memoryCommand || chat.deleted || chat.recalled || chat.retracted || !Number.isFinite(chat.ts) || chat.ts <= cutoff) return false;
      const groupId = String(chat.group);
      if (!exclusions.has(groupId)) exclusions.set(groupId, memoryCorrectionSnapshot({ userId: String(uid), groupId }).excludedMessageIds);
      return !excludedMemorySource(chat, exclusions.get(groupId));
    });
  } catch { return []; }
}
