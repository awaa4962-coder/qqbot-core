import fs from "node:fs";
import path from "node:path";

import { CFG } from "../config.mjs";

const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000;

export function createDailySummaryGuard(options = {}) {
  const dateText = safePart(options.dateText);
  const groupId = safePart(options.groupId);
  if (!dateText || !groupId) throw new Error("daily summary guard requires dateText and groupId");

  const root = options.rootDir || path.join(CFG.logDir, "summary-state");
  const staleMs = Number(options.staleMs || DEFAULT_STALE_LOCK_MS);
  const baseName = dateText + "-" + groupId;
  const sentFile = path.join(root, baseName + ".sent.json");
  const lockDir = path.join(root, baseName + ".lock");

  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(sentFile)) return guardResult(false, "already_sent", sentFile, lockDir);
  cleanupStaleLock(lockDir, staleMs);

  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "run.json"), JSON.stringify({
      dateText,
      groupId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch (error) {
    if (error.code === "EEXIST") return guardResult(false, "already_running", sentFile, lockDir);
    throw error;
  }

  return {
    ...guardResult(true, "", sentFile, lockDir),
    markSent: (payload = {}) => markDailySummarySent(sentFile, { dateText, groupId, ...payload }),
    release: () => releaseDailySummaryGuard(lockDir),
  };
}

export function markDailySummarySent(sentFile, payload = {}) {
  fs.mkdirSync(path.dirname(sentFile), { recursive: true });
  fs.writeFileSync(sentFile, JSON.stringify({
    ...payload,
    sentAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

export function releaseDailySummaryGuard(lockDir) {
  if (!lockDir) return;
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function cleanupStaleLock(lockDir, staleMs) {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > staleMs) releaseDailySummaryGuard(lockDir);
  } catch {
    // Missing lock is the normal path.
  }
}

function guardResult(ok, reason, sentFile, lockDir) {
  return { ok, reason, sentFile, lockDir };
}

function safePart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}
