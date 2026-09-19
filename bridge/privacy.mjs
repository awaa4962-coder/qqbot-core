const REDACTED = "[REDACTED]";
const SECRET_FIELD = /((?<![\w])(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization|密码|密钥)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|(?:Bearer\s+)?[^\s,;，；}\]&]+)/gi;
const ATTRIBUTION_PREFIX = /\b(?:uid|qq|user_?id|group_?id|message_?id|reply_?to_?message_?id|turn_?id)["']?\s*[:=]\s*["']?$/i;

// Pure text boundary: keep attribution IDs, never retain credential field values.
export function redactSensitiveText(text) {
  let value = String(text ?? "");
  value = value.replace(SECRET_FIELD, (_match, prefix, secret) => {
    const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
    return prefix + quote + REDACTED + quote;
  });
  value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer " + REDACTED);
  return value.replace(/\b(?:1[3-9]\d{9}|\d{17}[0-9xX]|\d{15})\b/g, (match, offset, source) => {
    return ATTRIBUTION_PREFIX.test(source.slice(Math.max(0, offset - 64), offset)) ? match : REDACTED;
  });
}

export function containsSensitiveText(text) {
  return redactSensitiveText(text) !== String(text ?? "");
}
