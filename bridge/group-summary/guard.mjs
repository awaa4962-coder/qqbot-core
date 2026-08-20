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
  const attemptFile = path.join(root, baseName + ".attempt.json");
  const lockDir = path.join(root, baseName + ".lock");
  const uptimeNow = options.uptimeNow || readHostUptimeMs;

  fs.mkdirSync(root, { recursive: true });
  if (hasValidSentMarker(sentFile, dateText, groupId)) {
    return guardResult(false, "already_sent", sentFile, attemptFile, lockDir);
  }
  quarantineInvalidMarker(sentFile);
  const hasAttempt = hasUnconfirmedAttempt(attemptFile, dateText, groupId);
  if (hasAttempt && !options.recoverUnconfirmed) {
    return guardResult(false, "previous_attempt_unconfirmed", sentFile, attemptFile, lockDir);
  }
  if (hasAttempt && options.recoverUnconfirmed) fs.rmSync(attemptFile, { force: true });
  if (!hasAttempt) quarantineInvalidMarker(attemptFile);
  cleanupStaleLock(lockDir, staleMs, uptimeNow);

  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "run.json"), JSON.stringify({
      dateText,
      groupId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostUptimeMs: uptimeNow(),
    }, null, 2), "utf8");
  } catch (error) {
    if (error.code === "EEXIST") {
      return guardResult(false, "already_running", sentFile, attemptFile, lockDir);
    }
    throw error;
  }

  return {
    ...guardResult(true, "", sentFile, attemptFile, lockDir),
    markAttempt: (payload = {}) => markDailySummaryAttempt(attemptFile, { dateText, groupId, ...payload }),
    markSent: (payload = {}) => {
      markDailySummarySent(sentFile, { dateText, groupId, ...payload });
      fs.rmSync(attemptFile, { force: true });
    },
    markFailed: () => fs.rmSync(attemptFile, { force: true }),
    release: () => releaseDailySummaryGuard(lockDir),
  };
}

export function markDailySummarySent(sentFile, payload = {}) {
  writeJsonAtomic(sentFile, {
    ...payload,
    status: "sent",
    sentAt: new Date().toISOString(),
  });
}

export function markDailySummaryAttempt(attemptFile, payload = {}) {
  writeJsonAtomic(attemptFile, {
    ...payload,
    status: "sending",
    startedAt: new Date().toISOString(),
    hostUptimeMs: readHostUptimeMs(),
  });
}

export function releaseDailySummaryGuard(lockDir) {
  if (!lockDir) return;
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function cleanupStaleLock(lockDir, staleMs, uptimeNow) {
  try {
    const metadata = readJson(path.join(lockDir, "run.json"));
    const started = Number(metadata?.hostUptimeMs);
    const current = Number(uptimeNow());
    if (Number.isFinite(started) && Number.isFinite(current)) {
      const age = current - started;
      if (age < 0 || age > staleMs) releaseDailySummaryGuard(lockDir);
      return;
    }
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age > staleMs || age < -5 * 60 * 1000) releaseDailySummaryGuard(lockDir);
  } catch {
    // Missing lock is the normal path.
  }
}

function guardResult(ok, reason, sentFile, attemptFile, lockDir) {
  return { ok, reason, sentFile, attemptFile, lockDir };
}

function safePart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

function hasValidSentMarker(sentFile, dateText, groupId) {
  const marker = readJson(sentFile);
  if (!marker) return false;
  const legacySent = marker.sentAt && !marker.status;
  return (marker.status === "sent" || legacySent)
    && String(marker.dateText) === String(dateText)
    && String(marker.groupId) === String(groupId);
}

function hasUnconfirmedAttempt(attemptFile, dateText, groupId) {
  const marker = readJson(attemptFile);
  return marker?.status === "sending"
    && String(marker.dateText) === String(dateText)
    && String(marker.groupId) === String(groupId);
}

function quarantineInvalidMarker(filename) {
  if (!fs.existsSync(filename)) return;
  const quarantine = filename + ".invalid-" + String(process.pid) + "-" + String(Date.now());
  try { fs.renameSync(filename, quarantine); } catch {}
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; }
}

function writeJsonAtomic(filename, payload) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = filename + ".tmp-" + String(process.pid) + "-" + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filename);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readHostUptimeMs() {
  try {
    const seconds = Number(fs.readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
    if (Number.isFinite(seconds)) return seconds * 1000;
  } catch {}
  return process.uptime() * 1000;
}
