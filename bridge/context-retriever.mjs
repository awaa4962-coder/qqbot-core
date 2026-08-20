// bridge/context-retriever.mjs - layered context assembly with lightweight retrieval
import {
  buildCurrentInput,
  buildGroupBackgroundBlock,
  buildQuotedMessageBlock,
  formatSpeakerLine,
} from "./context/messages.mjs";
import {
  recentGroupChat,
  recentHistoryWeighted,
} from "./context/history.mjs";
import { CFG } from "./config.mjs";
import { wallAgeMs } from "./runtime-clock.mjs";
import { users, groupChats } from "./storage.mjs";
import { RETRIEVAL_KEYWORD_RULES } from "./knowledge/topic-rules.mjs";
import { buildMemorySummary, getActiveMemoryContext } from "./memory-profile.mjs";
import { buildMemeContextBlock } from "./knowledge/memes/index.mjs";
import { buildMentionContextBlock } from "./mentions/index.mjs";
import { formatConversationThreadBlock, getConversationThread } from "./cognition/index.mjs";
import {
  buildMinimalPreferenceContextBlock,
  buildPreferenceContextBlock,
  getPreferredDisplayName,
} from "./user-preferences.mjs";

const MAX_RELEVANT_MEMORIES = 5;
const INTERJECTION_CONTEXT_MAX_AGE_MS = 15 * 60 * 1000;
const INTERJECTION_COMMAND_RE =
  /^[/\\]?\s*(?:help|status|ping|version|runtime|admin|jm\b|日报|词云|梗库|帮助|状态|测试|版本|管理|运行|命令)/i;

export function buildLayeredReplyContext(options = {}) {
  const uid = String(options.uid || options.userId || "");
  const groupId = String(options.groupId || options.group_id || "");
  const userName = getPreferredDisplayName(uid, options.userName || options.nickname || "unknown");
  const userMsg = String(options.userMsg || "");
  const isPassiveInterjection = options.isPassiveInterjection === true;

  const currentInput = buildCurrentInput(userName, userMsg, uid);
  const layers = [];
  const thread = isPassiveInterjection ? null : getConversationThread(uid, groupId);
  if (isPassiveInterjection) {
    appendQuotedLayer(layers, options);
    appendMinimalPreferenceLayer(layers, uid);
    appendMemeLayer(layers, options);
    appendInterjectionGroupLayer(layers, groupId, options);
  } else {
    appendActiveReplyLayers(layers, { ...options, uid, groupId, userMsg, thread });
  }

  return {
    history: layers,
    currentInput,
    mood: isPassiveInterjection ? "正常" : deriveMood(groupId),
    memory: getActiveMemoryContext(uid, groupId),
    thread,
  };
}

function appendInterjectionGroupLayer(layers, groupId, options) {
  const block = buildInterjectionBackgroundBlock(groupId, options);
  if (block) pushLayer(layers, block, 80);
}

function appendActiveReplyLayers(layers, options) {
  const contextOptions = {
    ...options,
    excludeMessageIds: conversationMessageIds(options.thread),
  };
  appendQuotedLayer(layers, contextOptions);
  appendMentionLayer(layers, contextOptions);
  appendThreadLayer(layers, contextOptions);
  appendMemeLayer(layers, contextOptions);
  appendPreferenceLayer(layers, contextOptions.uid);
  appendMemoryLayer(layers, contextOptions.uid, contextOptions.groupId);
  appendUserHistoryLayer(layers, contextOptions);
  appendGroupBackgroundLayer(layers, contextOptions.groupId, contextOptions);
}

function appendMemeLayer(layers, options) {
  const memeBlock = buildMemeContextBlock({
    text: options.userMsg,
    groupId: options.groupId,
    uid: options.uid,
  });
  if (memeBlock) pushLayer(layers, memeBlock, 55);
}

function appendMentionLayer(layers, options) {
  const mentionBlock = buildMentionContextBlock(options);
  if (mentionBlock) pushLayer(layers, mentionBlock, 95);
}

function appendQuotedLayer(layers, options) {
  if (!options.replyText) return;
  pushLayer(layers, buildQuotedMessageBlock(options.replyText, options.replySpeaker || "unknown"), 100);
}

