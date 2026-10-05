import { MODEL_TASKS, buildStickerSelectionRequest, callStickerSelection } from "../../model-router.mjs";
import { createModelTaskBudget } from "../../api-providers/task-budget.mjs";
import { assertChatRunCurrent, chatRunSignal } from "../../cognition/chat-run.mjs";
import { listSelectableStickers } from "./catalog-store.mjs";
import { createStickerPrivacyGuard } from "./privacy.mjs";
import { isStickerEntrySendable, normalizeStickerTags } from "./schema.mjs";
import { registeredContextSources } from "../../context/pruning.mjs";

const HISTORY_KINDS = new Set(["group", "memory", "thread", "quote", "history", "recent"]);

const CUE_RULES = Object.freeze([
  ["无语", /无语|离谱|看不懂|没话说|沉默|服了|逆天/],
  ["吐槽", /吐槽|锐评|阴阳|蚌埠住|绷不住|这也行/],
  ["惊讶", /震惊|惊讶|卧槽|居然|竟然|真的假的|啊这/],
  ["开心", /开心|高兴|好耶|赢了|成功|舒服了/],
  ["搞笑", /哈哈|笑死|乐死|太逗|好笑|绷不住/],
  ["生气", /生气|气死|哈气|炸毛|可恶|恼火/],
  ["难过", /难过|伤心|哭了|委屈|难受/],
  ["害羞", /害羞|脸红|不好意思/],
  ["安慰", /安慰|抱抱|没事的|别难过/],
  ["撒娇", /撒娇|求求|拜托|可怜/],
  ["感谢", /谢谢|感谢|辛苦了/],
  ["鼓励", /加油|鼓励|支持你|可以的/],
  ["赞同", /确实|同意|没错|对的|有道理|就是这样/],
]);

export async function selectSticker(context = {}, options = {}) {
  const check = createStickerPrivacyGuard(context.userId);
  const budget = createModelTaskBudget(MODEL_TASKS.STICKER_SELECT, {
    now: options.budgetClock,
    signal: globalThis.AbortSignal.any([options.signal, chatRunSignal()].filter(Boolean)),
    assertCurrent: () => { assertChatRunCurrent(); check(); options.assertCurrent?.(); },
  });
  budget.assertCurrent();
  const candidates = buildStickerCandidates(context, options);
  budget.assertCurrent();
  if (!candidates.length) return noMatch("没有语义可靠的候选", [], "no_candidates");
  const model = options.model || callStickerSelection;
  const prompt = buildStickerSelectionPrompt(context, candidates);
  let reasonCode = "selection_invalid";
  for (const position of ["primary", "fallback"]) {
    const result = await requestSelection(model, prompt, position, budget);
    budget.assertCurrent();
    if (result.failed) { reasonCode = "selection_failed"; continue; }
    const parsed = readStickerSelection(result.output);
    if (parsed.kind === "none") return noMatch("模型选择无匹配", candidates, "selection_none");
    const selected = parsed.kind === "selected" && candidates.find(candidate => candidate.id === parsed.id);
    budget.assertCurrent();
    if (!selected) { reasonCode = "selection_invalid"; continue; }
    return {
      action: "send",
      stickerId: selected.id,
      sticker: selected,
      candidates: publicCandidates(candidates),
      reason: "模型从语义候选中选中",
      reasonCode: "selection_selected",
    };
  }
  budget.assertCurrent();
  return noMatch(reasonCode === "selection_failed" ? "表情选择失败" : "模型选择无匹配", candidates, reasonCode);
}

async function requestSelection(model, prompt, position, budget) {
  const request = budget.prepare(buildStickerSelectionRequest(prompt));
  try { return { output: await model(prompt, position, request) }; }
  catch (error) {
    budget.assertCurrent();
    if (error?.name === "AbortError" || ["MODEL_TASK_BUDGET", "CHAT_CANCELLED", "STICKER_PRIVACY_CHANGED"].includes(error?.code)) throw error;
    return { failed: true };
  }
}

export function buildStickerCandidates(context = {}, options = {}) {
  const entries = options.entries || listSelectableStickers({ groupId: context.groupId });
  const query = buildQueryText(context);
  const cueTags = inferCueTags(query);
  const queryTerms = lexicalTerms(query);
  const ids = new Set();
  const scored = entries
    .filter(entry => candidateEligible(entry, context) && !ids.has(entry.id) && ids.add(entry.id))
    .map(entry => ({ ...entry, tags: normalizeStickerTags(entry.tags) }))
    .map(entry => ({ entry, score: scoreEntry(entry, cueTags, query, queryTerms) }))
    .sort((a, b) => b.score - a.score || Number(a.entry.sendCount || 0) - Number(b.entry.sendCount || 0));
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(8, Math.floor(Number(options.limit)))) : 8;
  return diverseCandidates(scored, limit)
    .map(item => ({ ...item.entry, score: item.score }));
}

