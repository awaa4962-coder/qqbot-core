import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log, logE } from "../logger.mjs";

export const JM_TEMP_PREFIX = "qqfriend-jm-";

export const JM_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const activeJmTempDirs = new Set();

export function scheduleJmTempCleanup(tempDir, delayMs = JM_CLEANUP_DELAY_MS) {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true })
      .then(() => log("jm temp cleaned:", tempDir))
      .catch(error => logE("jm temp cleanup failed:", error.message));
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
    logE("jm temp scan failed:", error.message);
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
    await fs.rm(fullPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    logE("jm temp cleanup failed:", error.message);
    return false;
  }
}
