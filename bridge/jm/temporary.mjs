import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log, logE } from "../logger.mjs";

export const JM_TEMP_PREFIX = "qqfriend-jm-";

export const JM_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const activeJmTempDirs = new Set();
const CLEANUP_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

export function scheduleJmTempCleanup(tempDir, delayMs = JM_CLEANUP_DELAY_MS) {
  const timer = setTimeout(() => {
    fs.rm(tempDir, CLEANUP_OPTIONS)
      .then(() => log("jm temp cleaned"))
      .catch(error => logE("jm temp cleanup failed:", cleanupErrorCode(error)));
  }, Math.max(0, delayMs));
  timer.unref?.();
  return timer;
}

export async function cleanupExpiredJmTempDirs(options = {}) {
  const root = options.root || os.tmpdir();
  const maxAgeMs = options.maxAgeMs ?? JM_CLEANUP_DELAY_MS;
  const now = options.now || Date.now();
  let items = [];
  try {
    items = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    logE("jm temp scan failed:", cleanupErrorCode(error));
    return 0;
  }

  let cleaned = 0;
  for (const item of items) {
    if (await cleanupJmTempEntry(root, item, now, maxAgeMs)) cleaned++;
  }
  if (cleaned) log("jm expired temp cleaned:", cleaned);
  return cleaned;
}

export async function cleanupJmTempEntry(root, item, now, maxAgeMs) {
  if (!item.isDirectory() || !item.name.startsWith(JM_TEMP_PREFIX)) return false;
  const fullPath = path.join(root, item.name);
  if (activeJmTempDirs.has(path.resolve(fullPath))) return false;
  try {
    const age = now - (await fs.stat(fullPath)).mtimeMs;
    if (age >= 0 && age < maxAgeMs) return false;
    if (age < 0 && age > -FUTURE_SKEW_MS) return false;
    await fs.rm(fullPath, CLEANUP_OPTIONS);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") logE("jm temp cleanup failed:", cleanupErrorCode(error));
    return false;
  }
}

function cleanupErrorCode(error) {
  return /^(?:EACCES|EBUSY|EIO|EMFILE|ENFILE|ENOENT|ENOTDIR|ENOTEMPTY|EPERM)$/.test(error?.code) ? error.code : "unknown";
}
