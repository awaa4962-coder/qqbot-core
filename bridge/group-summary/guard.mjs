import fs from "node:fs";
import path from "node:path";

import { writeJsonFileSync } from "../persistence/json-file.mjs";
import { deliveryDirectory, readSummaryDelivery, summaryDeliveryBlockReason } from "./delivery-state.mjs";
import { summaryKey } from "./state.mjs";

export function summaryPublicationHeld(root = deliveryDirectory()) {
  try { fs.lstatSync(path.join(root, "publication.hold")); return true; }
  catch (error) { return error.code !== "ENOENT"; }
}

export function summarySkipResult(reason, metadata = {}) {
  const pending = !["already_sent", "no_messages"].includes(reason);
  return {
    ...metadata, ok: !pending, sent: false, skipped: true, pending, reason,
    message: pending ? (reason === "already_running" ? "日报任务仍在运行，请稍后查看。" : "日报发送仍待核实，请在日报工作台确认；系统不会自动重发。") : "",
  };
}

export function createDailySummaryGuard(options = {}) {
  const { dateText, groupId } = options;
  const root = path.resolve(options.rootDir || deliveryDirectory());
  const base = path.join(root, summaryKey(dateText, groupId));
  const sentFile = base + ".sent.json";
  const attemptFile = base + ".attempt.json";
  const lockDir = base + ".lock";
  const runFile = path.join(lockDir, "run.json");
  const result = { sentFile, attemptFile, lockDir };
  if (summaryPublicationHeld(root)) return { ...result, ok: false, reason: "publication_held" };

  const createdRoot = fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // This directory is never taken over. A crash requires offline operator cleanup.
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code === "EEXIST") return { ...result, ok: false, reason: "already_running" };
    throw error;
  }

  let owned = true;
  const whileOwned = mutate => payload => {
    if (!owned) throw new Error("daily summary guard was released");
    return mutate(payload);
  };
  function release() {
    if (!owned) return;
    owned = false;
    fs.rmSync(runFile, { force: true });
    fs.rmdirSync(lockDir);
  }

  try {
    const delivery = readSummaryDelivery(dateText, groupId, { guardRoot: root });
    const blocked = summaryDeliveryBlockReason(delivery);
    if (blocked && !(options.recoverUnconfirmed && ["partial", "unconfirmed"].includes(delivery.status))) {
      release();
      return { ...result, ok: false, reason: blocked };
    }
    writeJsonFileSync(runFile, { dateText, groupId, pid: process.pid, startedAt: new Date().toISOString() },
      { durable: true, spacing: 2 });
    syncLockRoot(root, createdRoot);
  } catch (error) {
    try { release(); } catch (releaseError) {
      throw new AggregateError([error, releaseError], "daily summary claim and cleanup failed");
    }
    throw error;
  }

  return {
    ...result, ok: true, reason: "",
    markAttempt: whileOwned((payload = {}) => markDailySummaryAttempt(attemptFile, { ...payload, dateText, groupId })),
    markSent: whileOwned((payload = {}) => {
      markDailySummarySent(sentFile, { ...payload, dateText, groupId });
      fs.rmSync(attemptFile, { force: true });
    }),
    markFailed: whileOwned(() => fs.rmSync(attemptFile, { force: true })),
    release,
  };
}

function syncLockRoot(root, createdRoot) {
  if (process.platform !== "linux") return;
  const boundary = path.dirname(createdRoot || root);
  for (let dir = root; ; dir = path.dirname(dir)) {
    const descriptor = fs.openSync(dir, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (dir === boundary) return;
  }
}

function markDailySummarySent(sentFile, payload) {
  writeJsonFileSync(sentFile, {
    ...payload,
    status: "sent",
    sentAt: new Date().toISOString(),
  }, { durable: true, spacing: 2 });
}

function markDailySummaryAttempt(attemptFile, payload) {
  writeJsonFileSync(attemptFile, {
    ...payload,
    status: "sending",
    startedAt: new Date().toISOString(),
  }, { durable: true, spacing: 2 });
}
