// bridge/admin-api/log-reader.mjs - safe readonly tail for local logs.

import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.mjs";

const MAX_TAIL_LINES = 1000;
const MAX_READ_BYTES = 512 * 1024;

export function listLogFiles(logDir = CFG.logDir) {
  try {
    return fs.readdirSync(logDir)
      .filter(file => file.endsWith(".log"))
      .map(file => {
        const fullPath = path.join(logDir, file);
        const stat = fs.statSync(fullPath);
        return {
          file,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch {
    return [];
  }
}

export function readLogTail(options = {}) {
  const logDir = options.logDir || CFG.logDir;
  const file = resolveLogFile(logDir, options.file);
  if (!file) {
    return { file: null, lines: [], count: 0, truncated: false };
  }

  const fullPath = path.join(logDir, file);
  const stat = fs.statSync(fullPath);
  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const fd = fs.openSync(fullPath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const raw = buffer.toString("utf8");
    const filter = String(options.filter || "").trim().toLowerCase();
    const tail = clampTail(options.tail);
    const lines = raw.split(/\r?\n/)
      .filter(Boolean)
      .filter(line => !filter || line.toLowerCase().includes(filter))
      .slice(-tail)
      .map(redactLogLine);
    return {
      file,
      lines,
      count: lines.length,
      truncated: start > 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveLogFile(logDir, requestedFile) {
  const files = listLogFiles(logDir).map(item => item.file);
  if (!files.length) return null;
  if (!requestedFile) return files[0];

  const file = path.basename(String(requestedFile));
  if (file !== String(requestedFile) || !file.endsWith(".log")) {
    throw new Error("invalid log file");
  }
  if (!files.includes(file)) {
    throw new Error("log file not found");
  }
  return file;
}

export function redactLogLine(line) {
  return String(line || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|authorization|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2***")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-***")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***");
}

function clampTail(value) {
  const parsed = Number(value || 200);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(parsed)));
}
