import { log, logE } from "../../logger.mjs";
import { chatRunStopReason } from "../../cognition/chat-run.mjs";
import { createStickerPrivacyGuard } from "./privacy.mjs";
import {
  buildStickerCatalogSnapshot,
  flushStickerCatalogSync,
  getStickerEntry,
  recordStickerSend,
} from "./catalog-store.mjs";
import { isDeepStrictEqual } from "node:util";
import { classifyOutboundDelivery } from "../../cognition/outcome.mjs";
import * as stickerPolicy from "./policy.mjs";
import { getStickerSendMaterials, isStickerEntrySendable } from "./schema.mjs";
import { getStickerReplyStatus, normalizeStickerReplyReason, recordStickerReplyStage } from "./reply-status.mjs";

const { evaluateStickerPolicy, recordStickerCooldown } = stickerPolicy;
export { getStickerReplyStatus, resetStickerReplyStatusForTest } from "./reply-status.mjs";
import { selectSticker } from "./selector.mjs";
import { sendStickerDecision } from "./sender.mjs";
import { getStickerCaptureStatus } from "./capture-service.mjs";
import {
  getStickerSyncStatus,
  stopStickerSystem,
  syncStickerFavorites,
} from "./sync-service.mjs";

export {
  analyzePendingStickers,
  analyzeStickerEntry,
  inferStickerTags,
  normalizeAnalysis,
} from "./analyzer.mjs";
export {
  applyStickerAnalysis,
  buildStickerCatalogSnapshot,
  findStickerByFingerprint,
  flushStickerCatalogSync,
  getStickerCatalog,
  getStickerEntry,
  getStickerSettings,
  listPendingStickerAnalysis,
  listSelectableStickers,
  markStickerAnalysisFailure,
  recordStickerSend,
  resetStickerCatalogForTest,
  setStickerCatalogPath,
  updateStickerEntry,
  updateStickerSettings,
  upsertFavoriteStickers,
  upsertCapturedSticker,
  markCapturedStickerCloudResult,
  markStickerCaptureRejected,
  getStickerCaptureQuota,
  retireStaleCapturedStickers,
  retireExhaustedStickerCandidates,
  pruneRetiredCapturedStickers,
  removeStickerEntry,
} from "./catalog-store.mjs";
export {
  addCustomFace,
  deleteCustomFace,
  detectStickerCapabilities,
  fetchFavoriteStickerDetails,
  fetchFavoriteStickers,
  normalizeFavoritePayload,
  postNapCat,
  isExpiringNapCatMediaUrl,
  refreshNapCatMediaUrl,
  resetNapCatRkeyCacheForTest,
  setCustomFaceDescription,
} from "./napcat-adapter.mjs";
export { loadStickerPreview } from "./preview.mjs";
export {
  addBufferToCloudFavorites,
  cleanupTemporaryStickerFiles,
  deleteCapturedCloudFavorite,
  withTemporaryStickerFile,
} from "./cloud-favorites.mjs";
export {
  getStickerCaptureStatus,
  initializeStickerCapture,
  observeGroupStickerCandidates,
  processCandidate,
  resetStickerCaptureForTest,
  stopStickerCapture,
} from "./capture-service.mjs";
export {
  classifyStickerCandidate,
  normalizeClassification,
} from "./image-classifier.mjs";
export { createCandidateQueue } from "./candidate-queue.mjs";
export { evaluateStickerPolicy, recordStickerCooldown, resetStickerPolicyForTest } from "./policy.mjs";
export { resolveStickerAllowedGroups } from "./scope.mjs";
export {
  buildStickerCandidates,
  buildStickerSelectionPrompt,
  parseStickerSelection,
  selectSticker,
} from "./selector.mjs";
export { buildStickerSegment, sendStickerDecision } from "./sender.mjs";
export { isStickerEntrySendable } from "./schema.mjs";
export {
  getStickerSyncStatus,
  initializeStickerSystem,
  refreshStickerCapabilities,
  resetStickerSyncForTest,
  stopStickerSystem,
  syncStickerFavorites,
} from "./sync-service.mjs";

