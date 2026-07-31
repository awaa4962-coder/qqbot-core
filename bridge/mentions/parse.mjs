import { normalizeMsg } from "../context/messages.mjs";

const CQ_AT_RE = /\[CQ:at,qq=([^\],]+)[^\]]*\]/g;

export function parseMentions(message, rawText = "", options = {}) {
  const selfUin = String(options.selfUin || "");
  const mentions = [];
  for (const segment of normalizeMsg(message)) {
    if (segment?.type !== "at") continue;
    addMention(mentions, segment.data?.qq, selfUin, "segment");
  }
  if (typeof rawText === "string" && rawText) {
    for (const match of rawText.matchAll(CQ_AT_RE)) {
      addMention(mentions, match[1], selfUin, "raw");
    }
  }
  return mentions;
}

export function mentionedUsers(mentions) {
  return (Array.isArray(mentions) ? mentions : [])
    .filter(item => !item.isBot && !item.isAll);
}

function addMention(target, rawQq, selfUin, source) {
  const qq = normalizeMentionQq(rawQq);
  if (!qq) return;
  if (target.some(item => item.qq === qq)) return;
  target.push({
    qq,
    isBot: Boolean(selfUin && qq === selfUin),
    isAll: qq === "all",
    source,
  });
}

function normalizeMentionQq(value) {
  const qq = String(value || "").trim();
  if (!qq) return "";
  if (qq.toLowerCase() === "all") return "all";
  return /^\d{5,20}$/.test(qq) ? qq : "";
}
