import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CFG } from "../config.mjs";
import { isSuccessfulOutbound } from "../cognition/outcome.mjs";
import { normalizeOutboundText, sendTextToGroup, splitLongText } from "../outbound-message.mjs";
import { createDailySummaryGuard } from "./guard.mjs";
import { assertSummaryEpoch, readSummaryJson, summaryKey, writeSummaryJson } from "./state.mjs";

export function deliveryDirectory(options = {}) {
  return options.guardRoot || (options.root ? path.join(options.root, "delivery") : path.join(CFG.logDir, "summary-state"));
}

export function readSummaryDelivery(dateText, groupId, options = {}) {
  const base = path.join(deliveryDirectory(options), summaryKey(dateText, groupId));
  let sent;
  try { sent = readSummaryJson(base + ".sent.json"); } catch { return { status: "invalid_marker" }; }
  if (sent && (sent.status === "sent" || sent.sentAt)) return { status: "sent", revisionId: sent.revisionId || "", sentAt: sent.sentAt };
  const progress = readSummaryJson(base + ".delivery.json");
  if (!progress && readSummaryJson(base + ".attempt.json")) return { status: "unconfirmed" };
  if (progress?.status === "sending") return { ...progress, status: "unconfirmed" };
  return progress || { status: "not_sent" };
}

export async function publishSummary(result, options = {}) {
  if (!(options.groupWhitelist || CFG.summaryGroupWhitelist).map(String).includes(String(result.groupId))) throw new Error("该群未启用日报");
  const hash = createHash("sha256").update(normalizeOutboundText(result.summary)).digest("hex");
  const previous = readSummaryDelivery(result.dateText, result.groupId, options);
  if (!options.resume && ["partial", "unconfirmed", "invalid_marker"].includes(previous.status)) return { ...result, ok: true, sent: false, skipped: true, reason: "previous_attempt_unconfirmed", publicationManaged: true };
  validateResume(result, previous, hash, options);
  const guard = options.guard || createDailySummaryGuard({ dateText: result.dateText, groupId: result.groupId, rootDir: deliveryDirectory(options), recoverUnconfirmed: options.resume === true });
  if (!guard.ok) return { ...result, ok: true, sent: false, skipped: true, reason: guard.reason, publicationManaged: true };
  try {
    const latest = readSummaryDelivery(result.dateText, result.groupId, options);
    validateResume(result, latest, hash, options);
    return await sendReportChunks(result, { ...options, guard, hash, previous: latest });
  } finally { if (!options.guard) guard.release(); }
}

function validateResume(result, delivery, hash, options) {
  if (!options.resume) return;
  if (delivery.status !== "partial" || delivery.hash !== hash || delivery.revisionId !== result.revisionId) throw new Error("只能继续同一版本已确认失败的剩余分段，请刷新确认进度");
}

export function resolveSummaryDelivery(result, delivered, options = {}) {
  const guard = createDailySummaryGuard({ dateText: result.dateText, groupId: result.groupId, rootDir: deliveryDirectory(options), recoverUnconfirmed: true });
  if (!guard.ok) throw new Error("另一个发送任务正在运行或已完成");
  try {
    const previous = readSummaryDelivery(result.dateText, result.groupId, options);
    if (previous.status !== "unconfirmed" || previous.revisionId !== result.revisionId || !previous.total) throw new Error("这份日报没有可核实的发送分段");
    const record = { ...previous, status: "partial", resolution: delivered ? "manual-delivered" : "manual-not-sent" };
    if (!delivered && record.completed >= record.total) throw new Error("全部分段已有回执，不能撤销发送确认");
    if (delivered && record.completed < record.total) { record.completed++; record.receipts.push("manual-confirmed"); }
    if (record.completed >= record.total) {
      guard.markSent({ revisionId: result.revisionId, hash: record.hash, segments: record.total });
      record.status = "sent";
    } else guard.markAttempt({ revisionId: result.revisionId, hash: record.hash, nextIndex: record.completed });
    writeSummaryJson(path.join(deliveryDirectory(options), summaryKey(result.dateText, result.groupId) + ".delivery.json"), record);
    return { ok: true, sent: record.status === "sent", revisionId: result.revisionId, delivery: record };
  } finally { guard.release(); }
}

async function sendReportChunks(result, options) {
  assertSummaryEpoch(result.privacyEpoch, options);
  const chunks = splitLongText(result.summary, 900);
  if (!chunks.length) throw new Error("日报正文为空");
  const record = initialDelivery(result, options, chunks.length);
  const filename = path.join(deliveryDirectory(options), summaryKey(result.dateText, result.groupId) + ".delivery.json");
  const persist = () => writeSummaryJson(filename, record);
  const sender = options.sendGroupMessage || ((groupId, text) => sendTextToGroup({ groupId, text, maxAttempts: 1 }));
  options.onProgress?.("sending");
  if (options.beforeSend) await options.beforeSend({ dateText: result.dateText, groupId: result.groupId, messages: result.messages, revisionId: result.revisionId });
  for (let index = record.completed; index < chunks.length; index++) {
    assertSummaryEpoch(result.privacyEpoch, options);
    options.guard.markAttempt?.({ revisionId: result.revisionId, hash: options.hash, nextIndex: index });
    persist();
    let receipt;
    try { receipt = await sender(result.groupId, chunks[index]); } catch { receipt = null; }
    if (!isSuccessfulOutbound(receipt)) {
      record.status = rejectedStatus(receipt, record.completed);
      persist();
      if (record.status === "failed") options.guard.markFailed?.();
      return { ...result, ok: false, sent: false, error: "send_failed", publicationManaged: true, delivery: record,
        message: record.status === "failed" ? "发送已确认失败，可以稍后重试。" : "发送未全部确认，请在日报工作台核实，系统不会整篇重发。" };
    }
    record.completed = index + 1;
    record.receipts.push(receiptId(receipt));
    persist();
    if (index + 1 < chunks.length) await delay(options.delayMs ?? 300);
  }
  options.guard.markSent({ revisionId: result.revisionId, hash: options.hash, messages: result.messages, segments: record.total });
  record.status = "sent";
  persist();
  return { ...result, sent: true, publicationManaged: true, delivery: record };
}

function initialDelivery(result, options, total) {
  return {
    dateText: result.dateText, groupId: result.groupId, revisionId: result.revisionId,
    hash: options.hash, total, completed: options.resume ? options.previous.completed : 0,
    receipts: options.resume ? [...options.previous.receipts] : [], status: "sending",
  };
}

function rejectedStatus(receipt, completed) {
  const rejected = receipt && (receipt.status === "failed" || Number(receipt.retcode) > 0);
  return rejected ? (completed ? "partial" : "failed") : "unconfirmed";
}

function receiptId(receipt) { return String(receipt?.data?.message_id || receipt?.message_id || "acknowledged"); }
