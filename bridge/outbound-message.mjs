import { CFG } from "./config.mjs";
import { log, logE } from "./logger.mjs";

const DEFAULT_MAX_LEN = 900;
const HARD_MAX_LEN = 1200;
const SEND_DELAY_MS = 300;
const DEFAULT_SEND_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 700;

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

async function sendGroupPayload(payload, label = "sendMsg", options = {}) {
  return await sendPayloadWithRetry({
    url: CFG.napcatApi + "/send_group_msg",
    payload,
    label,
    options,
  });
}

async function sendPrivatePayload(payload, label = "sendPrivateMsg", options = {}) {
  return await sendPayloadWithRetry({
    url: CFG.napcatApi + "/send_private_msg",
    payload,
    label,
    options,
  });
}

export async function sendTextToGroup({
  groupId,
  text,
  replyTo,
  maxLen = DEFAULT_MAX_LEN,
  maxAttempts = DEFAULT_SEND_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  const chunks = splitLongText(text, maxLen);
  if (!chunks.length) return null;
  if (chunks.length > 1) log("sendMsg splitCount:", chunks.length, "len:", normalizeOutboundText(text).length);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const message = [{ type: "text", data: { text: chunks[i] } }];
    if (i === 0 && replyTo) message.unshift({ type: "reply", data: { id: replyTo } });
    const result = await sendGroupPayload(
      { group_id: groupId, message },
      "sendMsg",
      { maxAttempts, retryDelayMs }
    );
    results.push(result);
    if (!isOutboundPayloadSuccessful(result)) break;
    if (i < chunks.length - 1) await sleep(SEND_DELAY_MS);
  }
  return results.length <= 1 ? (results[0] || null) : results;
}

export async function sendTextToPrivate({
  userId,
  text,
  maxLen = DEFAULT_MAX_LEN,
  maxAttempts = DEFAULT_SEND_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  const chunks = splitLongText(text, maxLen);
  if (!chunks.length) return null;
  if (chunks.length > 1) log("sendPrivateMsg splitCount:", chunks.length, "len:", normalizeOutboundText(text).length);

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const message = [{ type: "text", data: { text: chunks[i] } }];
    const result = await sendPrivatePayload(
      { user_id: userId, message },
      "sendPrivateMsg",
      { maxAttempts, retryDelayMs }
    );
    results.push(result);
    if (!isOutboundPayloadSuccessful(result)) break;
    if (i < chunks.length - 1) await sleep(SEND_DELAY_MS);
  }
  return results.length <= 1 ? (results[0] || null) : results;
}

export async function sendGroupMessagePayload(payload, label, options = {}) {
  return sendGroupPayload(payload, label, options);
}

export async function sendPrivateMessagePayload(payload, label, options = {}) {
  return sendPrivatePayload(payload, label, options);
}

export function isOutboundPayloadSuccessful(result) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "ok") return true;
  const retcode = result.retcode;
  if (retcode !== null && retcode !== undefined && retcode !== "" && Number(retcode) === 0) return true;
  return Boolean(result.data?.message_id || result.message_id);
}

async function sendPayloadWithRetry({ url, payload, label, options }) {
  const attempts = Math.max(1, Math.min(3, Number(options.maxAttempts || DEFAULT_SEND_ATTEMPTS)));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  let lastResult = null;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await sendPayloadOnce(url, payload);
    lastResult = outcome.result;
    lastError = outcome.error;
    if (outcome.ok) {
      log(label + ":", lastResult?.status || lastResult?.retcode || "ok");
      return lastResult;
    }
    if (attempt < attempts) {
      log(label + " retry:", attempt + 1, "of", attempts);
      await sleep(retryDelayMs);
    }
  }
  logE(label + " failed:", lastError || "unknown error");
  return lastResult;
}

async function sendPayloadOnce(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    return {
      ok: isOutboundPayloadSuccessful(result),
      result,
      error: String(result?.message || result?.wording || "NapCat 返回失败"),
    };
  } catch (error) {
    return { ok: false, result: null, error: error.message };
  }
}
