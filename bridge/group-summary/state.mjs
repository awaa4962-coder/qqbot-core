import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.mjs";
import { dateRange, formatDate } from "./date.mjs";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";

export function summaryRoot(options = {}) {
  return path.resolve(options.root || path.join(CFG.dataRoot, ".qqfriend", "summaries"));
}

export function summaryKey(dateText, groupId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText))) throw new Error("无效的日报日期");
  if (formatDate(new Date(dateRange(dateText).start)) !== dateText) throw new Error("无效的日报日期");
  if (!/^\d+$/.test(String(groupId)) || !Number.isSafeInteger(Number(groupId)) || Number(groupId) <= 0) throw new Error("无效的日报群号");
  return dateText + "-" + String(groupId);
}

export function readSummaryJson(filename, fallback = null, maxBytes = 8 * 1024 * 1024) {
  try {
    return readJsonFile(filename, fallback, { maxBytes });
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("日报状态文件读取失败", { cause: error });
  }
}

export function writeSummaryJson(filename, value, options = {}) {
  writeJsonFileSync(filename, value, { durable: options.durable === true });
}

// This lock covers synchronous file mutations only, never a model/network call.
export function withSummaryWriteLock(options, operation) {
  const root = summaryRoot(options);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "write.lock");
  // Only the owner releases this lock; a crashed writer fails closed.
  let descriptor;
  try { descriptor = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("日报记录正在更新，请稍后重试", { cause: error });
    throw error;
  }
  try { return operation(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

export function summaryPrivacy(options = {}) {
  return readSummaryJson(path.join(summaryRoot(options), "privacy.json"), { epoch: 0, users: {} });
}

export function isForgottenSummaryRecord(record, privacy) {
  const uid = String(record.uid ?? record.user_id ?? "");
  const cutoff = Number(privacy.users[uid] || 0);
  // A new arrival time must not make an old, forgotten event new again.
  return cutoff > 0 && [record.ts, record.receivedAt].some(value => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= cutoff;
  });
}

export function assertSummaryEpoch(epoch, options = {}) {
  if (Number(epoch) !== summaryPrivacy(options).epoch) throw new Error("记录已被清理，请重新生成日报");
}
