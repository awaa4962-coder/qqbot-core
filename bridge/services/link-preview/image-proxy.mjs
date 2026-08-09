import { fetchSafeBuffer } from "../../safe-url.mjs";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
const cache = new Map();

export async function resolvePreviewImage(imageUrl, options = {}) {
  const url = String(imageUrl || "").trim();
  if (!url) return null;
  if (url.startsWith("base64://")) return url;

  const now = Number(options.now || Date.now());
  const cached = readCache(url, now);
  if (cached) return cached;

  const result = await loadImage(url, options);
  if (!isSupportedImage(result)) return null;

  const value = "base64://" + result.buffer.toString("base64");
  cache.set(url, { value, createdAt: now });
  trimCache();
  return value;
}

export function resetPreviewImageCache() {
  cache.clear();
}

function trimCache() {
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function readCache(url, now) {
  const cached = cache.get(url);
  return cached && now - cached.createdAt <= CACHE_TTL_MS ? cached.value : null;
}

async function loadImage(url, options) {
  const loader = options.loader || fetchSafeBuffer;
  try {
    return await loader(url, {
      timeoutMs: options.timeoutMs || 8000,
      maxBytes: options.maxBytes || MAX_IMAGE_BYTES,
    });
  } catch {
    return null;
  }
}

function isSupportedImage(result) {
  return Boolean(result?.buffer) && /^image\/(?:avif|gif|jpeg|png|webp)(?:;|$)/i.test(result.mimeType || "");
}
