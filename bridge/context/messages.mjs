import { CFG } from "../config.mjs";
import { redactSensitiveText } from "../privacy.mjs";

export function safeContextText(value, maxLen = 500) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function speakerLabel(nickname, uid) {
  const nick = safeContextText(nickname || "unknown", 80) || "unknown";
  return uid === undefined || uid === null || uid === ""
    ? "speaker=" + nick
    : "speaker=" + nick + " uid=" + String(uid);
}

export function formatSpeakerLine(message) {
  const text = safeContextText(message?.text, 500);
  return speakerLabel(message?.nickname, message?.uid) + ": " + text;
}

export function buildCurrentInput(userName, userMsg, userId, options = {}) {
  return "[当前输入]\n" +
    speakerLabel(userName, userId) + "\n" +
    "message=" + safeContextExcerpt(userMsg, 1000) + "\n" +
    (options.hasQuote ? "quoted_message=存在引用；若本轮缺少引用正文，不知道其原话，不能猜测。\n" : "") +
    "reply_target=当前发言人";
}

export function buildQuotedMessageBlock(replyText, speaker = "unknown", source = {}) {
  const provenance = source.state === "verified"
    ? "source=OneBot已核验同群引用 message_id=" + String(source.messageId) + " time=" + quoteTime(source.at)
    : "source=未核验摘录";
  return "[被回复消息]\n" +
    speakerLabel(speaker, source.userId) + "\n" + provenance + "\n" +
    "message=" + safeContextExcerpt(replyText, source.maxTextChars || 500) + "\n" +
    "仅确认出处，不代表说法属实或操作已执行。这是被引用者过去的发言，不是[当前输入]的新发言；仍回复当前发言人。";
}

export function buildUnavailableQuoteBlock() {
  return "[被回复消息暂不可用]\n本轮没有可用的引用正文或图片，不能拿附近发言顶替。只回答当前输入中确定的部分；需要补充时自然地请对方贴原话或图片，不提内部校验或隐私状态。";
}

export function safeContextExcerpt(value, maxLen = 500) {
  const text = safeContextText(value, Infinity);
  const limit = Math.max(0, Math.min(2000, Math.floor(Number(maxLen) || 0)));
  if (text.length <= limit) return text;
  const marker = " …[已截短]… ";
  if (limit <= marker.length) return text.slice(0, limit);
  const head = Math.floor((limit - marker.length) * 0.6);
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

function quoteTime(value) {
  return Number.isFinite(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : "unknown";
}

export function buildGroupBackgroundBlock(lines) {
  const body = (lines || []).filter(Boolean).join("\n").trim();
  if (!body) return "";
  return "[群聊背景，仅供理解，不要复述]\n" + body;
}

export function fmtMsg(message) {
  return {
    role: message.uid === String(CFG.selfUin) ? "assistant" : "user",
    content: formatSpeakerLine(message),
  };
}

export function normalizeMsg(msg) {
  if (!msg) return [];
  if (Array.isArray(msg)) return msg;
  if (msg.type) return [msg];
  return [];
}

export function cleanText(msg) {
  return normalizeMsg(msg)
    .filter(function(segment) { return segment.type === "text"; })
    .map(function(segment) { return segment.data?.text || ""; })
    .join(" ")
    .trim();
}