function appendThreadLayer(layers, options) {
  const threadBlock = formatConversationThreadBlock(options.thread);
  if (threadBlock) pushLayer(layers, threadBlock, 88);
}

function appendPreferenceLayer(layers, uid) {
  const preferenceBlock = buildPreferenceContextBlock(uid);
  if (preferenceBlock) pushLayer(layers, preferenceBlock, 90);
}

function appendMinimalPreferenceLayer(layers, uid) {
  const preferenceBlock = buildMinimalPreferenceContextBlock(uid);
  if (preferenceBlock) pushLayer(layers, preferenceBlock, 90);
}

function appendMemoryLayer(layers, uid, groupId) {
  const memoryBlock = buildMemoryContextBlock(uid, groupId);
  if (memoryBlock) pushLayer(layers, memoryBlock, 82);
}

function appendUserHistoryLayer(layers, options) {
  const relevant = retrieveRelevantUserMemories(options.uid, options.userMsg, {
    groupId: options.groupId,
    currentMessageId: options.currentMessageId,
    currentText: options.userMsg,
    excludeMessageIds: options.excludeMessageIds,
  });
  if (relevant.length) {
    pushLayer(layers, "[当前发言人相关记忆]\n" + relevant.map(formatSpeakerLine).join("\n"), 70);
    return;
  }
  const weighted = recentHistoryWeighted(options.uid, options.groupId, {
    currentMessageId: options.currentMessageId,
    currentText: options.userMsg,
    excludeMessageIds: options.excludeMessageIds,
  });
  for (const item of weighted.history) pushLayer(layers, item.content, 60, item.role);
}

function appendGroupBackgroundLayer(layers, groupId, options) {
  if (groupId === "private") return;
  const groupRecent = recentGroupChat(groupId, 20, {
    currentMessageId: options.currentMessageId,
    currentText: options.userMsg,
    excludeMessageIds: options.excludeMessageIds,
  });
  const groupCtx = buildGroupBackgroundBlock(groupRecent.map(function(m) { return m.content; }));
  if (groupCtx) pushLayer(layers, groupCtx, 40);
}

export function retrieveRelevantUserMemories(uid, query, options = {}) {
  const user = users[String(uid)];
  if (!user?.chats?.length) return [];
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];
  const groupId = String(options.groupId || "");
  const scored = [];
  for (const chat of user.chats) {
    if (!options.allowCrossGroup && groupId && String(chat.group) !== groupId) continue;
    if (isCurrentMemory(chat, options)) continue;
    const text = String(chat.text || "");
    const score = scoreMemory(text, keywords, chat, groupId);
    if (score > 0) scored.push({ chat, score });
  }
  scored.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return Number(b.chat.ts || 0) - Number(a.chat.ts || 0);
  });
  return scored.slice(0, options.limit || MAX_RELEVANT_MEMORIES).map(item => ({
    uid: String(uid),
    nickname: item.chat.nickname || user.alias || user.nicknames?.at?.(-1) || "unknown",
    text: item.chat.text,
    group: item.chat.group,
    ts: item.chat.ts,
  })).reverse();
}

function isCurrentMemory(chat, options) {
  if (hasExcludedMessageId(chat, options.excludeMessageIds)) return true;
  const currentMessageId = normalizeMessageId(options.currentMessageId);
  if (currentMessageId && normalizeMessageId(chat?.messageId) === currentMessageId) return true;
  if (!currentMessageId) return false;
  const currentText = String(options.currentText || "").replace(/\s+/g, " ").trim();
  const chatText = String(chat?.text || "").replace(/\s+/g, " ").trim();
  return Boolean(currentText && currentText === chatText && wallAgeMs(chat?.ts) < 15000);
}

function conversationMessageIds(thread) {
  return new Set((thread?.turns || []).map(turn => normalizeMessageId(turn.messageId)).filter(Boolean));
}

function hasExcludedMessageId(message, excludedIds) {
  if (!excludedIds?.size) return false;
  return [message?.messageId, message?.replyToMessageId, message?.turnId]
    .map(normalizeMessageId)
    .some(id => id && excludedIds.has(id));
}

