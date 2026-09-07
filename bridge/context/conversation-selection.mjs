import { compareRelevance, currentTopicText, isContinuation, messageFeatures, normalizeConversationText, retrievalFeatures } from "./relevance.mjs";
import { wallAgeMs } from "../runtime-clock.mjs";

const MAX_SCAN = 120;
const GROUP_MAX_AGE_MS = 30 * 60 * 1000;

export function selectConversationThread(thread, options = {}) {
  if (!thread?.turns?.length || currentTopicText(options.userMsg).switched) return null;
  const turns = thread.turns;
  const anchor = threadAnchor(turns, options);
  if (anchor < 0) return null;
  const selected = relatedTurns(turns, anchor);
  const topic = selected.at(-1) === turns.at(-1) ? thread.topic : "相关历史对话";
  return { ...thread, turns: selected, turnCount: selected.length, topic };
}

function threadAnchor(turns, options) {
  let anchor = turns.findIndex(turn => options.replyToMessageId && String(turn.messageId) === String(options.replyToMessageId));
  if (anchor < 0 && options.replyToMessageId && String(options.replyUserId || "") !== String(options.selfUin || "bot")) return -1;
  if (anchor < 0 && !options.replyText && continuesTopic(options.userMsg, turnText(turns.at(-1)))) anchor = turns.length - 1;
  if (anchor < 0) anchor = bestTurnIndex(turns, options.replyText || options.userMsg);
  return anchor;
}

function relatedTurns(turns, anchor) {
  let start = anchor;
  while (start > 0 && anchor - start < 3 && continuesTopic(turns[start].userSummary, turnText(turns[start - 1]))) start--;
  const anchorText = turnText(turns[start]);
  let end = anchor;
  while (end + 1 < turns.length && continuesTopic(turns[end + 1].userSummary, anchorText)) end++;
  const selected = turns.slice(start, end + 1).filter(turn =>
    turn === turns[anchor] || isContinuation(turn.userSummary) || compareRelevance(anchorText, turn.userSummary).score > 0);
  return selected.slice(-4);
}

function bestTurnIndex(turns, query) {
  const features = retrievalFeatures(query);
  let selected = -1;
  let score = 0;
  turns.forEach((turn, index) => {
    const candidate = compareRelevance(features, retrievalFeatures(turnText(turn))).score;
    if (candidate > 0 && candidate >= score) { selected = index; score = candidate; }
  });
  return selected;
}

function turnText(turn) { return String(turn.userSummary || "") + " " + String(turn.assistantSummary || ""); }

function continuesTopic(text, previousText) {
  if (!isContinuation(text) || currentTopicText(text).switched) return false;
  if (!/^(?:这个|那个|它|刚才|之前)/.test(normalizeConversationText(text))) return true;
  const features = retrievalFeatures(text);
  return (!features.tokens.size && !features.concepts.size) || compareRelevance(features, retrievalFeatures(previousText)).score > 0;
}

export function selectGroupConversation(messages = [], options = {}) {
  const candidates = messages.slice(-MAX_SCAN).filter(message => usableMessage(message, options));
  const selected = new Map();
  const topic = currentTopicText(options.userMsg);
  const query = topic.switched ? topic.text : options.replyText || topic.text;
  const features = retrievalFeatures(query);
  const limit = Math.min(12, options.limit || 8);
  const add = (message, reason, score = 0) => {
    if (message && !selected.has(message)) selected.set(message, { message, reason, score });
  };
  const quote = topic.switched ? null : candidates.find(item => options.replyToMessageId && String(item.messageId) === String(options.replyToMessageId));
  appendReplyChain(quote, candidates, add);
  const targets = new Set((options.mentions || []).filter(item => !item.isBot && !item.isAll).map(item => String(item.qq)));
  const ranked = candidates.map(message => ({ message, ...compareRelevance(features, messageFeatures(message)) }))
    .filter(item => item.score > 0 && (!targets.size || targets.has(String(item.message.uid))))
    .sort((a, b) => b.score - a.score || Number(b.message.ts || 0) - Number(a.message.ts || 0));
  for (const item of ranked.slice(0, limit)) {
    add(item.message, item.reason, item.score);
    if (targets.size) appendReplyChain(item.message, candidates, add);
  }
  if (!ranked.length && targets.size) {
    candidates.filter(item => targets.has(String(item.uid))).slice(-3).forEach(item => add(item, "mention"));
  }
  appendLinkedReplies(candidates, selected, add);
  const focused = selected.size > 0;
  // An explicit quote or mention must not fall back to unrelated nearby chatter.
  if (canUseRecentFallback(focused, targets, options)) candidates.slice(-4).forEach(item => add(item, "recent"));
  const result = [...selected.values()].sort((a, b) => Number(b.reason === "reply_chain") - Number(a.reason === "reply_chain") || b.score - a.score || Number(b.message.ts || 0) - Number(a.message.ts || 0))
    .slice(0, limit).sort((a, b) => Number(a.message.ts || 0) - Number(b.message.ts || 0));
  return { items: dedupeSelection(result).filter(item => !options.replyText || item.message !== quote), strategy: selectionStrategy(quote, targets, focused) };
}

