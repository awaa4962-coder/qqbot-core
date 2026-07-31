import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../../config.mjs";
import {
  createEmptyStickerCatalog,
  normalizeStickerEntry,
  normalizeStickerSettings,
  normalizeStickerTags,
  normalizeNumberList,
  publicStickerEntry,
} from "./schema.mjs";

let catalogPath = CFG.stickerCatalogFile;
let loadedPath = "";
let catalog = null;

export function getStickerCatalog() {
  ensureLoaded();
  return catalog;
}

export function getStickerSettings() {
  return { ...getStickerCatalog().settings, allowedGroups: [...getStickerCatalog().settings.allowedGroups] };
}

export function updateStickerSettings(value = {}) {
  const store = getStickerCatalog();
  store.settings = normalizeStickerSettings(value, store.settings);
  persistCatalog();
  return getStickerSettings();
}

export function upsertFavoriteStickers(items, options = {}) {
  const store = getStickerCatalog();
  const now = Number(options.now || Date.now());
  let added = 0;
  let refreshed = 0;

  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeFavorite(raw);
    if (!item.url) continue;
    const existing = findMatchingFavorite(store.entries, item);
    if (existing) {
      Object.assign(existing, compactDefined({
        url: item.url,
        emojiId: item.emojiId,
        packageId: item.packageId,
        key: item.key,
        resId: item.resId,
        md5: item.md5,
        summary: item.summary,
      }));
      if (existing.source === "group-capture") existing.captureState = "active";
      existing.lastSeenAt = now;
      existing.lastError = "";
      refreshed++;
      continue;
    }
    store.entries.push(normalizeStickerEntry({
      id: createStickerId(item.url, store.entries),
      source: "qq-favorite",
      url: item.url,
      emojiId: item.emojiId,
      packageId: item.packageId,
      key: item.key,
      resId: item.resId,
      md5: item.md5,
      summary: item.summary,
      captureState: "favorite",
      firstSeenAt: now,
      lastSeenAt: now,
    }));
    added++;
  }

  store.lastSyncedAt = new Date(now).toISOString();
  store.stats.syncs++;
  persistCatalog();
  return { added, refreshed, total: store.entries.length };
}

export function upsertCapturedSticker(value = {}, options = {}) {
  const store = getStickerCatalog();
  const now = Number(options.now || Date.now());
  const fingerprint = String(value.fingerprint || "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(fingerprint) || !value.url) {
    throw new Error("采集候选缺少图片指纹或地址");
  }

  const senderHash = hashSender(store, options.senderId);
  const existing = findNearestFingerprint(store.entries, fingerprint, 5);
  if (existing) {
    updateObservedEntry(existing, value, options, senderHash, now);
    store.stats.captureDuplicates++;
    persistCatalog();
    return { entry: cloneEntry(existing), added: false, duplicate: true };
  }

  const entry = createCapturedEntry(value, options, senderHash, fingerprint, store.entries, now);
  store.entries.push(entry);
  store.stats.captured++;
  persistCatalog();
  return { entry: cloneEntry(entry), added: true, duplicate: false };
}

export function markCapturedStickerCloudResult(id, result = {}, options = {}) {
  const store = getStickerCatalog();
  const entry = store.entries.find(item => item.id === String(id || ""));
  if (!entry || entry.source !== "group-capture") return null;
  const now = Number(options.now || Date.now());
  if (result.ok) {
    applyCloudSuccess(store, entry, result, now);
  } else {
    applyCloudFailure(store, entry, result);
  }
  persistCatalog();
  return cloneEntry(entry);
}

export function markStickerCaptureRejected() {
  const store = getStickerCatalog();
  store.stats.captureRejected++;
  persistCatalog();
}

export function getStickerCaptureQuota(options = {}) {
  const store = getStickerCatalog();
  const now = Number(options.now || Date.now());
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const captured = store.entries.filter(entry => entry.source === "group-capture");
  return {
    todayAdded: captured.filter(entry => entry.cloudAddedAt >= dayStart.getTime()).length,
    capturedTotal: captured.length,
    dailyLimit: store.settings.captureDailyLimit,
    catalogLimit: store.settings.captureCatalogLimit,
  };
}

export function retireStaleCapturedStickers(options = {}) {
  const store = getStickerCatalog();
  const now = Number(options.now || Date.now());
  const maxAgeMs = Number(options.maxAgeMs || 90 * 24 * 60 * 60 * 1000);
  let retired = 0;
  for (const entry of store.entries) {
    if (entry.source !== "group-capture" || entry.captureState !== "active") continue;
    if (now - Number(entry.lastSentAt || entry.lastObservedAt || entry.firstSeenAt) < maxAgeMs) continue;
    if (entry.sendCount > 2) continue;
    entry.enabled = false;
    entry.captureState = "retired";
    retired++;
  }
  if (retired) persistCatalog();
  return { retired };
}