function normalizeMessageId(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function pushLayer(layers, content, contextPriority, role = "user") {
  if (!content) return;
  layers.push({ role, content, contextPriority });
}

export function buildMemoryContextBlock(uid, groupId) {
  const summary = buildMemorySummary(uid, groupId);
  if (!summary) return "";
  return "[个性化画像摘要]\n" +
    "仅作为语气和偏好参考；低置信度、过期或敏感内容不得强行影响回复。\n" +
    summary;
}

export function buildInterjectionBackgroundBlock(groupId, options = {}) {
  const source = groupChats[String(groupId)] || [];
  const limit = options.hasImages ? 6 : 4;
  const now = Number(options.now || Date.now());
  const currentMessageId = normalizeMessageId(options.currentMessageId);
  const currentText = normalizeContextLine(options.userMsg);
  const seen = new Set();
  const selected = [];

  for (let index = source.length - 1; index >= 0 && selected.length < limit; index--) {
    const message = source[index];
    if (!isUsableInterjectionMessage(message, {
      currentMessageId,
      currentText,
      now,
    })) continue;
    const key = normalizeContextLine(message.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(message);
  }

  if (!selected.length) return "";
  selected.reverse();
  return [
    "[最近对话，仅供理解短句或图片，不要复述]",
    ...selected.map(formatSpeakerLine),
  ].join("\n");
}

function isUsableInterjectionMessage(message, options) {
  if (isExcludedInterjectionAuthor(message)) return false;
  if (isStaleInterjectionMessage(message, options.now)) return false;
  if (isCurrentInterjectionMessage(message, options)) return false;
  const text = String(message.text || "").trim();
  if (isDiscardedInterjectionText(text)) return false;
  if (INTERJECTION_COMMAND_RE.test(text)) return false;
  return true;
}

function isExcludedInterjectionAuthor(message) {
  return !message || message.role === "assistant" || String(message.uid) === String(CFG.selfUin);
}

function isStaleInterjectionMessage(message, now) {
  return wallAgeMs(message.ts, now) > INTERJECTION_CONTEXT_MAX_AGE_MS;
}

function isCurrentInterjectionMessage(message, options) {
  if (options.currentMessageId && normalizeMessageId(message.messageId) === options.currentMessageId) return true;
  const normalized = normalizeContextLine(message.text);
  return Boolean(
    options.currentText &&
    normalized === options.currentText &&
    wallAgeMs(message.ts, options.now) < 15000
  );
}

function isDiscardedInterjectionText(text) {
  return !text || text === "[非文本消息]" || text === "[图片]";
}

function normalizeContextLine(value) {
  return String(value || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .toLowerCase()
    .slice(0, 180);
}

function extractKeywords(text) {
  const value = String(text || "").toLowerCase();
  const keywords = new Set();
  for (const [keyword, pattern] of RETRIEVAL_KEYWORD_RULES) {
    if (pattern.test(value)) keywords.add(keyword);
  }
  for (const token of value.split(/[^\p{L}\p{N}_-]+/u)) {
    if (token.length >= 3 && token.length <= 24) keywords.add(token);
  }
  return [...keywords].slice(0, 12);
}

function scoreMemory(text, keywords, chat, groupId) {
  const value = String(text || "").toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (value.includes(keyword)) score += keyword.length > 3 ? 2 : 1;
  }
  if (score <= 0) return 0;
  if (groupId && String(chat.group) === groupId) score += 1;
  const ageMs = wallAgeMs(chat.ts);
  if (ageMs < 24 * 60 * 60 * 1000) score += 1;
  return score;
}

function deriveMood(groupId) {
  const recent = recentGroupChat(groupId, 20);
  const speakers = new Set(recent.map(function(item) {
    const match = item.content.match(/uid=([^: ]+)/);
    return match ? match[1] : "";
  }).filter(Boolean));
  if (speakers.size >= 5) return "（群聊氛围活跃，多人参与）";
  if (speakers.size >= 3) return "（群聊氛围正常）";
  return "（群聊比较安静）";
}

export function interjectionToleranceFactor(groupProfile) {
  const tolerance = groupProfile?.interjectionTolerance || "normal";
  if (tolerance === "low") return 0.5;
  if (tolerance === "high") return 1.3;
  return 1;
}
