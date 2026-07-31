import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { CFG } from "../../config.mjs";

const CACHE_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1000;
const SENSITIVE_DESCRIPTION_RE =
  /(sk-[A-Za-z0-9_-]{12,}|api[_ -]?key|token|secret|password|密码|身份证|\b1[3-9]\d{9}\b)/i;

let cachePath = CFG.imageMemeCacheFile;
let loadedPath = "";
let store = emptyStore();
let saveTimer = null;

export async function perceptualImageHash(buffer) {
  const pixels = await sharp(buffer)
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let bits = 0n;
  let bitIndex = 0n;
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const offset = row * 9 + column;
      if (pixels[offset] > pixels[offset + 1]) bits |= 1n << bitIndex;
      bitIndex++;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function findCachedImageDescription(fingerprint, options = {}) {
  const key = normalizeFingerprint(fingerprint);
  if (!key) return "";
  const cache = loadStore();
  const now = Number(options.now || Date.now());
  const maxDistance = Number(options.maxDistance ?? 5);
  let best = null;
  for (const entry of cache.entries) {
    if (now - Number(entry.lastSeenAt || 0) > MAX_AGE_MS) continue;
    const distance = hammingDistance(key, entry.fingerprint);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) best = { entry, distance };
  }
  if (!best) return "";
  best.entry.lastSeenAt = now;
  best.entry.hits = Number(best.entry.hits || 0) + 1;
  scheduleSave();
  return String(best.entry.description || "");
}

export function rememberImageDescription(fingerprint, description, options = {}) {
  const key = normalizeFingerprint(fingerprint);
  const text = normalizeDescription(description);
  if (!key || !text || SENSITIVE_DESCRIPTION_RE.test(text)) return false;
  const cache = loadStore();
  const now = Number(options.now || Date.now());
  const existing = cache.entries.find(entry => hammingDistance(key, entry.fingerprint) <= 2);
  if (existing) {
    existing.description = text;
    existing.lastSeenAt = now;
    existing.hits = Number(existing.hits || 0) + 1;
  } else {
    cache.entries.push({
      fingerprint: key,
      description: text,
      firstSeenAt: now,
      lastSeenAt: now,
      hits: 1,
    });
  }
  pruneStore(cache, now);
  scheduleSave();
  return true;
}

export function flushImageContextCacheSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const cache = loadStore();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

export function setImageContextCachePath(filePath) {
  cachePath = String(filePath || CFG.imageMemeCacheFile);
  loadedPath = "";
  store = emptyStore();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function resetImageContextCacheForTest() {
  loadedPath = cachePath;
  store = emptyStore();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function getImageContextCacheStatus(options = {}) {
  const cache = loadStore();
  pruneStore(cache, Number(options.now || Date.now()));
  return {
    enabled: true,
    entries: cache.entries.length,
    hits: cache.entries.reduce((total, entry) => total + Number(entry.hits || 0), 0),
    storesImages: false,
    storesChatText: false,
  };
}

function loadStore() {
  if (loadedPath === cachePath) return store;
  loadedPath = cachePath;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    store = {
      version: CACHE_VERSION,
      entries: Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) : [],
    };
  } catch {
    store = emptyStore();
  }
  pruneStore(store, Date.now());
  return store;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flushImageContextCacheSync();
    } catch {
      // Cache failure must never block a reply.
    }
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

function pruneStore(cache, now) {
  cache.entries = cache.entries
    .filter(entry => now - Number(entry.lastSeenAt || 0) <= MAX_AGE_MS)
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
    .slice(0, MAX_ENTRIES);
}

function normalizeEntry(entry) {
  const fingerprint = normalizeFingerprint(entry?.fingerprint);
  const description = normalizeDescription(entry?.description);
  if (!fingerprint || !description || SENSITIVE_DESCRIPTION_RE.test(description)) return null;
  return {
    fingerprint,
    description,
    firstSeenAt: Number(entry.firstSeenAt || 0),
    lastSeenAt: Number(entry.lastSeenAt || 0),
    hits: Math.max(1, Number(entry.hits || 1)),
  };
}

function normalizeFingerprint(value) {
  const key = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(key) ? key : "";
}

function normalizeDescription(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 600);
}

function hammingDistance(left, right) {
  const a = normalizeFingerprint(left);
  const b = normalizeFingerprint(right);
  if (!a || !b) return 64;
  let value = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count++;
  }
  return count;
}

function emptyStore() {
  return { version: CACHE_VERSION, entries: [] };
}