export function removeStickerEntry(id, options = {}) {
  const store = getStickerCatalog();
  const index = store.entries.findIndex(entry => entry.id === String(id || ""));
  if (index < 0) return null;
  const [removed] = store.entries.splice(index, 1);
  if (options.persist !== false) persistCatalog();
  return cloneEntry(removed);
}

export function listPendingStickerAnalysis(options = {}) {
  const now = Number(options.now || Date.now());
  const limit = Math.max(1, Math.min(50, Number(options.limit || 6)));
  return getStickerCatalog().entries
    .filter(entry => entry.enabled && !entry.indexed && (!entry.nextAnalysisAt || entry.nextAnalysisAt <= now))
    .slice(0, limit)
    .map(entry => ({ ...entry, tags: [...entry.tags], allowedGroups: [...entry.allowedGroups] }));
}

export function listSelectableStickers(options = {}) {
  const groupId = Number(options.groupId || 0);
  return getStickerCatalog().entries
    .filter(entry => entry.enabled && entry.indexed && entry.description)
    .filter(entry => entry.source !== "group-capture" || entry.captureState === "active")
    .filter(entry => !groupId || !entry.allowedGroups.length || entry.allowedGroups.includes(groupId))
    .map(entry => ({ ...entry, tags: [...entry.tags], allowedGroups: [...entry.allowedGroups] }));
}

export function getStickerEntry(id) {
  const entry = getStickerCatalog().entries.find(item => item.id === String(id || ""));
  return entry ? { ...entry, tags: [...entry.tags], allowedGroups: [...entry.allowedGroups] } : null;
}

export function findStickerByFingerprint(fingerprint, excludeId = "") {
  const value = String(fingerprint || "").trim();
  if (!value) return null;
  const entry = getStickerCatalog().entries.find(item =>
    item.id !== excludeId && item.fingerprint === value && item.indexed
  );
  return entry ? { ...entry, tags: [...entry.tags], allowedGroups: [...entry.allowedGroups] } : null;
}

export function applyStickerAnalysis(id, analysis = {}, options = {}) {
  const store = getStickerCatalog();
  const index = store.entries.findIndex(entry => entry.id === String(id || ""));
  if (index < 0) return null;
  const now = Number(options.now || Date.now());
  const target = store.entries[index];
  const fingerprint = String(analysis.fingerprint || "").trim();
  const duplicateIndex = fingerprint
    ? store.entries.findIndex(entry => entry.id !== target.id && entry.fingerprint === fingerprint)
    : -1;

  if (duplicateIndex >= 0) {
    const duplicate = mergeAnalyzedDuplicate(store.entries[duplicateIndex], target, now);
    store.entries.splice(index, 1);
    store.stats.reused++;
    persistCatalog();
    return { ...duplicate, reused: true };
  }

  target.fingerprint = fingerprint;
  target.description = String(analysis.description || "").trim().slice(0, 240);
  target.tags = normalizeStickerTags(analysis.tags);
  target.indexed = Boolean(target.description);
  target.analyzedAt = now;
  target.analysisAttempts = 0;
  target.nextAnalysisAt = 0;
  target.lastError = "";
  if (target.indexed) store.stats.analyzed++;
  persistCatalog();
  return { ...target, reused: false };
}

export function markStickerAnalysisFailure(id, error, options = {}) {
  const entry = getStickerCatalog().entries.find(item => item.id === String(id || ""));
  if (!entry) return null;
  const now = Number(options.now || Date.now());
  entry.analysisAttempts = Math.min(100, Number(entry.analysisAttempts || 0) + 1);
  entry.nextAnalysisAt = now + Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.min(6, entry.analysisAttempts - 1)));
  entry.lastError = String(error?.message || error || "分析失败").slice(0, 160);
  persistCatalog();
  return { ...entry };
}

export function updateStickerEntry(id, patch = {}) {
  const entry = getStickerCatalog().entries.find(item => item.id === String(id || ""));
  if (!entry) throw new Error("表情不存在");
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    entry.description = String(patch.description || "").trim().slice(0, 240);
    entry.indexed = Boolean(entry.description);
    entry.manual = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
    entry.tags = normalizeStickerTags(patch.tags);
    entry.manual = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) entry.enabled = patch.enabled !== false;
  if (Object.prototype.hasOwnProperty.call(patch, "allowedGroups")) {
    entry.allowedGroups = normalizeNumberList(patch.allowedGroups);
  }
  persistCatalog();
  return publicStickerEntry(entry);
}

export function recordStickerSend(id, success, options = {}) {
  const store = getStickerCatalog();
  const entry = store.entries.find(item => item.id === String(id || ""));
  if (success) {
    store.stats.sent++;
    if (entry) {
      entry.sendCount++;
      entry.lastSentAt = Number(options.now || Date.now());
      entry.lastError = "";
    }
  } else {
    store.stats.sendFailures++;
    if (entry) entry.lastError = String(options.error || "发送失败").slice(0, 160);
  }
  persistCatalog();
}

