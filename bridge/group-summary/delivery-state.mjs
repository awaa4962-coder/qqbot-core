import path from "node:path";
import { CFG } from "../config.mjs";
import { readSummaryJson, summaryKey } from "./state.mjs";

const missing = Symbol("missing delivery file");
const invalid = Object.freeze({ status: "invalid_marker" });

export function deliveryDirectory(options = {}) {
  return options.guardRoot || (options.root ? path.join(options.root, "delivery") : path.join(CFG.logDir, "summary-state"));
}

export function readSummaryDelivery(dateText, groupId, options = {}) {
  const base = path.join(deliveryDirectory(options), summaryKey(dateText, groupId));
  try {
    const sent = readSummaryJson(base + ".sent.json", missing);
    if (sent !== missing) return readSentMarker(sent, dateText, groupId);
    const attempt = readSummaryJson(base + ".attempt.json", missing);
    const progress = readSummaryJson(base + ".delivery.json", missing);
    if (attempt !== missing && (!matchesTarget(attempt, dateText, groupId) || attempt.status !== "sending")) return invalid;
    if (progress !== missing && (!matchesTarget(progress, dateText, groupId) || !validProgress(progress))) return invalid;
    if (attempt !== missing && attempt.attemptId !== undefined) return readSegmentDelivery(attempt, progress);
    return readLegacyDelivery(attempt, progress);
  } catch {
    return invalid;
  }
}

export function summaryDeliveryBlockReason(delivery) {
  if (delivery.status === "sent") return "already_sent";
  return ["not_sent", "failed"].includes(delivery.status) ? "" : "previous_attempt_unconfirmed";
}

function readSentMarker(sent, dateText, groupId) {
  if (!matchesTarget(sent, dateText, groupId) || !(sent.status === "sent" || (!sent.status && sent.sentAt))) return invalid;
  return { status: "sent", revisionId: sent.revisionId || "", sentAt: sent.sentAt };
}

function readSegmentDelivery(attempt, progress) {
  if (!validAttempt(attempt)) return invalid;
  if (progress === missing) return unconfirmed(attempt);
  if (progress.attemptId === attempt.attemptId) {
    if (progress.status === "sending") return samePrefix(progress, attempt) ? unconfirmed(attempt) : invalid;
    return settlesAttempt(progress, attempt) ? progress : invalid;
  }
  // The attempt can survive even if the matching progress write did not finish.
  if (progress.status === "failed" || (progress.status === "partial" && samePrefix(progress, attempt))) return unconfirmed(attempt);
  return invalid;
}

function readLegacyDelivery(attempt, progress) {
  const unknown = { status: "unconfirmed" };
  if (progress === missing) return attempt === missing ? { status: "not_sent" } : unknown;
  if (attempt !== missing && !sameRevision(progress, attempt)) return unknown;
  if (progress.status === "sending" || progress.status === "unconfirmed") {
    return isReviewableCheckpoint(progress, attempt) ? unconfirmed(progress) : unknown;
  }
  if (attempt === missing || [progress.completed, progress.completed - 1].includes(attempt.nextIndex)) return progress;
  return unknown;
}

function isReviewableCheckpoint(progress, attempt) {
  // Legacy sending checkpoints could also be written after a successful receipt.
  if (progress.completed === progress.total) return true;
  if (attempt === missing) return progress.status === "unconfirmed" || progress.attemptId !== undefined;
  return attempt.nextIndex === progress.completed;
}

function matchesTarget(record, dateText, groupId) {
  return record?.dateText === dateText && String(record.groupId) === String(groupId);
}

function validCheckpoint(record) {
  return typeof record.revisionId === "string" && record.revisionId.length > 0 &&
    typeof record.hash === "string" && /^[a-f0-9]{64}$/.test(record.hash) &&
    Number.isSafeInteger(record.total) && record.total > 0 && Number.isSafeInteger(record.completed) &&
    record.completed >= 0 && record.completed <= record.total && Array.isArray(record.receipts) &&
    record.receipts.length === record.completed && record.receipts.every(receipt => typeof receipt === "string" && receipt.length > 0);
}

function validAttempt(record) {
  return validCheckpoint(record) && typeof record.attemptId === "string" && record.attemptId.length > 0 &&
    record.nextIndex === record.completed && record.completed < record.total;
}

function validProgress(record) {
  if (!validCheckpoint(record)) return false;
  if (record.attemptId !== undefined && (typeof record.attemptId !== "string" || !record.attemptId)) return false;
  if (record.status === "failed") return record.completed === 0;
  if (record.status === "sent") return record.completed === record.total;
  if (record.status === "partial") return record.completed < record.total;
  if (record.attemptId === undefined) return ["sending", "unconfirmed"].includes(record.status);
  return record.status === "sending" && record.completed < record.total;
}

function sameRevision(left, right) {
  return left.revisionId === right.revisionId && left.hash === right.hash;
}

function samePrefix(progress, attempt) {
  return sameRevision(progress, attempt) && progress.total === attempt.total && progress.completed === attempt.completed &&
    progress.receipts.every((receipt, index) => receipt === attempt.receipts[index]);
}

function settlesAttempt(progress, attempt) {
  return sameRevision(progress, attempt) && progress.total === attempt.total &&
    [attempt.completed, attempt.completed + 1].includes(progress.completed) &&
    attempt.receipts.every((receipt, index) => receipt === progress.receipts[index]);
}

function unconfirmed(record) {
  return { ...record, status: "unconfirmed" };
}
