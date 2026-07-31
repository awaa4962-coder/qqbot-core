// bridge/profile.mjs — 用户画像生成
import { users, saveUsers } from "./storage.mjs";
import { callTaskApi } from "./api-providers/gateway.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";

async function generateProfileVia(prompt, position) {
  const result = await callTaskApi("profile", position, {
    messages: [
      { role: 'system', content: '你是一个用户画像生成器。请根据聊天记录总结用户特点，简洁、准确。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 100,
    temperature: 0.5,
    timeoutMs: 10000,
  });
  if (!result.ok) return "";
  const packet = buildOutputPacket(result.raw, { provider: result.provider });
  return packet.ok ? packet.text : "";
}

export async function generateProfile(uid) {
  const u = users[uid];
  if (!u) return '';
  const recent = u.chats.slice(-20);
  if (!recent.length) return '';

  const chatLog = recent.map(function(c) {
    return '[' + new Date(c.ts).toLocaleString('zh-CN') + '] 在' + c.group + '群说: ' + c.text;
  }).join('\n');

  const prompt = '根据以下聊天记录，用一句话概括这个人的性格、兴趣和说话特点（20-50字）：\n\n' + chatLog;

  for (const position of ["primary", "fallback"]) {
    try {
      const desc = await generateProfileVia(prompt, position);
      if (desc) {
        u.profile = desc.trim();
        saveUsers();
        return desc.trim();
      }
    } catch {}
  }
  return '';
}
