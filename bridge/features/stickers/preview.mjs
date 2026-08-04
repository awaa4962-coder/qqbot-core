import { fetchSafeBuffer } from "../../safe-url.mjs";
import { getStickerEntry } from "./catalog-store.mjs";
import {
  isExpiringNapCatMediaUrl,
  refreshNapCatMediaUrl,
} from "./napcat-adapter.mjs";

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function loadStickerPreview(id, options = {}) {
  try {
    const entry = await (options.getEntry || getStickerEntry)(String(id || ""));
    if (!entry?.url) return { ok: false, reason: "not_found" };

    const attempted = new Set();
    const first = await loadFirstAvailable(
      await buildPreviewCandidates(entry.url, options),
      entry.url,
      attempted,
      options
    );
    if (first) return first;

    if (isExpiringNapCatMediaUrl(entry.url)) {
      const retry = await loadFirstAvailable(
        await buildPreviewCandidates(entry.url, { ...options, forceRefresh: true }),
        entry.url,
        attempted,
        options
      );
      if (retry) return retry;
    }
    return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

async function buildPreviewCandidates(url, options) {
  if (!isExpiringNapCatMediaUrl(url)) return [url];
  const refresh = options.refreshUrl || refreshNapCatMediaUrl;
  const refreshed = await refresh(url, {
    type: "group",
    forceRefresh: options.forceRefresh === true,
    ...(options.napcatOptions || {}),
  });
  return refreshed?.ok && refreshed.url !== url ? [refreshed.url, url] : [url];
}

async function loadFirstAvailable(candidates, sourceUrl, attempted, options) {
  const fetchImage = options.fetchImage || fetchSafeBuffer;
  for (const candidate of candidates) {
    if (attempted.has(candidate)) continue;
    attempted.add(candidate);
    let data;
    try {
      data = await fetchImage(candidate, {
        timeoutMs: Number(options.timeoutMs || 12000),
        maxBytes: Number(options.maxBytes || MAX_PREVIEW_BYTES),
      });
    } catch {
      continue;
    }
    const mimeType = normalizeImageType(data?.mimeType);
    if (!data?.buffer || !mimeType) continue;
    return {
      ok: true,
      buffer: data.buffer,
      mimeType,
      refreshed: candidate !== sourceUrl,
    };
  }
  return null;
}

function normalizeImageType(value) {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(mimeType) ? mimeType : "";
}