export function buildStickerCatalogSnapshot() {
  const store = getStickerCatalog();
  const entries = store.entries.map(publicStickerEntry);
  return {
    schemaVersion: store.schemaVersion,
    revision: store.revision,
    updatedAt: store.updatedAt,
    lastSyncedAt: store.lastSyncedAt,
    settings: getStickerSettings(),
    counts: {
      total: entries.length,
      enabled: entries.filter(entry => entry.enabled).length,
      indexed: entries.filter(entry => entry.indexed).length,
      pending: entries.filter(entry => !entry.indexed).length,
      captured: entries.filter(entry => entry.source === "group-capture").length,
      activeCaptured: entries.filter(entry => entry.source === "group-capture" && entry.captureState === "active").length,
      candidates: entries.filter(entry => entry.source === "group-capture" && entry.captureState === "candidate").length,
    },
    stats: { ...store.stats },
    entries,
  };
}

export function flushStickerCatalogSync() {
  if (catalog) persistCatalog();
}

export function setStickerCatalogPath(file) {
  catalogPath = path.resolve(file);
  loadedPath = "";
  catalog = null;
}

export function resetStickerCatalogForTest() {
  loadedPath = "";
  catalog = null;
}

function ensureLoaded() {
  if (catalog && loadedPath === catalogPath) return;
  loadedPath = catalogPath;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog = normalizeCatalog(parsed);
  } catch {
    catalog = createEmptyStickerCatalog(defaultSettings());
  }
}

function normalizeCatalog(value) {
  const source = value && typeof value === "object" ? value : {};
  const empty = createEmptyStickerCatalog(defaultSettings());
  return {
    schemaVersion: 2,
    revision: Math.max(1, Number(source.revision || 1)),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
    lastSyncedAt: typeof source.lastSyncedAt === "string" ? source.lastSyncedAt : null,
    identitySalt: normalizeIdentitySalt(source.identitySalt),
    settings: normalizeStickerSettings(source.settings, defaultSettings()),
    entries: (Array.isArray(source.entries) ? source.entries : [])
      .map(normalizeStickerEntry)
      .filter(entry => entry.id && entry.url),
    stats: {
      ...empty.stats,
      ...(source.stats && typeof source.stats === "object" ? source.stats : {}),
    },
  };
}

function defaultSettings() {
  return {
    mode: CFG.stickerMode,
    groupEnabled: CFG.stickerEnabled,
    privateEnabled: CFG.stickerPrivateEnabled,
    chance: CFG.stickerChance,
    strongChance: CFG.stickerStrongChance,
    cooldownMs: CFG.stickerCooldownMs,
    allowedGroups: CFG.stickerGroupWhitelist,
    captureMode: CFG.stickerCaptureMode,
    captureDailyLimit: CFG.stickerCaptureDailyLimit,
    captureCatalogLimit: CFG.stickerCaptureCatalogLimit,
    captureMinConfidence: CFG.stickerCaptureMinConfidence,
    captureMinDistinctSenders: CFG.stickerCaptureMinDistinctSenders,
  };
}

function persistCatalog() {
  const store = getStickerCatalog();
  store.revision = Math.max(1, Number(store.revision || 0) + 1);
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const tmp = catalogPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, catalogPath);
}

function normalizeFavorite(value) {
  if (typeof value === "string") return { url: value };
  const source = value && typeof value === "object" ? value : {};
  return {
    url: firstText(source.url, source.file),
    emojiId: firstText(source.emoji_id, source.emojiId),
    packageId: firstText(source.emoji_package_id, source.packageId),
    key: firstText(source.key),
    resId: firstText(source.resId, source.res_id, source.resourceId),
    md5: firstText(source.md5, source.fileMd5).toLowerCase(),
    summary: firstText(source.summary, source.desc),
  };
}

function updateObservedEntry(existing, value, options, senderHash, now) {
  existing.url = String(value.url);
  existing.lastSeenAt = now;
  existing.lastObservedAt = now;
  existing.seenCount = Number(existing.seenCount || 1) + 1;
  existing.confidence = Math.max(Number(existing.confidence || 0), Number(value.confidence || 0));
  existing.sourceGroups = mergeNumber(existing.sourceGroups, options.groupId, 20);
  addSenderHash(existing, senderHash);
  if (existing.source !== "group-capture") return;
  existing.classification = firstText(value.classification, existing.classification);
  if (!existing.description && value.description) existing.description = String(value.description).slice(0, 240);
  if (!existing.tags.length && value.tags) existing.tags = normalizeStickerTags(value.tags);
}

