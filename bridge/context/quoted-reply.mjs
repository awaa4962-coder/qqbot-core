import { summaryPrivacy } from "../group-summary/state.mjs";
import { getMemoryPrivacyGeneration } from "../memory-profile/generation.mjs";
import { memoryCorrectionSnapshot } from "../memory-profile/notes.mjs";

export function validateQuotedReply(ctx, reply, options = {}) {
  if ((options.privacyGeneration ?? getMemoryPrivacyGeneration()) !== getMemoryPrivacyGeneration()) return unavailable("privacy_changed");
  const source = reply.source || {};
  const evidence = sourceEvidence(source, options.now ?? Date.now());
  if (!evidence) return unavailable("quote_source_unknown");
  const mismatch = sourceScopeReason(ctx, source, evidence);
  if (mismatch) return unavailable(mismatch);
  const reason = erasureReason(evidence.userId, evidence.at, options);
  if (reason) return unavailable(reason);
  const correction = correctionReason(evidence, options);
  if (correction) return unavailable(correction);
  if (!String(reply.text || "").trim() && !reply.images?.length) return unavailable("quote_content_empty");
  return evidence;
}

function correctionReason(source, options) {
  try {
    const value = (options.readCorrections || memoryCorrectionSnapshot)({ userId: source.userId, groupId: source.groupId });
    if (!(value?.excludedMessageIds instanceof Set)) return "quote_memory_unavailable";
    return value.excludedMessageIds.has(source.messageId) ? "quote_superseded" : "";
  } catch { return "quote_memory_unavailable"; }
}

function sourceScopeReason(ctx, source, evidence) {
  if (ctx.message_type !== "group" || source.messageType !== "group" || evidence.groupId !== identifier(ctx.group_id)) return "quote_scope_mismatch";
  if (evidence.messageId !== identifier(ctx.replyData?.id, true) || evidence.messageId === identifier(ctx.message_id, true)) return "quote_message_mismatch";
  return "";
}

function sourceEvidence(source, now) {
  const messageId = identifier(source.messageId, true);
  const groupId = identifier(source.groupId);
  const userId = identifier(source.userId);
  const at = sourceTime(source.time);
  if (source.senderUserId !== undefined && identifier(source.senderUserId) !== userId) return null;
  if (!messageId || !groupId || !userId || !at || at > now + 300000) return null;
  return { state: "verified", source: "onebot", messageId, groupId, userId, at };
}

function erasureReason(userId, at, options) {
  try {
    const privacy = (options.readPrivacy || summaryPrivacy)();
    if (!privacy?.users || typeof privacy.users !== "object" || Array.isArray(privacy.users)) return "quote_privacy_unavailable";
    const cutoff = privacy.users[userId];
    if (cutoff === undefined) return "";
    if (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff <= 0) return "quote_privacy_unavailable";
    return at <= cutoff ? "quote_forgotten" : "";
  } catch { return "quote_privacy_unavailable"; }
}

function identifier(value, signed = false) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return "";
  const text = String(value);
  return (signed ? /^-?\d{1,20}$/ : /^[1-9]\d{0,19}$/).test(text) ? text : "";
}

function sourceTime(value) {
  if (!["string", "number"].includes(typeof value)) return 0;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function unavailable(reason) { return { state: "unavailable", reason }; }
