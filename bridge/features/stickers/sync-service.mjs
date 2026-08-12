import { CFG } from "../../config.mjs";
import { log, logE } from "../../logger.mjs";
import { analyzePendingStickers } from "./analyzer.mjs";
import {
  retireStaleCapturedStickers,
  retireExhaustedStickerCandidates,
  pruneRetiredCapturedStickers,
  upsertFavoriteStickers,
} from "./catalog-store.mjs";
import {
  detectStickerCapabilities,
  fetchFavoriteStickerDetails,
  fetchFavoriteStickers,
} from "./napcat-adapter.mjs";
import {
  cleanupTemporaryStickerFiles,
} from "./cloud-favorites.mjs";
import {
  getStickerCaptureStatus,
  initializeStickerCapture,
  stopStickerCapture,
} from "./capture-service.mjs";

let syncPromise = null;
let initialTimer = null;
let syncTimer = null;
let analysisTimer = null;
const status = {
  initialized: false,
  syncing: false,
  supported: null,
  lastSyncAt: null,
  lastError: "",
  lastResult: null,
  lastAnalysis: null,
  capabilities: null,
};

export async function syncStickerFavorites(options = {}) {
  if (syncPromise) return syncPromise;
  syncPromise = runSync(options).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

export function initializeStickerSystem(options = {}) {
  if (status.initialized || !CFG.stickerEnabled) return getStickerSyncStatus();
  status.initialized = true;
  initializeStickerCapture();
  cleanupTemporaryStickerFiles();
  const initialDelay = Number(options.initialDelayMs ?? 3000);
  initialTimer = setTimeout(() => {
    syncStickerFavorites().catch(error => logE("sticker initial sync failed:", error.message));
  }, Math.max(0, initialDelay));
  initialTimer.unref?.();
  syncTimer = setInterval(() => {
    syncStickerFavorites().catch(error => logE("sticker scheduled sync failed:", error.message));
  }, CFG.stickerSyncIntervalMs);
  syncTimer.unref?.();
  analysisTimer = setInterval(() => {
    runScheduledAnalysis().catch(error => logE("sticker analysis schedule failed:", error.message));
  }, 5 * 60 * 1000);
  analysisTimer.unref?.();
  detectCapabilities(options).catch(error => logE("sticker capability detection failed:", error.message));
  const exhausted = retireExhaustedStickerCandidates();
  const pruned = pruneRetiredCapturedStickers();
  if (exhausted.retired || pruned.removed) {
    log("sticker stale candidates cleaned:", exhausted.retired, "retired,", pruned.removed, "removed");
  }
  retireStaleCapturedStickers();
  return getStickerSyncStatus();
}

export function stopStickerSystem() {
  clearTimeout(initialTimer);
  clearTimeout(syncTimer);
  clearTimeout(analysisTimer);
  initialTimer = null;
  syncTimer = null;
  analysisTimer = null;
  status.initialized = false;
  stopStickerCapture();
}

export function getStickerSyncStatus() {
  return {
    ...status,
    lastResult: status.lastResult ? { ...status.lastResult } : null,
    capabilities: status.capabilities ? {
      ...status.capabilities,
      version: { ...status.capabilities.version },
    } : null,
    capture: getStickerCaptureStatus(),
  };
}

export async function refreshStickerCapabilities(options = {}) {
  return await detectCapabilities(options);
}

export function resetStickerSyncForTest() {
  stopStickerSystem();
  status.syncing = false;
  status.supported = null;
  status.lastSyncAt = null;
  status.lastError = "";
  status.lastResult = null;
  status.lastAnalysis = null;
  status.capabilities = null;
  syncPromise = null;
}

async function runSync(options) {
  status.syncing = true;
  const fetchFavorites = options.fetchFavorites || fetchBestFavoriteSource;
  try {
    const remote = await fetchFavorites({ count: options.count || CFG.stickerFetchCount });
    if (!remote.ok) {
      status.supported = false;
      status.lastError = remote.error || "收藏同步失败";
      return { ok: false, error: status.lastError, items: 0 };
    }
    const merged = upsertFavoriteStickers(remote.items, { now: options.now });
    const analysis = options.analyze === false
      ? { requested: 0, analyzed: 0, reused: 0, failed: 0 }
      : await analyzePendingStickers({
        limit: options.analysisLimit || 4,
        ...(options.analyzerOptions || {}),
      });
    const result = {
      ok: true,
      items: remote.items.length,
      ...merged,
      analysis,
    };
    status.supported = true;
    status.lastSyncAt = new Date(Number(options.now || Date.now())).toISOString();
    status.lastError = "";
    status.lastResult = result;
    status.lastAnalysis = { ...analysis, at: new Date(Number(options.now || Date.now())).toISOString() };
    log("sticker favorites synced:", remote.items.length, "items,", merged.added, "new");
    return result;
  } catch (error) {
    status.lastError = error.message;
    logE("sticker sync failed:", error.message);
    return { ok: false, error: error.message, items: 0 };
  } finally {
    status.syncing = false;
  }
}

async function runScheduledAnalysis() {
  const analysis = await analyzePendingStickers({ limit: 4 });
  status.lastAnalysis = { ...analysis, at: new Date().toISOString() };
  return analysis;
}

async function fetchBestFavoriteSource(options = {}) {
  const detailed = await fetchFavoriteStickerDetails(options);
  if (detailed.ok) return detailed;
  return await fetchFavoriteStickers(options);
}

async function detectCapabilities(options = {}) {
  status.capabilities = await (options.detectCapabilities || detectStickerCapabilities)({
    timeoutMs: options.capabilityTimeoutMs || 10000,
  });
  return status.capabilities;
}
