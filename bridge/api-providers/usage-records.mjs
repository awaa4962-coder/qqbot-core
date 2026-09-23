import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.mjs";

export const RETENTION_DAYS = 30;
const FILE_PATTERN = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESET_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 4096;
const cleanupDays = new Map();

export function usageDirectory(options = {}) { return path.resolve(options.dir || CFG.apiUsageDir); }
export function beijingDate(timestamp) { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10); }
export function beijingDayStart(timestamp) { return Date.parse(beijingDate(timestamp) + "T00:00:00+08:00"); }
export function validTimestamp(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 253_402_272_000_000; }

export function appendUsageEvent(record, options = {}) {
  const dir = usageDirectory(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  cleanupExpired(dir, record.timestamp);
  // Reserve space for privacy barriers in the journal understood by older releases.
  const filename = path.join(dir, "usage-" + beijingDate(record.timestamp) + ".jsonl");
  const line = Buffer.from(JSON.stringify(record) + "\n");
  if (line.length > MAX_LINE_BYTES) throw new Error("usage_record_limit");
  rejectLink(filename);
  const descriptor = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("usage_not_regular");
    const separated = separateTrailingFragment(descriptor, stat.size, line);
    const limit = MAX_FILE_BYTES + (record.kind === "reset" ? MAX_RESET_BYTES : 0);
    if (stat.size + separated.length > limit) throw new Error("usage_file_limit");
    if (fs.writeSync(descriptor, separated) !== separated.length) throw new Error("usage_write_incomplete");
    if (record.kind === "reset") fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function separateTrailingFragment(descriptor, size, line) {
  if (!size) return line;
  const tail = Buffer.alloc(1);
  if (fs.readSync(descriptor, tail, 0, 1, size - 1) !== 1) throw new Error("usage_read_incomplete");
  // A failed earlier append may have left partial JSON; keep the next reset independently readable.
  return tail[0] === 10 ? line : Buffer.concat([Buffer.from("\n"), line]);
}

export function usageUserKey(userId, options = {}) {
  const value = String(userId || "").trim();
  if (!value) return "";
  const salt = options.salt || usageSalt(usageDirectory(options), options.createSalt === true);
  return salt ? crypto.createHmac("sha256", salt).update(value).digest("hex").slice(0, 32) : "";
}

export function readUsageEvents({ since, now, includeFutureResets = false, ...options }) {
  const dir = usageDirectory(options);
  const coverage = { complete: true, truncated: false, invalidRecords: 0, unreadableFiles: 0, filesRead: 0, rowsOmitted: 0 };
  const events = [];
  let files;
  try { files = fs.readdirSync(dir).filter(file => FILE_PATTERN.test(file)).sort().reverse(); }
  catch (error) {
    if (error.code !== "ENOENT") { coverage.complete = false; coverage.unreadableFiles++; }
    return { events, coverage };
  }
  let bytesRead = 0;
  for (const file of files) {
    const day = file.match(FILE_PATTERN)[1];
    if (day < beijingDate(since) || (!includeFutureResets && day > beijingDate(now))) continue;
    const read = readUsageFile(path.join(dir, file), MAX_READ_BYTES - bytesRead, coverage);
    bytesRead += read.bytes;
    for (const line of read.lines) {
      const event = parseEvent(line);
      if (!event) { coverage.invalidRecords++; coverage.complete = false; continue; }
      if (event.timestamp <= since || (event.timestamp > now && !(includeFutureResets && event.kind === "reset"))) continue;
      events.push(event);
    }
  }
  return { events, coverage };
}

function readUsageFile(filename, remaining, coverage) {
  let descriptor;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("usage_not_regular");
    if (stat.size > MAX_FILE_BYTES + MAX_RESET_BYTES || stat.size > remaining) {
      coverage.truncated = true; coverage.complete = false; return { lines: [], bytes: 0 };
    }
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > Math.min(MAX_FILE_BYTES + MAX_RESET_BYTES, remaining)) throw new Error("usage_changed");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!read) break;
      offset += read;
    }
    coverage.filesRead++;
    return { lines: buffer.subarray(0, offset).toString("utf8").split(/\r?\n/).filter(Boolean), bytes: offset };
  } catch { coverage.unreadableFiles++; coverage.complete = false; return { lines: [], bytes: 0 }; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function parseEvent(line) {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value) || !validTimestamp(value.timestamp)) return null;
    if (!["usage", "reset"].includes(value.kind) || ![undefined, 2].includes(value.schema)) return null;
    if (typeof value.userKey !== "string" || (value.userKey !== "" && !/^[a-f0-9]{32}$/.test(value.userKey))) return null;
    if (value.kind === "reset" && !value.userKey) return null;
    if (!validMetadata(value)) return null;
    return value;
  } catch { return null; }
}

function validMetadata(value) {
  const dimensions = ["provider", "model", "task", "position", "promptVersion", "promptFingerprint", "configuredMode", "effectiveMode", "reasoningControl", "reasoningApplied"];
  return dimensions.every(key => value[key] === undefined || typeof value[key] === "string");
}

function usageSalt(dir, create) {
  const file = path.join(dir, ".user-salt");
  const existing = readSalt(file);
  if (existing) return existing;
  if (!create) return "";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(file, generated + "\n", { flag: "wx", mode: 0o600 }); return generated; }
  catch (error) {
    if (error.code === "EEXIST") {
      const raced = readSalt(file);
      if (raced) return raced;
    }
    throw error;
  }
}

function readSalt(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error("usage_salt_invalid");
    const value = fs.readFileSync(file, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("usage_salt_invalid");
    return value;
  } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function rejectLink(filename) {
  try { if (!fs.lstatSync(filename).isFile()) throw new Error("usage_not_regular"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function cleanupExpired(dir, now) {
  const today = beijingDate(now);
  if (cleanupDays.get(dir) === today) return;
  const cutoff = now - RETENTION_DAYS * 86400000;
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(FILE_PATTERN);
    if (!match) continue;
    const end = Date.parse(match[1] + "T23:59:59+08:00");
    if (!Number.isFinite(end) || end >= cutoff) continue;
    const filename = path.join(dir, file);
    if (fs.lstatSync(filename).isFile()) fs.unlinkSync(filename);
  }
  cleanupDays.set(dir, today);
  if (cleanupDays.size > 64) cleanupDays.delete(cleanupDays.keys().next().value);
}
