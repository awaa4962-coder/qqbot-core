import { callStickerSelection } from "../../model-router.mjs";
import { listSelectableStickers } from "./catalog-store.mjs";

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
  const candidates = buildStickerCandidates(context, options);
  if (!candidates.length) return noMatch("没有语义可靠的候选", []);
  const model = options.model || callStickerSelection;
  const prompt = buildStickerSelectionPrompt(context, candidates);
  let output = await model(prompt, "primary");
  if (!output) output = await model(prompt, "fallback");
  const selectedId = parseStickerSelection(output);
  const selected = candidates.find(candidate => candidate.id === selectedId);
  if (!selected) return noMatch("模型选择无匹配", candidates);
  return {
    action: "send",
    stickerId: selected.id,
    sticker: selected,
    candidates: publicCandidates(candidates),
    reason: "模型从语义候选中选中",
  };
}

export function buildStickerCandidates(context = {}, options = {}) {
  const entries = options.entries || listSelectableStickers({ groupId: context.groupId });
  const query = buildQueryText(context);
  const cueTags = inferCueTags(query);
  if (!cueTags.length) return [];
  const scored = entries
    .map(entry => ({ entry, score: scoreEntry(entry, cueTags, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.sendCount - b.entry.sendCount);
  return scored.slice(0, Math.max(1, Math.min(12, Number(options.limit || 8))))
    .map(item => ({ ...item.entry, score: item.score }));
}

export function buildStickerSelectionPrompt(context, candidates) {
  const recent = normalizeRecentContext(context.contextMessages);
  const lines = candidates.map((candidate, index) => [
    String(index + 1) + ". id=" + candidate.id,
    "标签=" + candidate.tags.join("、"),
    "含义=" + candidate.description,
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
  const text = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed.selected === "string" ? parsed.selected.trim() : "";
  } catch {
    return "";
  }
}

function scoreEntry(entry, cueTags, query) {
  let score = 0;
  for (const tag of entry.tags || []) {
    if (cueTags.includes(tag)) score += 5;
    if (query.includes(tag)) score += 2;
  }
  const description = String(entry.description || "");
  for (const tag of cueTags) {
    if (description.includes(tag)) score += 2;
  }
  score += Math.max(0, 1 - Math.min(1, Number(entry.sendCount || 0) / 50));
  return score;
}

function inferCueTags(text) {
  return CUE_RULES.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function buildQueryText(context) {
  return [
    context.userMessage,
    context.assistantText,
    context.replyText,
    ...normalizeRecentContext(context.contextMessages),
  ].filter(Boolean).join(" ");
}

function normalizeRecentContext(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(item => ["user", "assistant"].includes(String(item?.role || "")))
    .slice(-6)
    .map(item => (item.role === "assistant" ? "助手：" : "用户：") + clip(contentText(item.content), 180));
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(item => item?.type === "text").map(item => item.text || "").join(" ");
}

function publicCandidates(candidates) {
  return candidates.map(candidate => ({
    id: candidate.id,
    description: candidate.description,
    tags: [...candidate.tags],
    score: candidate.score,
  }));
}

function noMatch(reason, candidates) {
  return {
    action: "no_match",
    stickerId: "",
    sticker: null,
    candidates: publicCandidates(candidates),
    reason,
  };
}

function clip(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
