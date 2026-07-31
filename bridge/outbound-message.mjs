import { CFG } from "./config.mjs";
import { log, logE } from "./logger.mjs";

const DEFAULT_MAX_LEN = 900;
const HARD_MAX_LEN = 1200;
const SEND_DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeOutboundText(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function boundedMaxLen(maxLen) {
  const n = Number(maxLen) || DEFAULT_MAX_LEN;
  return Math.min(Math.max(1, n), HARD_MAX_LEN);
}

function findSplitIndex(text, maxLen) {
  const sample = text.slice(0, maxLen + 1);
  const delimiters = ["\n\n", "\n", "。", "？", "！", "?", "!", "；", ";", "，", ",", " "];
  for (const delimiter of delimiters) {
    const idx = sample.lastIndexOf(delimiter);
    if (idx >= Math.floor(maxLen * 0.35)) return idx + delimiter.length;
  }
  return maxLen;
}

export function splitLongText(text, maxLen = DEFAULT_MAX_LEN) {
  const limit = boundedMaxLen(maxLen);
  let rest = normalizeOutboundText(text);
  if (!rest) return [];
  const chunks = [];

  while (rest.length > limit) {
    const cut = findSplitIndex(rest, limit);
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendGroupPayload(payload, label = "sendMsg") {
  try {
    const r = await fetch(CFG.napcatApi + "/send_group_msg", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    log(label + ":", d?.status || d?.retcode || "ok");
    return d;
  } catch (e) {
    logE(label + " error:", e.message);
    return null;
  }
}

async function sendPrivatePayload(payload, label = "sendPrivateMsg") {
  try {
    const r = await fetch(CFG.napcatApi + "/send_private_msg", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    log(label + ":", d?.status || d?.retcode || "ok");
    return d;
  } catch (e) {
    logE(label + " error:", e.message);
    return null;
  }
}

export async function sendTextToGroup({ groupId, text, replyTo, maxLen = DEFAULT_MAX_LEN }) {
  const chunks = splitLongText(text, maxLen);
  if (!chunks.length) return null;
  if (chunks.length > 1) log("sendMsg splitCount:", chunks.length, "len:", normalizeOutboundText(text).length);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const message = [{ type: "text", data: { text: chunks[i] } }];
    if (i === 0 && replyTo) message.unshift({ type: "reply", data: { id: replyTo } });
    results.push(await sendGroupPayload({ group_id: groupId, message }));
    if (i < chunks.length - 1) await sleep(SEND_DELAY_MS);
  }
  return results.length <= 1 ? (results[0] || null) : results;
}

export async function sendTextToPrivate({ userId, text, maxLen = DEFAULT_MAX_LEN }) {
  const chunks = splitLongText(text, maxLen);
  if (!chunks.length) return null;
  if (chunks.length > 1) log("sendPrivateMsg splitCount:", chunks.length, "len:", normalizeOutboundText(text).length);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const message = [{ type: "text", data: { text: chunks[i] } }];
    results.push(await sendPrivatePayload({ user_id: userId, message }));
    if (i < chunks.length - 1) await sleep(SEND_DELAY_MS);
  }
  return results.length <= 1 ? (results[0] || null) : results;
}

export async function sendGroupMessagePayload(payload, label) {
  return sendGroupPayload(payload, label);
}

export async function sendPrivateMessagePayload(payload, label) {
  return sendPrivatePayload(payload, label);
}
