import crypto from "node:crypto";
import { CFG } from "../../config.mjs";
import { log, logE } from "../../logger.mjs";
import { fetchSafeBuffer } from "../../safe-url.mjs";
import {
  getStickerCaptureQuota,
  getStickerSettings,
  markCapturedStickerCloudResult,
  markStickerCaptureRejected,
  removeStickerEntry,
  upsertCapturedSticker,
} from "./catalog-store.mjs";
import { addBufferToCloudFavorites } from "./cloud-favorites.mjs";
import { createCandidateQueue } from "./candidate-queue.mjs";
import { classifyStickerCandidate } from "./image-classifier.mjs";
import { resolveStickerAllowedGroups } from "./scope.mjs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SAME_SENDER_WINDOW_MS = 10 * 60 * 1000;

let queue = createQueue();
let initialized = false;
const recentSenderImages = new Map();
const status = {
  observed: 0,
  rejected: 0,
  promoted: 0,
  lastError: "",
  lastCaptureAt: null,
};

export function initializeStickerCapture() {
  if (initialized) return getStickerCaptureStatus();
  initialized = true;
  if (queue.status().stopped) queue = createQueue();
  return getStickerCaptureStatus();
}

export function stopStickerCapture() {
  queue.stop();
  recentSenderImages.clear();
  initialized = false;
}

export function observeGroupStickerCandidates(ctx = {}, options = {}) {
  if (!initialized) initializeStickerCapture();
  const settings = options.settings || getStickerSettings();
  const groupId = Number(ctx.group_id || ctx.groupId || 0);
  const userId = Number(ctx.user_id || ctx.userId || 0);
  const gate = captureGate(settings, groupId, userId);
  if (gate) return { accepted: 0, reason: gate };

  const images = normalizeIncomingImages(ctx);
  const accepted = images.reduce((total, image) =>
    total + enqueueIncomingImage({ groupId, userId, image }, options), 0);
  status.observed += accepted;
  return { accepted, reason: accepted ? "" : "no_candidate" };
}

export async function processCandidate(candidate, options = {}) {
  const settings = options.settings || getStickerSettings();
  try {
    const prepared = await prepareCandidate(candidate, options);
    if (prepared.rejected) return prepared.result;
    return await promotePreparedCandidate(prepared, candidate, settings, options);
  } catch (error) {
    status.lastError = error.message;
    logE("group sticker capture failed:", error.message);
    return { ok: false, promoted: false, reason: error.message };
  }
}

async function prepareCandidate(candidate, options) {
  const download = options.download || fetchCandidateImage;
  const image = await download(candidate.image.url);
  const classify = options.classify || classifyStickerCandidate;
  const analysis = await classify(image, options.classifierOptions || {});
  if (!["sticker", "unknown"].includes(analysis.classification)) {
    reject("not_sticker");
    return {
      rejected: true,
      result: { ok: false, rejected: true, reason: "not_sticker", analysis },
    };
  }
  const observed = upsertCapturedSticker({
    url: candidate.image.url,
    ...analysis,
  }, {
    groupId: candidate.groupId,
    senderId: candidate.userId,
    now: options.now,
  });
  return { rejected: false, image, analysis, observed };
}

async function promotePreparedCandidate(prepared, candidate, settings, options) {
  const { image, observed } = prepared;
  const quota = getStickerCaptureQuota({ now: options.now });
  const quotaResult = enforceCaptureQuota(observed, quota);
  if (quotaResult) return quotaResult;
  const skipReason = promotionSkipReason(observed.entry, settings, quota);
  if (skipReason) return { ok: true, promoted: false, reason: skipReason, entry: observed.entry };

  const addCloud = options.addCloud || addBufferToCloudFavorites;
  const cloud = await addCloud({
    buffer: image.buffer,
    mimeType: image.mimeType,
    url: candidate.image.url,
  }, options.cloudOptions || {});
  return finalizePromotion(observed.entry, cloud, candidate, options);
}

