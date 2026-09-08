import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CFG } from "../config.mjs";
import { formatDate, dateRange } from "./date.mjs";
import { redactSummaryText } from "./formatter.mjs";
import { readSummaryJson, summaryKey, summaryPrivacy, summaryRoot, withSummaryWriteLock, writeSummaryJson } from "./state.mjs";

const RETENTION_DAYS = 7;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_MESSAGES = 10000;
const indexes = new Map();

export function captureSummaryMessage(ctx, options = {}) {
  const whitelist = options.whitelist || CFG.summaryGroupWhitelist;
  if (!whitelist.map(String).includes(String(ctx.group_id))) return { ok: false, reason: "not_whitelisted" };
  const receivedAt = options.now ?? Date.now();
  const eventTime = Number(ctx.eventTime || 0);
  const earliest = dateRange(formatDate(new Date(receivedAt - (RETENTION_DAYS - 1) * 86400000))).start;
  if (eventTime > 0 && eventTime < earliest) return { ok: false, reason: "expired_event" };
  const ts = eventTime > receivedAt - RETENTION_DAYS * 86400000 && eventTime <= receivedAt + 300000 ? eventTime : receivedAt;
  const dateText = formatDate(new Date(ts));
  const key = summaryKey(dateText, ctx.group_id);
  return withSummaryWriteLock(options, () => appendRecord(key, ctx, { ...options, receivedAt, ts }));
}

function appendRecord(key, ctx, options) {
  const directory = path.join(summaryRoot(options), "journal");
  const filename = path.join(directory, key + ".jsonl");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = journalIndex(filename);
  if (index.needsNewline) { fs.appendFileSync(filename, "\n"); index.bytes++; index.needsNewline = false; }
  const messageId = String(ctx.message_id || "");
  if (messageId && index.ids.has(messageId)) return { ok: true, duplicate: true };
  const record = captureRecord(ctx, options);
  const line = JSON.stringify(record) + "\n";
  if (index.count >= (options.maxMessages || MAX_MESSAGES) || index.bytes + Buffer.byteLength(line) > (options.maxBytes || MAX_BYTES)) {
    writeSummaryJson(path.join(directory, key + ".limit.json"), { capped: true });
    return { ok: false, reason: "capacity" };
  }
  fs.appendFileSync(filename, line, { mode: 0o600 });
  index.count++; index.bytes += Buffer.byteLength(line);
  if (messageId) index.ids.add(messageId);
  while (indexes.size > 64) indexes.delete(indexes.keys().next().value);
  return { ok: true };
}

function captureRecord(ctx, options) {
  const raw = redactSummaryText(ctx.text || (ctx.images?.length ? "[图片]" : "[非文本消息]"));
  const text = boundedEvidenceText(raw, 1800);
  return {
    uid: String(ctx.user_id), nickname: redactSummaryText(ctx.nickname || "群友").slice(0, 40),
    messageId: String(ctx.message_id || ""), replyToMessageId: String(ctx.replyData?.id || ""), text,
    ts: options.ts, receivedAt: options.receivedAt, timestampSource: options.ts === options.receivedAt ? "received" : "event",
    imageCount: ctx.images?.length || 0, fileCount: ctx.files?.length || 0, truncated: raw.length > text.length,
  };
}

function journalIndex(filename) {
  if (indexes.has(filename)) return indexes.get(filename);
  const records = readJournalFile(filename);
  const index = { ids: new Set(records.messages.map(item => item.messageId).filter(Boolean)), count: records.messages.length, bytes: records.bytes, needsNewline: records.needsNewline };
  indexes.set(filename, index);
  return index;
}

function readJournalFile(filename) {
  let data;
  try {
    const bytes = fs.statSync(filename).size;
    if (bytes > MAX_BYTES + 8192) throw new Error("日报记录超过读取上限");
    data = fs.readFileSync(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { messages: [], bytes: 0, malformed: 0, exists: false };
    throw error;
  }
  const messages = [];
  let malformed = 0;
  for (const line of data.split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record.text !== "string" || !Number.isFinite(Number(record.ts))) throw new Error("invalid journal row");
      messages.push(record);
    } catch { malformed++; }
  }
  return { messages, bytes: Buffer.byteLength(data), malformed, exists: true, needsNewline: Boolean(data && !data.endsWith("\n")) };
}

