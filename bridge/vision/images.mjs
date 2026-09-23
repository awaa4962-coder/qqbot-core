import { createHash } from "node:crypto";
import sharp from "sharp";
import { fetchSafeBuffer, validateSafeUrl } from "../safe-url.mjs";

export const VISION_IMAGE_LIMITS = Object.freeze({
  maxImages: 3,
  maxUrlLength: 8192,
  maxSourceBytes: 10 * 1024 * 1024,
  maxInputPixels: 40_000_000,
  maxDimension: 2048,
  jpegQuality: 85,
  maxNormalizedBytes: 1.5 * 1024 * 1024,
  maxTotalNormalizedBytes: 4.5 * 1024 * 1024,
  timeoutMs: 10000,
});

const LIMITS = VISION_IMAGE_LIMITS;
const RASTER_FORMATS = new Set(["jpeg", "png", "webp", "gif", "heif", "avif", "tiff"]);
const DECODE_OPTIONS = Object.freeze({
  page: 0,
  pages: 1,
  animated: false,
  limitInputPixels: LIMITS.maxInputPixels,
  failOn: "warning",
  sequentialRead: true,
});

/**
 * Nonempty trimmed strings are deduplicated before selecting three requests.
 * Invalid/unsafe URLs consume their selected slot; extras are never fetched.
 * index is the first occurrence's 1-based position in the original input array.
 * fetchBuffer is a trusted fixture hook with fetchSafeBuffer's { buffer } contract.
 * assertCurrent is synchronous; its exceptions and caller aborts always escape.
 * Byte budgets measure JPEG bytes, before base64 expansion. No cache or I/O writes.
 */
export async function prepareVisionImages(urls, options = {}) {
  const check = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
  };
  check();
  const { selected, requested, omitted } = selectRequests(urls);
  const images = [];
  let failed = 0;
  let totalBytes = 0;
  const fetchBuffer = options.fetchBuffer || fetchSafeBuffer;

  for (const { url, index } of selected) {
    check();
    if (url.length > LIMITS.maxUrlLength || !validateSafeUrl(url).ok) {
      failed++;
      continue;
    }
    const source = await imageStep(() => fetchBuffer(url, {
      signal: options.signal,
      timeoutMs: LIMITS.timeoutMs,
      maxBytes: LIMITS.maxSourceBytes,
    }), check);
    check();
    const buffer = source?.buffer;
    if (!validSourceBuffer(buffer)) {
      failed++;
      continue;
    }
    const digest = createHash("sha256").update(buffer).digest("hex");
    const metadata = await imageStep(() => sharp(buffer, DECODE_OPTIONS).metadata(), check);
    check();
    if (!validRasterMetadata(metadata)) {
      failed++;
      continue;
    }
    const normalized = await imageStep(() => sharp(buffer, DECODE_OPTIONS)
      .rotate()
      .resize({ width: LIMITS.maxDimension, height: LIMITS.maxDimension, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: LIMITS.jpegQuality })
      .toBuffer({ resolveWithObject: true }), check);
    check();
    if (!normalized || !normalized.data.length || normalized.data.length > LIMITS.maxNormalizedBytes ||
        totalBytes + normalized.data.length > LIMITS.maxTotalNormalizedBytes) {
      failed++;
      continue;
    }
    totalBytes += normalized.data.length;
    images.push({
      content: { type: "image_url", image_url: { url: "data:image/jpeg;base64," + normalized.data.toString("base64") } },
      digest,
      width: normalized.info.width,
      height: normalized.info.height,
      animated: Number(metadata.pages) > 1,
      index,
    });
  }
  check();
  return { images, requested, failed, omitted };
}

function selectRequests(urls) {
  const unique = new Set();
  const selected = [];
  for (const [position, value] of (Array.isArray(urls) ? urls : []).entries()) {
    if (typeof value !== "string") continue;
    const url = value.trim();
    if (!url || unique.has(url)) continue;
    unique.add(url);
    if (selected.length < LIMITS.maxImages) selected.push({ url, index: position + 1 });
  }
  return { selected, requested: unique.size, omitted: unique.size - selected.length };
}

async function imageStep(operation, check) {
  check();
  try {
    return await operation();
  } catch (error) {
    // A per-download timeout is an unreadable asset; the caller's abort is checked below.
    if (error?.code === "CHAT_CANCELLED" || error?.code === "CHAT_TOOL_STOPPED") throw error;
    return null;
  } finally {
    // Outside the catch: even a one-shot session invalidation must not be swallowed.
    check();
  }
}

function validRasterMetadata(metadata) {
  return Boolean(metadata && RASTER_FORMATS.has(metadata.format) &&
    Number.isSafeInteger(metadata.width) && metadata.width > 0 &&
    Number.isSafeInteger(metadata.height) && metadata.height > 0 &&
    metadata.width * metadata.height <= LIMITS.maxInputPixels);
}

function validSourceBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 0 &&
    buffer.length <= LIMITS.maxSourceBytes && hasRasterSignature(buffer);
}

function hasRasterSignature(buffer) {
  // Keep SVG/PDF (and their resource loaders) out of sharp even at metadata time.
  const prefix = buffer.subarray(0, 8).toString("hex");
  return prefix.startsWith("ffd8ff") || prefix === "89504e470d0a1a0a" ||
    prefix.startsWith("474946383761") || prefix.startsWith("474946383961") ||
    prefix.startsWith("49492a00") || prefix.startsWith("4d4d002a") ||
    prefix.startsWith("49492b00") || prefix.startsWith("4d4d002b") ||
    (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") ||
    buffer.toString("ascii", 4, 8) === "ftyp";
}