export async function maybeSendStickerAfterReply(context = {}, options = {}) {
  const operation = { context, options, check: createStickerPrivacyGuard(context.userId),
    phase: "policy", sendStarted: false, delivery: null, scopeKey: "" };
  try {
    assertStickerReplyCurrent(operation);
    const policy = evaluateStickerPolicy(context, options.policyOptions);
    if (!policy.ok) return finishStickerReply("skipped",
      { ok: false, stage: "policy", reason: policy.reason }, policy.reasonCode ?? policy.reason);
    operation.scopeKey = policy.scopeKey;
    liveStickerReplyEligibility(operation);
    operation.phase = "selection";
    const decision = await (options.select || selectSticker)(context, guardedStickerSelectorOptions(operation));
    if (decision.action === "send") recordStickerReplyStage("selected", decision.reasonCode ?? decision.reason);
    assertStickerReplyCurrent(operation);
    if (decision.action !== "send") return finishStickerSelection(decision);
    const live = liveStickerReplyEligibility(operation);
    const entry = currentStickerReplyEntry(decision.stickerId, context);
    assertStickerReplyMeaning(decision.sticker, entry);
    if (policy.mode === "shadow" || live.mode === "shadow") {
      log("sticker shadow selection");
      return finishStickerReply("shadow", { ok: true, sent: false, stage: "shadow", decision }, "shadow");
    }
    const sendDecision = { ...decision, sticker: entry };
    const materials = getStickerSendMaterials(entry);
    const senderOptions = guardedStickerSenderOptions(operation, sendDecision, materials);
    assertStickerSendAllowed(operation, sendDecision, materials);
    operation.phase = "send";
    operation.sendStarted = true;
    const outbound = await (options.send || sendStickerDecision)(sendDecision, context, senderOptions) || {};
    operation.delivery = stickerReplyDelivery(outbound);
    // Commit the physical receipt before any live/privacy check can invalidate this turn.
    recordStickerReplyStage(operation.delivery.stage, operation.delivery.reasonCode, operation.delivery.physicalReceipt);
    assertStickerSendAllowed(operation, sendDecision, materials);
    if (outbound.guardStopped === true) throw stickerReplyBlocked("policy_changed");
    return finishStickerDelivery(outbound, sendDecision, operation.delivery);
  } catch (error) {
    return failedStickerReply(operation, error);
  } finally {
    recordStickerReplyPhysicalCooldown(operation);
  }
}

function recordStickerReplyPhysicalCooldown(operation) {
  if (["sent", "partial"].includes(operation.delivery?.physicalReceipt)) {
    recordStickerCooldown(operation.scopeKey);
  }
}

function assertStickerReplyCurrent(operation) {
  operation.check();
  const stopped = chatRunStopReason();
  if (stopped) throw stickerReplyBlocked(stopped, "CHAT_CANCELLED");
  if (operation.options.senderOptions?.signal?.aborted || operation.options.selectorOptions?.signal?.aborted) {
    throw stickerReplyBlocked("task_cancelled", "CHAT_CANCELLED");
  }
}

function stickerReplyBlocked(reason, code = "STICKER_REPLY_BLOCKED") {
  const reasonCode = normalizeStickerReplyReason(reason);
  return Object.assign(new Error(reasonCode), { code, reasonCode });
}

function liveStickerReplyEligibility(operation) {
  assertStickerReplyCurrent(operation);
  // Never reroll the original chance or trust test/snapshot settings at this boundary.
  if (typeof stickerPolicy.checkStickerReplyEligibility !== "function") throw stickerReplyBlocked("policy_guard_unavailable");
  const live = stickerPolicy.checkStickerReplyEligibility(operation.context);
  if (!live?.ok) throw stickerReplyBlocked(live?.reasonCode ?? live?.reason);
  if (!["steady", "shadow"].includes(live.mode)) throw stickerReplyBlocked("sticker_off");
  return live;
}

function guardedStickerSelectorOptions(operation) {
  const original = operation.options.selectorOptions || {};
  return { ...original, assertCurrent: () => {
    liveStickerReplyEligibility(operation);
    original.assertCurrent?.();
    liveStickerReplyEligibility(operation);
  } };
}

