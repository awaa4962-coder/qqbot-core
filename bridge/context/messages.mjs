import { CFG } from "../config.mjs";

export function safeContextText(value, maxLen = 500) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return (raw || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
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

export function buildCurrentInput(userName, userMsg, userId) {
  return "[当前输入]\n" +
    speakerLabel(userName, userId) + "\n" +
    "message=" + safeContextText(userMsg, 1000) + "\n" +
    "reply_target=当前发言人";
}

export function buildQuotedMessageBlock(replyText, speaker = "unknown") {
  return "[被回复消息]\n" +
    speakerLabel(speaker) + "\n" +
    "message=" + safeContextText(replyText, 500);
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