function selectionStrategy(quote, targets, focused) {
  if (quote) return "quote";
  if (targets.size) return "mention";
  return focused ? "lexical" : "recent";
}

function canUseRecentFallback(focused, targets, options) {
  return !focused && !options.replyText && !options.replyToMessageId && !targets.size && !currentTopicText(options.userMsg).switched;
}

function usableMessage(message, options) {
  if (!message || !String(message.text || "").trim()) return false;
  if (wallAgeMs(message.ts, options.now ?? Date.now()) > (options.maxAgeMs || GROUP_MAX_AGE_MS)) return false;
  if (excludedMessage(message, options)) return false;
  const text = normalizeConversationText(message.text);
  if (/^\[(?:图片|非文本消息|已按用户请求清除)\]$/.test(text)) return false;
  if (/^[/\\]?\s*(?:help|status|ping|runtime|帮助|状态|测试|管理帮助|运行状态)\s*$/i.test(text)) return false;
  if (/^[/\\]?\s*(?:admin\s+\w+|jm\s+\d+)\s*$/i.test(text)) return false;
  return true;
}

function excludedMessage(message, options) {
  if (message.group && options.groupId && String(message.group) !== String(options.groupId)) return true;
  if (String(message.messageId || "") === String(options.currentMessageId || "") && options.currentMessageId) return true;
  if ([message.messageId, message.turnId].some(id => id && options.excludeMessageIds?.has(String(id)))) return true;
  return message.role === "assistant" || Boolean(options.selfUin && String(message.uid) === String(options.selfUin));
}

function appendReplyChain(message, candidates, add) {
  const seen = new Set();
  for (let depth = 0; message && depth < 4 && !seen.has(message); depth++) {
    seen.add(message); add(message, "reply_chain");
    message = candidates.find(item => message.replyToMessageId && String(item.messageId) === String(message.replyToMessageId));
  }
}

function appendLinkedReplies(candidates, selected, add) {
  const ids = new Set([...selected.keys()].map(item => String(item.messageId || "")).filter(Boolean));
  for (const item of candidates) {
    if (item.replyToMessageId && ids.has(String(item.replyToMessageId))) add(item, "reply_chain");
  }
}

function dedupeSelection(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = String(item.message.uid) + ":" + normalizeConversationText(item.message.text);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function selectionSource(message, kind, reason, score = 0) {
  return { kind, messageId: String(message.messageId || ""), userId: String(message.uid || ""), reason, score };
}

export function selectRecentImageMessage(messages = [], options = {}) {
  if (!/图|照片|表情|截图|image|picture|photo|[这那](?:个|位|张)?(?:是谁|是什么角色|认识吗)/i.test(String(options.userMsg || ""))) return null;
  if (currentTopicText(options.userMsg).switched) return null;
  const targets = new Set((options.mentions || []).filter(item => !item.isBot && !item.isAll).map(item => String(item.qq)));
  const eligible = messages.slice(-MAX_SCAN).filter(item => item.imageUrls?.length &&
    item.role !== "assistant" && wallAgeMs(item.ts, options.now ?? Date.now()) <= 5 * 60 * 1000 &&
    (!options.replyToMessageId || String(item.messageId) === String(options.replyToMessageId)));
  if (options.replyToMessageId) return eligible.at(-1) || null;
  const own = eligible.filter(item => targets.size ? targets.has(String(item.uid)) : String(item.uid) === String(options.uid));
  return own.at(-1) || null;
}
