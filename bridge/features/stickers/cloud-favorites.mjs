// QQ cloud-favorite lifecycle with strict temporary-file cleanup.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../../config.mjs";
import {
  addCustomFace,
  deleteCustomFace,
  fetchFavoriteStickerDetails,
} from "./napcat-adapter.mjs";

const TEMP_MAX_AGE_MS = 15 * 60 * 1000;

export async function addBufferToCloudFavorites(image = {}, options = {}) {
  const buffer = Buffer.isBuffer(image.buffer) ? image.buffer : null;
  if (!buffer?.length) return { ok: false, error: "表情图片为空" };
  const md5 = crypto.createHash("md5").update(buffer).digest("hex");
  const adapter = options.adapter || {
    add: addCustomFace,
    details: fetchFavoriteStickerDetails,
  };
  const preflight = await lookupCloudItem(md5, adapter.details, options);
  if (preflight.item) {
    return {
      ok: true,
      created: false,
      md5,
      item: preflight.item,
      detailPending: false,
      error: "",
    };
  }

  return await withTemporaryStickerFile({
    buffer,
    mimeType: image.mimeType,
    md5,
  }, async file => {
    const added = await adapter.add(file.path, {
      md5,
      fileName: file.name,
      fileSize: buffer.length,
      timeoutMs: options.timeoutMs,
    });
    if (!added.ok) return { ok: false, md5, error: added.error };

    const item = await findCloudItem(md5, adapter.details, options, 3);
    return {
      ok: true,
      created: preflight.ok,
      md5,
      item: item || {
        url: image.url || "",
        md5,
      },
      detailPending: !item,
      error: "",
    };
  }, options);
}

export async function deleteCapturedCloudFavorite(entry = {}, options = {}) {
  if (!entry.resId) return { ok: false, error: "该表情没有可删除的 QQ 云资源 ID" };
  return await (options.remove || deleteCustomFace)(entry.resId, options);
}

export async function withTemporaryStickerFile(image, callback, options = {}) {
  const tempDir = path.resolve(options.tempDir || CFG.stickerTempDir);
  fs.mkdirSync(tempDir, { recursive: true });
  const extension = extensionForMime(image.mimeType);
  const name = "sticker-" + Date.now() + "-" + crypto.randomUUID() + extension;
  const filename = path.join(tempDir, name);
  fs.writeFileSync(filename, image.buffer, { flag: "wx" });
  try {
    return await callback({ path: filename, name });
  } finally {
    try {
      fs.rmSync(filename, { force: true });
    } catch {
      // Startup cleanup handles files left behind by external locks.
    }
  }
}

export function cleanupTemporaryStickerFiles(options = {}) {
  const tempDir = path.resolve(options.tempDir || CFG.stickerTempDir);
  const now = Number(options.now || Date.now());
  const maxAgeMs = Number(options.maxAgeMs || TEMP_MAX_AGE_MS);
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("sticker-")) continue;
      const filename = path.join(tempDir, entry.name);
      const stat = fs.statSync(filename);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      fs.rmSync(filename, { force: true });
      removed++;
    }
  } catch {
    return { removed, directoryExists: false };
  }
  return { removed, directoryExists: true };
}

async function findCloudItem(md5, fetchDetails, options, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
    const details = await fetchDetails({
      count: options.detailCount || CFG.stickerFetchCount,
      timeoutMs: options.timeoutMs,
    });
    if (!details.ok) continue;
    const item = details.items.find(candidate => candidate.md5.toLowerCase() === md5);
    if (item) return item;
  }
  return null;
}

async function lookupCloudItem(md5, fetchDetails, options) {
  const details = await fetchDetails({
    count: options.detailCount || CFG.stickerFetchCount,
    timeoutMs: options.timeoutMs,
  });
  return {
    ok: details.ok,
    item: details.ok
      ? details.items.find(candidate => candidate.md5.toLowerCase() === md5) || null
      : null,
  };
}

function extensionForMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("gif")) return ".gif";
  if (value.includes("webp")) return ".webp";
  if (value.includes("png")) return ".png";
  if (value.includes("jpeg") || value.includes("jpg")) return ".jpg";
  return ".img";
}
