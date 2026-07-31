import { log, logE } from "../../logger.mjs";
import {
  buildStickerCatalogSnapshot,
  flushStickerCatalogSync,
  recordStickerSend,
} from "./catalog-store.mjs";
import { evaluateStickerPolicy, recordStickerCooldown } from "./policy.mjs";
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
  setCustomFaceDescription,
} from "./napcat-adapter.mjs";
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
export {
  getStickerSyncStatus,
  initializeStickerSystem,
  refreshStickerCapabilities,
  resetStickerSyncForTest,
  stopStickerSystem,
  syncStickerFavorites,
} from "./sync-service.mjs";

export async function maybeSendStickerAfterReply(context = {}, options = {}) {
  try {
    const policy = evaluateStickerPolicy(context, options.policyOptions);
    if (!policy.ok) return { ok: false, stage: "policy", reason: policy.reason };
    const decision = await (options.select || selectSticker)(context, options.selectorOptions);
    if (decision.action !== "send") {
      return { ok: false, stage: "selection", reason: decision.reason, decision };
    }
    if (policy.mode === "shadow") {
      log("sticker shadow selection:", decision.stickerId);
      return { ok: true, sent: false, stage: "shadow", decision };
    }
    const outbound = await (options.send || sendStickerDecision)(decision, context, options.senderOptions);
    recordStickerSend(decision.stickerId, outbound.ok, { error: outbound.error });
    if (!outbound.ok) {
      syncStickerFavorites({ analyze: false }).catch(error => logE("sticker refresh after send failure:", error.message));
      return { ok: false, sent: false, stage: "send", reason: outbound.error, decision };
    }
    recordStickerCooldown(policy.scopeKey);
    log("sticker sent:", decision.stickerId, context.private ? "private" : "group");
    return { ok: true, sent: true, stage: "sent", decision };
  } catch (error) {
    logE("sticker reply isolated failure:", error.message);
    return { ok: false, sent: false, stage: "error", reason: error.message };
  }
}

export async function simulateStickerSelection(context = {}, options = {}) {
  return await (options.select || selectSticker)(context, options.selectorOptions);
}

export function getStickerRuntimeStatus() {
  const snapshot = buildStickerCatalogSnapshot();
  return {
    enabled: snapshot.settings.mode !== "off",
    mode: snapshot.settings.mode,
    counts: snapshot.counts,
    stats: snapshot.stats,
    sync: getStickerSyncStatus(),
    capture: getStickerCaptureStatus(),
    storesImages: false,
  };
}

export function shutdownStickerSystem() {
  stopStickerSystem();
  flushStickerCatalogSync();
}
