

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const INTERJECTION_PREFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/i,
  /(?:api[_-]?key|token|secret|password|passwd|密码|密钥)\s*[:=]/i,
  /\b\d{15,18}[0-9x]\b/i,
  /\b1[3-9]\d{9}\b/,
];

export function userGroupKey(groupId, uid) {
  return String(groupId || "0") + ":" + String(uid || "0");
}