function enforceCaptureQuota(observed, quota) {
  if (!observed.added || quota.capturedTotal <= quota.catalogLimit) return null;
  removeStickerEntry(observed.entry.id);
  reject("catalog_limit");
  return { ok: false, rejected: true, reason: "catalog_limit" };
}

function promotionSkipReason(entry, settings, quota) {
  if (!shouldPromote(entry, settings)) return "promotion_threshold";
  if (quota.dailyLimit <= 0 || quota.todayAdded >= quota.dailyLimit) return "daily_limit";
  if (entry.captureState === "active") return "already_active";
  return "";
}

function finalizePromotion(entry, cloud, candidate, options) {
  const updated = markCapturedStickerCloudResult(entry.id, cloud, { now: options.now });
  if (!cloud.ok) {
    status.lastError = cloud.error;
    return { ok: false, promoted: false, reason: cloud.error, entry: updated };
  }
  status.promoted++;
  status.lastCaptureAt = new Date(Number(options.now || Date.now())).toISOString();
  status.lastError = "";
  log("group sticker promoted to QQ cloud:", entry.id, "group", candidate.groupId);
  return { ok: true, promoted: true, entry: updated };
}

export function getStickerCaptureStatus() {
  return {
    initialized,
    ...status,
    queue: queue.status(),
    quota: getStickerCaptureQuota(),
  };
}

export function resetStickerCaptureForTest() {
  stopStickerCapture();
  queue = createQueue();
  status.observed = 0;
  status.rejected = 0;
  status.promoted = 0;
  status.lastError = "";
  status.lastCaptureAt = null;
}

function shouldPromote(entry, settings) {
  if (settings.captureMode !== "auto") return false;
  if (entry.classification === "sticker" && entry.confidence >= settings.captureMinConfidence) return true;
  return entry.distinctSenderCount >= settings.captureMinDistinctSenders &&
    entry.confidence >= Math.min(0.65, settings.captureMinConfidence);
}

function normalizeIncomingImages(ctx) {
  if (Array.isArray(ctx.imageSegments)) return ctx.imageSegments;
  return (Array.isArray(ctx.images) ? ctx.images : []).map(url => ({ type: "image", url }));
}

function captureGate(settings, groupId, userId) {
  if (settings.captureMode === "off") return "capture_off";
  if (!resolveStickerAllowedGroups(settings).includes(groupId)) return "group_not_allowed";
  if (!userId || userId === CFG.selfUin) return "self_or_unknown";
  return "";
}

function enqueueIncomingImage(candidate, options) {
  if (candidate.image.isFlash || candidate.image.type === "flash" || !candidate.image.url) return 0;
  if (isRecentSameSender(candidate.groupId, candidate.userId, candidate.image.url, options.now)) return 0;
  const key = crypto.createHash("sha256").update(candidate.image.url).digest("hex");
  return queue.enqueue(key, async () => {
    await processCandidate(candidate, options);
  }).accepted ? 1 : 0;
}

function isRecentSameSender(groupId, userId, url, nowValue) {
  const now = Number(nowValue || Date.now());
  const key = groupId + ":" + userId + ":" + crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
  const previous = recentSenderImages.get(key) || 0;
  recentSenderImages.set(key, now);
  for (const [item, timestamp] of recentSenderImages) {
    if (now - timestamp > SAME_SENDER_WINDOW_MS) recentSenderImages.delete(item);
  }
  return now - previous < SAME_SENDER_WINDOW_MS;
}

async function fetchCandidateImage(url) {
  const data = await fetchSafeBuffer(url, {
    timeoutMs: 12000,
    maxBytes: MAX_IMAGE_BYTES,
  });
  if (!data) throw new Error("候选图片下载失败或被安全策略拦截");
  return data;
}

function reject(reason) {
  status.rejected++;
  status.lastError = reason;
  markStickerCaptureRejected();
}

function createQueue() {
  return createCandidateQueue({ maxSize: CFG.stickerCaptureQueueLimit });
}