function currentStickerReplyEntry(id, context) {
  const entry = getStickerEntry(id);
  if (!isStickerEntrySendable(entry)) throw stickerReplyBlocked("sticker_unavailable");
  if (context.private === true && entry.allowedGroups?.length) throw stickerReplyBlocked("entry_group_only");
  if (context.private !== true && entry.allowedGroups?.length &&
      !entry.allowedGroups.includes(Number(context.groupId))) throw stickerReplyBlocked("group_not_allowed");
  return entry;
}

function assertStickerReplyMeaning(selected, current) {
  const meaning = entry => entry && Object.fromEntries(
    ["id", "source", "description", "tags", "md5", "fingerprint", "resId", "emojiId", "packageId"]
      .map(key => [key, entry[key]]));
  if (!isDeepStrictEqual(meaning(selected), meaning(current))) throw stickerReplyBlocked("sticker_changed");
}

function assertStickerSendAllowed(operation, decision, materials) {
  const live = liveStickerReplyEligibility(operation);
  if (live.mode !== "steady") throw stickerReplyBlocked("shadow_mode");
  const entry = currentStickerReplyEntry(decision.stickerId, operation.context);
  assertStickerReplyMeaning(decision.sticker, entry);
  if (!isDeepStrictEqual(getStickerSendMaterials(entry), materials)) throw stickerReplyBlocked("sticker_changed");
  return entry;
}

function guardedStickerSenderOptions(operation, decision, materials) {
  const original = operation.options.senderOptions || {};
  const ensureAllowed = () => {
    assertStickerSendAllowed(operation, decision, materials);
    const allowed = original.ensureAllowed?.();
    if (allowed === false || typeof allowed === "string" && allowed) {
      throw stickerReplyBlocked(allowed === false ? "policy_changed" : allowed, "CHAT_CANCELLED");
    }
    original.assertCurrent?.();
    const stopped = original.stopReason?.();
    if (stopped) throw stickerReplyBlocked(stopped, "CHAT_CANCELLED");
    return assertStickerSendAllowed(operation, decision, materials);
  };
  return { ...original, ensureAllowed, assertCurrent: ensureAllowed, stopReason: () => {
    try { ensureAllowed(); return ""; }
    catch (error) { return stickerReplyErrorReason(error); }
  } };
}

function stickerReplyDelivery(outbound) {
  const raw = outbound.result;
  const state = raw !== null && raw !== undefined ? classifyOutboundDelivery(raw) : outbound.status;
  const states = { sent: "sent", partial: "partial", unknown: "unknown", failed: "knownfailed", cancelled: "cancelled" };
  let stage = typeof state === "string" && Object.hasOwn(states, state) ? states[state] : "";
  if (!stage && outbound.ok === true) stage = "sent";
  if (!stage && outbound.skipped === true) stage = "skipped";
  const reasonStages = { send_failed: "knownfailed", send_partial: "partial",
    send_unknown: "unknown", send_cancelled: "cancelled" };
  if (!stage) stage = typeof outbound.reasonCode === "string" && Object.hasOwn(reasonStages, outbound.reasonCode)
    ? reasonStages[outbound.reasonCode] : "unknown";
  const fallback = ({ sent: "sent", partial: "send_partial", unknown: "send_unknown",
    knownfailed: "send_failed", cancelled: "send_cancelled", skipped: "no_match" })[stage];
  return { stage, reasonCode: normalizeStickerReplyReason(outbound.reasonCode ?? fallback),
    physicalReceipt: ["sent", "partial", "unknown"].includes(stage) ? stage : "none" };
}