function candidateEligible(entry, context) {
  if (typeof entry?.id !== "string" || !entry.id.trim() || !isStickerEntrySendable(entry) || entry.captureState === "retired") return false;
  if (!entry.url && !(entry.emojiId && entry.packageId && entry.key && entry.key !== "configured")) return false;
  const groups = Array.isArray(entry.allowedGroups) ? entry.allowedGroups : [];
  return !groups.length || (context.private !== true && groups.map(Number).includes(Number(context.groupId)));
}

function diverseCandidates(scored, limit) {
  const selected = [];
  const used = new Set();
  const remaining = [...scored];
  while (remaining.length && selected.length < limit) {
    const topScore = remaining[0].score;
    const diverse = remaining.findIndex(item => item.score === topScore && !used.has(diversityKey(item.entry)));
    const [item] = remaining.splice(Math.max(0, diverse), 1);
    selected.push(item);
    used.add(diversityKey(item.entry));
  }
  return selected;
}

function diversityKey(entry) {
  return (entry.tags || []).filter(tag => tag !== "其他").sort().join("|") || clip(entry.description, 40);
}

export function buildStickerSelectionPrompt(context, candidates) {
  const recent = normalizeRecentContext(context.contextMessages);
  const lines = candidates.map((candidate, index) => [
    String(index + 1) + ". id=" + candidate.id,
    "标签=" + (candidate.tags || []).slice(0, 8).map(tag => clip(tag, 20)).join("、"),
    "含义=" + clip(candidate.description, 240),
  ].join("；"));
  return [
    "当前用户消息：" + clip(context.userMessage, 400),
    "夜星准备发送的文字：" + clip(context.assistantText, 400),
    context.replyText ? "被回复内容：" + clip(context.replyText, 240) : "",
    recent.length ? "最近对话：\n" + recent.join("\n") : "",
    "候选表情：\n" + lines.join("\n"),
    "只有表情与当前语气和文字回复确实匹配时才选择。",
    "输出：{\"selected\":\"候选id\"}；没有可靠匹配输出：{\"selected\":null}。",
  ].filter(Boolean).join("\n\n");
}

export function parseStickerSelection(value) {
  const parsed = readStickerSelection(value);
  return parsed.kind === "selected" ? parsed.id : "";
}

function readStickerSelection(value) {
  const text = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { kind: "invalid" };
  try {
    const parsed = JSON.parse((text.startsWith("{") || text.startsWith("[")) ? text : text.slice(start, end + 1));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.hasOwn(parsed, "selected")) return { kind: "invalid" };
    if (parsed.selected === null) return { kind: "none" };
    return typeof parsed.selected === "string" && parsed.selected.trim()
      ? { kind: "selected", id: parsed.selected.trim() } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function scoreEntry(entry, cueTags, query, queryTerms) {
  let score = 0;
  for (const tag of entry.tags || []) {
    if (cueTags.includes(tag)) score += 5;
    if (query.includes(tag)) score += 2;
  }
  const description = clip(entry.description, 240);
  for (const tag of cueTags) {
    if (description.includes(tag)) score += 2;
  }
  const overlap = [...lexicalTerms(description)].filter(term => queryTerms.has(term)).length;
  score += Math.min(6, overlap);
  return score;
}

function lexicalTerms(text) {
  const terms = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) || []) {
    if (/^[a-z0-9_]+$/.test(word)) terms.add(word);
    else for (let index = 0; index < word.length - 1 && terms.size < 96; index++) terms.add(word.slice(index, index + 2));
    if (terms.size >= 96) break;
  }
  return terms;
}

function inferCueTags(text) {
  return CUE_RULES.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function buildQueryText(context) {
  return [
    clip(context.userMessage, 400),
    clip(context.assistantText, 400),
    clip(context.replyText, 240),
    ...normalizeRecentContext(context.contextMessages),
  ].filter(Boolean).join(" ");
}

function normalizeRecentContext(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-12)
    .filter(item => ["user", "assistant"].includes(String(item?.role || "")) &&
      !["tool_calls", "tool_call_id", "providerContinuation", "reasoning_content"].some(key => item?.[key] !== undefined) &&
      registeredContextSources([item]).some(source => HISTORY_KINDS.has(source.kind)))
    .slice(-6)
    .map(item => {
      const source = registeredContextSources([item]).find(value => HISTORY_KINDS.has(value.kind));
      return "来源=" + clip(source.kind, 20) + ";message_id=" + clip(source.messageId, 40) +
        ";speaker_uid=" + clip(source.userId, 40) + "；" +
        (item.role === "assistant" ? "助手：" : "用户：") + clip(contentText(item.content), 180);
    });
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(item => item?.type === "text").map(item => item.text || "").join(" ");
}

function publicCandidates(candidates) {
  return candidates.map(candidate => ({
    id: candidate.id,
    description: clip(candidate.description, 240),
    tags: [...candidate.tags],
    score: candidate.score,
  }));
}

function noMatch(reason, candidates, reasonCode) {
  return {
    action: "no_match",
    stickerId: "",
    sticker: null,
    candidates: publicCandidates(candidates),
    reason,
    reasonCode,
  };
}

function clip(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