function addSenderHash(entry, senderHash) {
  if (!senderHash || entry.senderHashes.includes(senderHash)) return;
  entry.senderHashes.push(senderHash);
  entry.distinctSenderCount = entry.senderHashes.length;
}

function createCapturedEntry(value, options, senderHash, fingerprint, entries, now) {
  return normalizeStickerEntry({
    id: createStickerId(fingerprint + ":" + value.url, entries),
    source: "group-capture",
    url: value.url,
    fingerprint,
    description: value.description,
    tags: value.tags,
    indexed: Boolean(value.description),
    captureState: "candidate",
    classification: value.classification,
    confidence: value.confidence,
    seenCount: 1,
    distinctSenderCount: senderHash ? 1 : 0,
    senderHashes: senderHash ? [senderHash] : [],
    sourceGroups: options.groupId ? [Number(options.groupId)] : [],
    firstSeenAt: now,
    lastSeenAt: now,
    lastObservedAt: now,
  });
}

function applyCloudSuccess(store, entry, result, now) {
  Object.assign(entry, compactDefined({
    url: result.item?.url,
    emojiId: result.item?.emojiId,
    packageId: result.item?.packageId,
    key: result.item?.key,
    resId: result.item?.resId,
    md5: firstText(result.item?.md5, result.md5),
    summary: result.item?.summary,
  }));
  entry.captureState = "active";
  entry.cloudManaged = result.created === true;
  entry.cloudAddedAt = entry.cloudManaged ? now : 0;
  entry.lastError = "";
  if (entry.cloudManaged) store.stats.cloudAdded++;
}

function applyCloudFailure(store, entry, result) {
  entry.captureState = "cloud-failed";
  entry.lastError = firstText(result.error, "添加 QQ 云收藏失败").slice(0, 160);
  store.stats.cloudFailures++;
}

function mergeAnalyzedDuplicate(duplicate, target, now) {
  duplicate.url = target.url;
  duplicate.lastSeenAt = Math.max(duplicate.lastSeenAt, target.lastSeenAt, now);
  for (const key of ["emojiId", "packageId", "key", "summary", "resId", "md5"]) {
    duplicate[key] = firstText(target[key], duplicate[key]);
  }
  duplicate.seenCount = Number(duplicate.seenCount || 1) + Number(target.seenCount || 1);
  duplicate.sourceGroups = [...new Set(duplicate.sourceGroups.concat(target.sourceGroups))].slice(0, 20);
  duplicate.senderHashes = [...new Set(duplicate.senderHashes.concat(target.senderHashes))].slice(0, 80);
  duplicate.distinctSenderCount = duplicate.senderHashes.length;
  if (target.captureState === "active") duplicate.captureState = "active";
  duplicate.cloudManaged = duplicate.cloudManaged || target.cloudManaged;
  return duplicate;
}

function findMatchingFavorite(entries, item) {
  return entries.find(entry =>
    (item.resId && entry.resId === item.resId) ||
    (item.md5 && entry.md5 === item.md5) ||
    entry.url === item.url
  );
}

function findNearestFingerprint(entries, fingerprint, maxDistance) {
  let nearest = null;
  for (const entry of entries) {
    if (!entry.fingerprint) continue;
    const distance = hammingDistance(fingerprint, entry.fingerprint);
    if (distance > maxDistance) continue;
    if (!nearest || distance < nearest.distance) nearest = { entry, distance };
  }
  return nearest?.entry || null;
}

function hammingDistance(left, right) {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) return 64;
  let value = BigInt("0x" + left) ^ BigInt("0x" + right);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count++;
  }
  return count;
}

function normalizeIdentitySalt(value) {
  const salt = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(salt) ? salt : crypto.randomBytes(32).toString("hex");
}

function hashSender(store, senderId) {
  if (!senderId) return "";
  if (!store.identitySalt) store.identitySalt = normalizeIdentitySalt("");
  return crypto.createHmac("sha256", store.identitySalt)
    .update(String(senderId))
    .digest("hex")
    .slice(0, 24);
}

function mergeNumber(values, number, limit) {
  const candidate = Number(number || 0);
  return [...new Set((Array.isArray(values) ? values : []).concat(
    Number.isSafeInteger(candidate) && candidate > 0 ? [candidate] : []
  ))].slice(0, limit);
}

function cloneEntry(entry) {
  return {
    ...entry,
    tags: [...entry.tags],
    allowedGroups: [...entry.allowedGroups],
    senderHashes: [...entry.senderHashes],
    sourceGroups: [...entry.sourceGroups],
  };
}

function createStickerId(url, entries) {
  const base = "sticker_" + crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
  if (!entries.some(entry => entry.id === base)) return base;
  let suffix = 2;
  while (entries.some(entry => entry.id === base + "_" + suffix)) suffix++;
  return base + "_" + suffix;
}

function compactDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item));
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