function finishStickerDelivery(outbound, decision, delivery) {
  const result = { ok: delivery.stage === "sent", sent: stickerReplySent(delivery.physicalReceipt),
    stage: delivery.stage === "sent" ? "sent" : "send", reasonCode: delivery.reasonCode,
    physicalReceipt: delivery.physicalReceipt, decision };
  if (delivery.stage === "sent" || delivery.stage === "knownfailed") {
    recordStickerSend(decision.stickerId, delivery.stage === "sent", { error: outbound.error });
  }
  if (delivery.stage === "knownfailed") {
    syncStickerFavorites({ analyze: false }).catch(() => logE("sticker refresh after send failure"));
    return { ...result, reason: outbound.error };
  }
  if (delivery.stage === "sent") {
    log("sticker sent");
  }
  return result;
}

function stickerReplySent(physicalReceipt) {
  return physicalReceipt === "unknown" ? null : ["sent", "partial"].includes(physicalReceipt);
}

function finishStickerSelection(decision) {
  const reason = normalizeStickerReplyReason(decision.reasonCode ?? decision.reason);
  const stage = ["selection_invalid", "selection_failed"].includes(reason) ? "knownfailed" : "skipped";
  return finishStickerReply(stage, { ok: false, stage: "selection", reason: decision.reason, decision }, reason);
}

function finishStickerReply(stage, result, reasonCode, physicalReceipt = "none") {
  const safeReason = normalizeStickerReplyReason(reasonCode);
  recordStickerReplyStage(stage, safeReason, physicalReceipt);
  return { ...result, sent: stickerReplySent(physicalReceipt), reasonCode: safeReason, physicalReceipt };
}

function stickerReplyErrorReason(error) {
  if (error?.code === "STICKER_PRIVACY_CHANGED") return "privacy_changed";
  if (error?.reasonCode !== undefined) return normalizeStickerReplyReason(error.reasonCode);
  if (error?.name === "AbortError") return "task_cancelled";
  if (error?.code === "CHAT_CANCELLED") {
    const reason = normalizeStickerReplyReason(error.message);
    return reason === "unknown_reason" ? "task_cancelled" : reason;
  }
  return "unknown_reason";
}

function failedStickerReply(operation, error) {
  const fault = error || {};
  const reasonCode = stickerReplyErrorReason(error);
  const blocked = ["STICKER_REPLY_BLOCKED", "STICKER_PRIVACY_CHANGED", "CHAT_CANCELLED"].includes(fault.code) ||
    fault.name === "AbortError";
  const stage = blocked ? operation.delivery || fault.code !== "STICKER_REPLY_BLOCKED" ? "cancelled" : "skipped"
    : operation.sendStarted && !operation.delivery ? "unknown" : "knownfailed";
  const physicalReceipt = operation.delivery?.physicalReceipt || (stage === "unknown" ? "unknown" : "none");
  const reason = blocked ? reasonCode : stage === "unknown" ? "send_unknown"
    : operation.phase === "selection" ? "selection_failed" : "reply_failed";
  logE("sticker reply isolated failure:", reason);
  return finishStickerReply(stage, { ok: false, stage: blocked ? "cancelled" : "error",
    reason: fault.message }, reason, physicalReceipt);
}

export async function simulateStickerSelection(context = {}, options = {}) {
  return await (options.select || selectSticker)(context, options.selectorOptions);
}

export function getStickerRuntimeStatus() {
  const snapshot = buildStickerCatalogSnapshot();
  const sync = getStickerSyncStatus();
  const degradedReasons = [];
  if (snapshot.available === false) degradedReasons.push("catalog_unavailable");
  if (snapshot.counts.pending > 0 && Number(sync.lastAnalysis?.failed || 0) > 0) {
    degradedReasons.push("analysis_failures");
  }
  if (sync.supported === false) degradedReasons.push("napcat_sync_unavailable");
  const health = snapshot.settings.mode === "off"
    ? "disabled"
    : degradedReasons.length ? "degraded" : "ready";
  return {
    enabled: snapshot.settings.mode !== "off",
    health,
    degradedReasons,
    mode: snapshot.settings.mode,
    counts: snapshot.counts,
    stats: snapshot.stats,
    sync,
    capture: getStickerCaptureStatus(),
    replyStatus: getStickerReplyStatus(),
    storesImages: false,
  };
}

export function shutdownStickerSystem() {
  stopStickerSystem();
  flushStickerCatalogSync();
}
