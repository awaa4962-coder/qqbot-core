import { compareRelevance, currentTopicText, isContinuation, messageFeatures, normalizeConversationText, retrievalFeatures } from "./relevance.mjs";
import { wallAgeMs } from "../runtime-clock.mjs";
import { replyWindow } from "./source-groups.mjs";
import { archivedTextCompleteness } from "./messages.mjs";

const MAX_SCAN = 120;
const GROUP_MAX_AGE_MS = 30 * 60 * 1000;

export function selectConversationThread(thread, options = {}) {
  if (!thread?.turns?.length || options.quoteEvidence?.state === "unavailable" || currentTopicText(options.userMsg).switched) return null;
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
  const topic = currentTopicText(options.userMsg);
  const query = topic.switched ? topic.text : options.replyText || topic.text;
  const features = retrievalFeatures(query);
  const limit = Math.min(12, options.limit || 8);
  const targets = new Set((options.mentions || []).filter(item => !item.isBot && !item.isAll).map(item => String(item.qq)));
  const { selected, quote } = selectComponents(candidates, { options, topic, features, targets, limit });
  const result = [...selected.values()].sort((a, b) => Number(a.message.ts || 0) - Number(b.message.ts || 0));
  return { items: dedupeSelection(result).filter(item => !options.replyText || item.message !== quote),
    strategy: selectionStrategy(quote, targets, selected.size > 0) };
}

function selectComponents(candidates, context) {
  const selected = new Map();
  const quote = context.topic.switched ? null : candidates.find(item => context.options.replyToMessageId &&
    String(item.messageId) === String(context.options.replyToMessageId));
  addSeedWindow(quote, "reply_chain", candidates, selected, context.limit);
  const ranked = candidates.map(message => ({ message, ...compareRelevance(context.features, messageFeatures(message)) }))
    .filter(item => item.score > 0 && (!context.targets.size || context.targets.has(String(item.message.uid))))
    .sort((a, b) => b.score - a.score || Number(b.message.ts || 0) - Number(a.message.ts || 0));
  for (const item of ranked) {
    addSeedWindow(item.message, context.targets.size ? "mention" : item.reason,
      candidates, selected, context.limit, item.score);
  }
  addMentionFallback(candidates, ranked, context, selected);
  addRecentFallback(candidates, context, selected);
  return { selected, quote };
}

function addSeedWindow(seed, reason, candidates, selected, limit, score = 0) {
  if (!seed) return;
  const window = replyWindow(seed, candidates);
  const additions = window.filter(message => !selected.has(message));
  if (!additions.length || selected.size + additions.length > limit) return;
  const linked = window.length > 1;
  for (const message of window) {
    const existing = selected.get(message);
    if (existing) {
      if (linked && message !== seed) existing.reason = "reply_chain";
      continue;
    }
    selected.set(message, {
      message,
      reason: linked ? "reply_chain" : reason,
      score: message === seed ? score : 0,
    });
  }
}

function addMentionFallback(candidates, ranked, context, selected) {
  if (ranked.length || !context.targets.size) return;
  const mentions = candidates.filter(item => context.targets.has(String(item.uid))).slice(-3).reverse();
  for (const message of mentions) {
    addSeedWindow(message, "mention", candidates, selected, context.limit);
  }
}

function addRecentFallback(candidates, context, selected) {
  if (!canUseRecentFallback(selected.size > 0, context.targets, context.options)) return;
  for (const message of candidates.slice(-4).reverse()) {
    addSeedWindow(message, "recent", candidates, selected, context.limit);
  }
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
  if (message.memoryCommand) return true;
  if (message.group && options.groupId && String(message.group) !== String(options.groupId)) return true;
  if (String(message.messageId || "") === String(options.currentMessageId || "") && options.currentMessageId) return true;
  if ([message.messageId, message.turnId].some(id => id && options.excludeMessageIds?.has(String(id)))) return true;
  return message.role === "assistant" || Boolean(options.selfUin && String(message.uid) === String(options.selfUin));
}

function dedupeSelection(items) {
  const seen = new Set();
  return items.filter(item => {
    if (item.reason === "reply_chain") return true;
    const key = String(item.message.uid) + ":" + normalizeConversationText(item.message.text);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function selectionSource(message, kind, reason, score = 0, clipped = false) {
  const completeness = archivedTextCompleteness(message);
  return {
    kind,
    messageId: String(message.messageId ?? ""),
    userId: String(message.uid ?? ""),
    turnId: String(message.turnId ?? ""),
    replyToMessageId: String(message.replyToMessageId ?? ""),
    at: message.ts,
    reason,
    score,
    clipped: clipped === true || completeness === "truncated",
    completeness,
  };
}

export function selectRecentImageMessage(messages = [], options = {}) {
  if (!/图|照片|表情|截图|image|picture|photo|[这那](?:个|位|张)?(?:是谁|是什么角色|认识吗)/i.test(String(options.userMsg || ""))) return null;
  if (currentTopicText(options.userMsg).switched) return null;
  const targets = new Set((options.mentions || []).filter(item => !item.isBot && !item.isAll).map(item => String(item.qq)));
  const eligible = messages.slice(-MAX_SCAN).filter(item => item.imageUrls?.length &&
    /^-?\d{1,20}$/.test(String(item.messageId || "")) && /^\d{1,20}$/.test(String(item.uid || "")) &&
    item.role !== "assistant" && Number.isFinite(item.ts) && item.ts > 0 && item.ts <= (options.now ?? Date.now()) &&
    wallAgeMs(item.ts, options.now ?? Date.now()) <= 5 * 60 * 1000 &&
    (!options.replyToMessageId || String(item.messageId) === String(options.replyToMessageId)));
  if (options.replyToMessageId) return eligible.at(-1) || null;
  const own = eligible.filter(item => targets.size ? targets.has(String(item.uid)) : String(item.uid) === String(options.uid));
  return own.at(-1) || null;
}
