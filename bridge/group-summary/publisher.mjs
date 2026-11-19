import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CFG } from "../config.mjs";
import { isSuccessfulOutbound } from "../cognition/outcome.mjs";
import { isDefiniteOneBotRejection } from "../onebot-receipt.mjs";
import { normalizeOutboundText, sendTextToGroup, splitLongText } from "../outbound-message.mjs";
import { deliveryDirectory, readSummaryDelivery, summaryDeliveryBlockReason } from "./delivery-state.mjs";
import { createDailySummaryGuard, summaryPublicationHeld, summarySkipResult } from "./guard.mjs";
import { assertSummaryEpoch, summaryKey, writeSummaryJson } from "./state.mjs";

export { deliveryDirectory, readSummaryDelivery };

export async function publishSummary(result, options = {}) {
  assertSummaryDeliveryAllowed(result.groupId, options);
  if (typeof result.revisionId !== "string" || !result.revisionId) throw new Error("日报缺少草稿版本");
  const hash = summaryHash(result);
  const chunks = splitLongText(result.summary, 900);
  if (!chunks.length) throw new Error("日报正文为空");
  const guard = options.guard || createDailySummaryGuard({ dateText: result.dateText, groupId: result.groupId, rootDir: deliveryDirectory(options), recoverUnconfirmed: options.resume === true });
  if (!guard.ok) return summarySkipResult(guard.reason, { ...result, publicationManaged: true });
  try {
    const latest = readSummaryDelivery(result.dateText, result.groupId, options);
    if (options.resume) {
      if (latest.status !== "partial" || !matchesReport(result, latest, hash, chunks.length)) throw new Error("只能继续同一版本已确认失败的剩余分段，请刷新确认进度");
    } else {
      const blocked = summaryDeliveryBlockReason(latest);
      if (blocked) return summarySkipResult(blocked, { ...result, publicationManaged: true });
    }
    return await sendReportChunks(result, chunks, { ...options, guard, hash, previous: latest });
  } finally { if (!options.guard) guard.release(); }
}

function summaryHash(result) {
  return createHash("sha256").update(normalizeOutboundText(result.summary)).digest("hex");
}

function matchesReport(result, delivery, hash, total) {
  return delivery.hash === hash && delivery.revisionId === result.revisionId && delivery.total === total;
}

function persistDelivery(result, options, record) {
  const filename = path.join(deliveryDirectory(options), summaryKey(result.dateText, result.groupId) + ".delivery.json");
  writeSummaryJson(filename, record, { durable: true });
}

export function resolveSummaryDelivery(result, delivered, options = {}) {
  assertSummaryDeliveryAllowed(result.groupId, options);
  assertSummaryEpoch(result.privacyEpoch, options);
  const guard = createDailySummaryGuard({ dateText: result.dateText, groupId: result.groupId, rootDir: deliveryDirectory(options), recoverUnconfirmed: true });
  if (!guard.ok) throw new Error("另一个发送任务正在运行或已完成");
  try {
    const previous = readSummaryDelivery(result.dateText, result.groupId, options);
    if (previous.status !== "unconfirmed" || !matchesReport(result, previous, summaryHash(result), splitLongText(result.summary, 900).length)) throw new Error("这份日报没有可核实的发送分段");
    const record = { ...previous, status: "partial", resolution: delivered ? "manual-delivered" : "manual-not-sent" };
    if (!delivered && record.completed >= record.total) throw new Error("全部分段已有回执，不能撤销发送确认");
    if (delivered && record.completed < record.total) {
      record.completed++;
      record.receipts.push("manual-confirmed");
    }
    if (record.completed === record.total) {
      record.status = "sent";
      record.sentAt = new Date().toISOString();
      // Manual recovery can start without an attempt file, so fence rollback first.
      guard.markSent({ revisionId: result.revisionId, hash: record.hash, segments: record.total });
    }
    persistDelivery(result, options, record);
    return { ok: true, sent: record.status === "sent", revisionId: result.revisionId, delivery: record };
  } finally { guard.release(); }
}

async function sendReportChunks(result, chunks, options) {
  assertSummaryEpoch(result.privacyEpoch, options);
  const record = initialDelivery(result, options, chunks.length);
  const sender = options.sendGroupMessage || ((groupId, text) => sendTextToGroup({ groupId, text, maxAttempts: 1 }));
  options.onProgress?.("sending");
  if (options.beforeSend) await options.beforeSend({ dateText: result.dateText, groupId: result.groupId, messages: result.messages, revisionId: result.revisionId });
  for (let index = record.completed; index < chunks.length; index++) {
    if (options.beforeChunk) await options.beforeChunk();
    assertNextSummaryChunk(result, options);
    // The attempt carries the full confirmed prefix and is durable before sending.
    record.attemptId = randomUUID();
    options.guard.markAttempt({ ...record, nextIndex: index });
    // The 2.1.2 reader must see this send as in flight, not an older partial outcome.
    persistDelivery(result, options, { ...record, status: "sending" });
    let receipt;
    try { receipt = await sender(result.groupId, chunks[index]); } catch { receipt = null; }
    if (!isSuccessfulOutbound(receipt)) {
      record.status = rejectedStatus(receipt, record.completed);
      if (record.status !== "unconfirmed") persistDelivery(result, options, record);
      if (record.status === "failed") options.guard.markFailed();
      return { ...result, ok: false, sent: false, pending: record.status !== "failed", error: "send_failed", publicationManaged: true, delivery: record,
        message: record.status === "failed" ? "发送已确认失败，可以稍后重试。" : "发送未全部确认，请在日报工作台核实，系统不会整篇重发。" };
    }
    record.completed = index + 1;
    record.receipts.push(receiptId(receipt));
    record.status = record.completed === record.total ? "sent" : "partial";
    if (record.status === "sent") record.sentAt = new Date().toISOString();
    persistDelivery(result, options, record);
    if (index + 1 < chunks.length) await delay(options.delayMs ?? 300);
  }
  options.guard.markSent({ revisionId: result.revisionId, hash: options.hash, messages: result.messages, segments: record.total });
  return { ...result, sent: true, publicationManaged: true, delivery: record };
}

function assertNextSummaryChunk(result, options) {
  if (summaryPublicationHeld(deliveryDirectory(options))) throw new Error("日报发布维护中，未提交下一段");
  assertSummaryEpoch(result.privacyEpoch, options);
  assertSummaryDeliveryAllowed(result.groupId, options);
}

function assertSummaryDeliveryAllowed(groupId, options) {
  if (!(options.groupWhitelist || CFG.summaryGroupWhitelist).map(String).includes(String(groupId))) throw new Error("该群未启用日报");
}

function initialDelivery(result, options, total) {
  return {
    dateText: result.dateText, groupId: result.groupId, revisionId: result.revisionId,
    hash: options.hash, total, completed: options.resume ? options.previous.completed : 0,
    receipts: options.resume ? [...options.previous.receipts] : [],
  };
}

function rejectedStatus(receipt, completed) {
  const rejected = isDefiniteOneBotRejection(receipt);
  return rejected ? (completed ? "partial" : "failed") : "unconfirmed";
}

function receiptId(receipt) { return String(receipt?.data?.message_id || receipt?.message_id || "acknowledged"); }
