import { randomBytes } from "node:crypto";
import { assertChatRunCurrent, chatRunSignal, currentChatScope } from "../cognition/chat-run.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../memory-profile/generation.mjs";
import { redactSensitiveText } from "../privacy.mjs";

const MAX_ATTACHMENTS = 3;
const MAX_TTL_MS = 10 * 60 * 1000;
const TURN_MS = 90000;

export function createAttachmentReferenceSession(files, options = {}) {
  const scope = snapshotScope(options.scope ?? currentChatScope());
  const messageId = normalizeMessageId(options.messageId);
  const bound = Boolean(scope && messageId && messageMatchesScope(options.scope, messageId));
  const now = options.now ?? Date.now;
  const parentCheck = options.assertCurrent;
  const signal = options.signal;
  const parentSignal = chatRunSignal();
  const privacy = getMemoryPrivacyGeneration();
  const preferences = getUserMemoryGeneration(scope?.userId);
  const startedAt = now();
  const ttl = boundedTtl(options.ttlMs);
  const expiresAt = startedAt + ttl;
  const turnDeadline = startedAt + TURN_MS;
  const references = new Map();
  let invalid;

  function reject(reason) {
    invalid ||= Object.assign(new Error(reason), { code: "CHAT_TOOL_STOPPED" });
    throw invalid;
  }

  function assertPrivacyAndCancellation() {
    if (privacy !== getMemoryPrivacyGeneration()) reject("privacy_changed");
    if (scope && preferences !== getUserMemoryGeneration(scope.userId)) reject("preferences_changed");
    if (signal?.aborted || parentSignal?.aborted) reject("reply_superseded");
  }

  function assertCurrent() {
    if (invalid) throw invalid;
    try {
      assertChatRunCurrent();
      parentCheck?.();
      assertPrivacyAndCancellation();
      // No attachment authority means no attachment-specific identity or deadline to enforce.
      if (!references.size) return;
      const identity = identityRejection(scope, messageId, parentSignal);
      if (identity) reject(identity);
      const lifetime = lifetimeRejection(startedAt, now(), expiresAt, turnDeadline);
      if (lifetime) reject(lifetime);
    } catch (error) {
      invalid ||= error;
      throw invalid;
    }
  }

  if (bound) {
    for (const input of (Array.isArray(files) ? files.slice(0, MAX_ATTACHMENTS) : [])) {
      const file = snapshotFile(input);
      if (!file) continue;
      const attachment_ref = "att_" + randomBytes(16).toString("hex");
      const name = safeFileName(file.name);
      const descriptor = Object.freeze({ attachment_ref, name, type: fileType(name), bytes: file.size ?? null, status: "not_read" });
      references.set(attachment_ref, { file, descriptor });
    }
  }

  return Object.freeze({
    initialReferences() {
      assertCurrent();
      return [...references.values()].map(item => ({ ...item.descriptor }));
    },
    resolve(attachment_ref) {
      assertCurrent();
      const item = typeof attachment_ref === "string" ? references.get(attachment_ref) : undefined;
      if (!item) return { status: "denied", reason: "reference_not_in_turn" };
      return { status: "ok", file: { ...item.file }, descriptor: { ...item.descriptor },
        binding: { scope: { ...scope }, messageId, expiresAt } };
    },
    assertCurrent,
    expiry() { return references.size ? expiresAt : null; },
  });
}

function boundedTtl(value) {
  if (value === undefined) return MAX_TTL_MS;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(MAX_TTL_MS, Math.floor(value)) : 0;
}

function validTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - MAX_TTL_MS;
}

function lifetimeRejection(startedAt, time, expiresAt, turnDeadline) {
  if (!validTime(startedAt) || !validTime(time) || time < startedAt || time >= expiresAt) return "reply_expired";
  return time >= turnDeadline ? "tool_deadline" : "";
}

function messageMatchesScope(scope, messageId) {
  return [scope?.currentMessageId, scope?.messageId].every(value => value === undefined || normalizeMessageId(value) === messageId);
}

function identityRejection(scope, messageId, parentSignal) {
  const current = currentChatScope();
  if (!scope || !sameScope(scope, current)) return "permission_changed";
  if (parentSignal !== chatRunSignal()) return "reply_superseded";
  if (messageId && normalizeMessageId(current.currentMessageId) !== messageId) return "reply_superseded";
  return "";
}

function numericId(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return "";
  const text = String(value);
  return /^[1-9]\d{0,19}$/.test(text) ? text : "";
}

function normalizeMessageId(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return "";
  if (Object.is(value, -0)) return "";
  const text = String(value);
  return /^-?(?:0|[1-9]\d{0,19})$/.test(text) && text !== "-0" ? text : "";
}

function snapshotScope(value) {
  if (!value || !["group", "private"].includes(value.surface)) return null;
  const userId = numericId(value.userId);
  const groupId = value.surface === "group" ? numericId(value.groupId) : "private";
  if (!userId || !groupId) return null;
  if (value.surface === "private" && ![undefined, null, "private"].includes(value.groupId)) return null;
  return Object.freeze({ surface: value.surface, userId, groupId });
}

function sameScope(scope, current) {
  const active = snapshotScope(current);
  return active && scope.surface === active.surface && scope.userId === active.userId && scope.groupId === active.groupId;
}

function snapshotFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = {};
  // Only own primitive data fields cross this backend boundary; accessors and nested metadata do not.
  for (const key of ["name", "url", "file"]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof field?.value === "string") file[key] = field.value;
  }
  const size = Object.getOwnPropertyDescriptor(value, "size")?.value;
  if (Number.isSafeInteger(size) && size >= 0) file.size = size;
  return file.name || file.url || file.file ? Object.freeze(file) : null;
}

function safeFileName(value) {
  if (typeof value !== "string") return "unnamed";
  let raw = value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "");
  // Decode before checking paths/credentials, so encoded filenames cannot bypass the text boundary.
  for (let pass = 0; pass < 2 && /%[\da-f]{2}/i.test(raw); pass++) {
    try { raw = decodeURIComponent(raw); }
    catch { return "unnamed"; }
  }
  if (/%[\da-f]{2}/i.test(raw)) return "unnamed";
  raw = raw.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "");
  raw = raw.replace(/^[a-z]:[\\/]/i, "");
  if (/(?:\b[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(raw)) return "unnamed";
  // Authentication fields may contain a scheme plus credentials or multiple parameters.
  raw = raw.replace(/\b(?:proxy[-_]?authorization|authorization)["']?\s*[:=]\s*[^\r\n]*/gi, "[REDACTED]")
    .replace(/\b(?:Basic|Bearer)\s+\S+/gi, "[REDACTED]");
  raw = raw.replace(/\b(?:uid|qq|user_?id|group_?id|message_?id|reply_?to_?message_?id|turn_?id)["']?\s*[:=]\s*["']?-?\d{1,20}/gi, "[REDACTED]");
  raw = redactSensitiveText(raw).split(/[?#]/, 1)[0];
  const basename = raw.split(/[\\/]/).at(-1) || "";
  return basename.replace(/\s+/g, " ").trim().slice(0, 120) || "unnamed";
}

function fileType(name) {
  return /\.([a-z\d]{1,12})$/i.exec(name)?.[1].toLowerCase() || "unknown";
}
