import { containsSensitiveText } from "../privacy.mjs";
import { authorizedSearchQuery, permitsPublicSearch, publicSearchCancelled } from "./policy.mjs";

const PRIVATE_TEXT = /\[redacted\]|<redacted>|\bredacted\b|\u5df2\u8131\u654f|\u5df2\u9690\u85cf|\u79c1\u804a\u8bb0\u5f55|\u804a\u5929\u8bb0\u5f55|\u5bc6\u7801|\u5bc6\u94a5|\u8eab\u4efd\u8bc1|\u624b\u673a\u53f7|\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/i;
const ID_FIELD = /(?:\b(?:uid|qq|user[_ -]?id|group[_ -]?id|message[_ -]?id|current[_ -]?message[_ -]?id|reply[_ -]?to(?:[_ -]?message)?[_ -]?id|turn[_ -]?id|session(?:[_ -]?id)?|conversation(?:[_ -]?id)?)\b|QQ\u53f7|\u7fa4\u53f7|\u4f1a\u8bdd\u6807\u8bc6)["']?\s*[:=\uff1a]\s*["']?[\w-]+|(?:\b(?:uid|qq|user[_ -]?id|group[_ -]?id|message[_ -]?id|session[_ -]?id)\b|QQ\u53f7|\u7fa4\u53f7|\u4f1a\u8bdd\u6807\u8bc6)\s*\d+/i;
const PRIVATE_REF = /\b(?:cf|src|att|draft|rem|mem)_[a-f0-9]{16,}\b/i;
const SECRET_FIELD = /\b(?:credentials?|access[_ -]?key|private[_ -]?key|cookie|set[_ -]?cookie|auth|jwt)["']?\s*[:=]\s*\S+/i;
const SCOPE_ID = /^(?:userId|groupId|messageId|currentMessageId|replyToMessageId|turnId|sessionId|conversationId|selfUin|botId)$/i;

// Lexical minimum only: private-tool provenance must also be guarded by the backend.
export function publicTextSafe(value, scope = {}, protectedValues = []) {
  if (typeof value !== "string" || /[\p{Cf}\p{Cc}]/u.test(value.replace(/[\r\n\t]/g, ""))) return false;
  const texts = decodedForms(value);
  if (!texts) return false;
  const bound = Object.entries(scope || {}).filter(([key]) => SCOPE_ID.test(key.replace(/[_ -]/g, ""))).map(([, item]) => item);
  const protectedText = [...bound, ...protectedValues].filter(item => typeof item === "string" || typeof item === "number")
    .map(item => normalize(String(item))).filter(Boolean);
  return texts.every(text => !containsSensitiveText(text) && !PRIVATE_TEXT.test(text) && !ID_FIELD.test(text) && !PRIVATE_REF.test(text) && !SECRET_FIELD.test(text) &&
    !/[\p{Cf}\p{Cc}]/u.test(text.replace(/[\r\n\t]/g, "")) &&
    !protectedText.some(item => normalize(text).includes(item)));
}

export function publicToolsAllowed(userMessage, task, { autonomous, scope } = {}) {
  if (!["group_chat", "private_chat"].includes(task) || typeof userMessage !== "string" ||
      !userMessage.trim() || userMessage.length > 1000 || !publicTextSafe(userMessage, scope)) return false;
  const message = userMessage.normalize("NFKC").toLowerCase();
  if (publicSearchCancelled(message)) return false;
  return autonomous === true || permitsPublicSearch(userMessage, task);
}

export function authorizePublicQuery(query, userMessage, task, { autonomous, scope } = {}) {
  if (!publicToolsAllowed(userMessage, task, { autonomous, scope }) || typeof query !== "string") return "";
  const clean = query.trim();
  if (clean.length < 2 || clean.length > 160 || !publicTextSafe(clean, scope)) return "";
  return autonomous === true ? clean : authorizedSearchQuery(query, userMessage, task);
}

function normalize(value) { return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }

function decodedForms(value) {
  const texts = [value.normalize("NFKC")];
  for (let pass = 0; pass < 3; pass++) {
    const previous = texts.at(-1);
    if (!/%[\da-f]{2}/i.test(previous)) return texts;
    try { texts.push(decodeURIComponent(previous).normalize("NFKC")); } catch { return null; }
  }
  return /%[\da-f]{2}/i.test(texts.at(-1)) ? null : texts;
}
