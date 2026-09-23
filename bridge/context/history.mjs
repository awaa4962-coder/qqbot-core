import { users, groupChats } from "../storage.mjs";
import { buildHistoricalSourceFrame, fmtMsg } from "./messages.mjs";
import { wallAgeMs } from "../runtime-clock.mjs";
import { selectionSource } from "./conversation-selection.mjs";

export function recentGroupChat(group_id, limit = 30, options = {}) {
  const gid = String(group_id);
  const msgs = groupChats[gid] || [];
  const recent = msgs.filter(message => !isExcludedMessage(message, options)).slice(-limit);
  return recent.map(message => {
    const frame = buildHistoricalSourceFrame(message, "[群聊背景，仅供理解，不要复述]");
    return { role: fmtMsg(message).role, content: frame.content, contextAtomic: true, contextOriginalFrame: true,
      contextSources: [selectionSource(message, "group", "recent", 0, frame.clipped)] };
  });
}

export function crossGroupCtx(uid, currentGroup) {
  const user = users[uid];
  if (!user || !user.chats) return [];
  const current = String(currentGroup);
  const otherChats = user.chats.filter(function(chat) { return chat.group !== current; }).slice(-5);
  return otherChats.map(function(chat) {
    const frame = buildHistoricalSourceFrame(chat, "[在" + safeGroupLabel(chat.group) + "群的历史原话，仅供理解]");
    return { role: "user", content: frame.content, contextAtomic: true, contextOriginalFrame: true,
      contextSources: [selectionSource(chat, "memory", "cross_group", 0, frame.clipped)] };
  });
}

export function recentHistory(uid, limit = 30) {
  const user = users[uid];
  if (!user || !user.chats) return [];
  const msgs = user.chats.slice(-limit);
  return msgs.map(function(message) {
    const frame = buildHistoricalSourceFrame(message, "[在" + safeGroupLabel(message.group) + "群的历史原话]");
    return { role: "user", content: frame.content, contextAtomic: true, contextOriginalFrame: true,
      contextSources: [selectionSource(message, "memory", "recent", 0, frame.clipped)] };
  });
}

export function recentHistoryWeighted(uid, currentGroup, options = {}) {
  const user = users[uid];
  if (!user || !user.chats) return { history: [], mood: "" };
  const current = String(currentGroup);
  const weighted = collectWeightedUserChats(user.chats, current, options);
  const history = weighted.map(function(item) {
    const message = { ...item.msg, uid: String(uid) };
    const frame = buildHistoricalSourceFrame(message, "[当前发言人的近期发言]");
    return { role: "user", content: frame.content, contextAtomic: true, contextOriginalFrame: true,
      contextSources: [selectionSource(message, "memory", "recent", 0, frame.clipped)] };
  });
  return {
    history,
    mood: deriveGroupMood(current),
    sources: history.map(item => item.contextSources[0]),
  };
}

function collectWeightedUserChats(chats, currentGroup, options) {
  const now = Date.now();
  const weighted = [];
  for (let i = chats.length - 1; i >= 0; i--) {
    const chat = chats[i];
    if (String(chat.group) !== currentGroup) continue;
    if (isExcludedMessage(chat, options)) continue;
    const ageMs = wallAgeMs(chat.ts, now);
    if (!Number.isFinite(ageMs)) continue;
    const ageHours = ageMs / 3600000;
    if (ageHours > 12) break;
    weighted.push({ msg: chat, weight: weightRecentChat(ageHours) });
  }
  weighted.sort(function(a, b) { return b.weight - a.weight; });
  const top = weighted.slice(0, options.limit || 15);
  top.sort(function(a, b) { return a.msg.ts - b.msg.ts; });
  return top;
}

function isExcludedMessage(message, options = {}) {
  if (message?.memoryCommand) return true;
  if (hasExcludedMessageId(message, options.excludeMessageIds)) return true;
  const currentMessageId = normalizeMessageId(options.currentMessageId);
  if (currentMessageId && normalizeMessageId(message?.messageId) === currentMessageId) return true;
  const currentText = String(options.currentText || "").replace(/\s+/g, " ").trim();
  if (!currentMessageId || !currentText) return false;
  const messageText = String(message?.text || "").replace(/\s+/g, " ").trim();
  return messageText === currentText && wallAgeMs(message?.ts) < 15000;
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

function safeGroupLabel(value) {
  const group = value === undefined || value === null ? "" : String(value);
  return /^\d{1,20}$/.test(group) ? group : "unknown";
}

function weightRecentChat(ageHours) {
  if (ageHours < 0.5) return 5;
  if (ageHours < 1) return 4;
  if (ageHours < 4) return 3;
  return 1;
}

function deriveGroupMood(groupId) {
  const recentInGroup = groupChats[groupId] || [];
  const recentMsgs = recentInGroup.slice(-20);
  const speakers = new Set(recentMsgs.map(function(message) { return message.uid; }));
  if (speakers.size >= 5) return "（群聊氛围活跃，多人参与）";
  if (speakers.size >= 3) return "（群聊氛围正常）";
  return "（群聊比较安静）";
}