export function loadSummaryCapture(dateText, groupId, options = {}) {
  const key = summaryKey(dateText, groupId);
  const root = summaryRoot(options);
  const journal = readJournalFile(path.join(root, "journal", key + ".jsonl"));
  const privacy = summaryPrivacy(options);
  const legacy = options.legacyMessages || loadLegacy(dateText, groupId, options);
  const seen = new Set();
  const messages = [...journal.messages, ...legacy].filter(message => {
    const cutoff = Number(privacy.users[String(message.uid)] || 0);
    if (cutoff && Number(message.receivedAt || message.ts || 0) <= cutoff) return false;
    const id = message.messageId || createHash("sha256").update(String(message.uid) + ":" + message.ts + ":" + message.text).digest("hex");
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((a, b) => Number(a.ts) - Number(b.ts));
  return {
    messages, privacyEpoch: privacy.epoch,
    coverage: {
      source: journal.exists ? "journal-and-retained" : "retained-only", complete: false,
      captured: messages.length, malformed: journal.malformed,
      capped: Boolean(readSummaryJson(path.join(root, "journal", key + ".limit.json"))?.capped),
      truncated: messages.filter(item => item.truncated).length,
      firstAt: messages[0]?.ts || null, lastAt: messages.at(-1)?.ts || null,
    },
  };
}

function loadLegacy(dateText, groupId, options) {
  const { start, end } = dateRange(dateText);
  const stored = readSummaryJson(options.chatLogFile || CFG.chatLogFile, {}, 64 * 1024 * 1024);
  return (stored[String(groupId)] || []).filter(item => Number(item.ts) >= start && Number(item.ts) <= end);
}

export function boundedEvidenceText(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.45);
  return text.slice(0, head) + "\n[中段已截短]\n" + text.slice(-(limit - head - 12));
}

export function forgetSummaryUser(uid, options = {}) {
  return withSummaryWriteLock(options, () => {
    const root = summaryRoot(options);
    const privacy = summaryPrivacy(options);
    privacy.epoch++;
    privacy.users[String(uid)] = options.now ?? Date.now();
    writeSummaryJson(path.join(root, "privacy.json"), privacy);
    for (const filename of listFiles(path.join(root, "journal"), /\.jsonl$/)) {
      const rows = readJournalFile(filename).messages.filter(item => String(item.uid) !== String(uid));
      const temporary = filename + ".tmp." + process.pid;
      fs.writeFileSync(temporary, rows.map(item => JSON.stringify(item) + "\n").join(""), { mode: 0o600 });
      fs.renameSync(temporary, filename);
    }
    for (const filename of listFiles(path.join(root, "reports"), /\.json$/)) {
      const report = readSummaryJson(filename);
      if (report?.revisions?.some(item => item.contributors?.includes(String(uid)))) fs.rmSync(filename);
    }
    indexes.clear();
  });
}

export function cleanupSummaryFiles(options = {}) {
  return withSummaryWriteLock(options, () => cleanupExpiredFiles(options));
}

function cleanupExpiredFiles(options) {
  const root = summaryRoot(options);
  const oldest = formatDate(new Date((options.now ?? Date.now()) - (RETENTION_DAYS - 1) * 86400000));
  let removed = 0;
  for (const directory of ["journal", "reports"]) {
    for (const filename of listFiles(path.join(root, directory), /^\d{4}-\d{2}-\d{2}-\d+\./)) {
      if (path.basename(filename).slice(0, 10) < oldest) { fs.rmSync(filename); removed++; }
    }
  }
  indexes.clear();
  return { removed };
}

function listFiles(directory, pattern) {
  try { return fs.readdirSync(directory).filter(name => pattern.test(name)).map(name => path.join(directory, name)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
