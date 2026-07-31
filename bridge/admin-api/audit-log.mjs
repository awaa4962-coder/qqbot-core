// bridge/admin-api/audit-log.mjs - safe local admin operation audit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactLogLine } from "./log-reader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_FILE = path.join(ROOT, "logs", "admin-audit.log");
const MAX_ACTION_LENGTH = 120;
const MAX_QUERY_KEYS = 20;

export function recordAdminAudit(entry = {}) {
  const action = sanitizeAction(entry.action || `${entry.method || "GET"} ${entry.pathname || "/"}`);
  const payload = {
    ts: new Date(entry.ts || Date.now()).toISOString(),
    action,
    method: String(entry.method || "").toUpperCase(),
    path: sanitizePath(entry.pathname || "/"),
    remote: sanitizeRemote(entry.remoteAddress || ""),
    queryKeys: sanitizeQueryKeys(entry.queryKeys || []),
  };

  fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(payload) + "\n", "utf8");
  return payload;
}

export function readAuditTail(options = {}) {
  const tail = normalizeTail(options.tail);
  if (!fs.existsSync(AUDIT_FILE)) {
    return { file: "admin-audit.log", count: 0, lines: [] };
  }

  const lines = fs.readFileSync(AUDIT_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-tail)
    .map(line => redactLogLine(line));
  return { file: "admin-audit.log", count: lines.length, lines };
}

export function buildAuditStatus(options = {}) {
  return {
    schemaVersion: 1,
    current: readAuditTail(options),
    privacy: [
      "Audit entries include method, route, query key names and remote address only.",
      "Request bodies, model keys, .env_* values and chat content are not written.",
    ],
  };
}

function normalizeTail(value) {
  const number = Number(value || 100);
  if (!Number.isFinite(number)) return 100;
  return Math.max(1, Math.min(500, Math.floor(number)));
}

function sanitizeAction(value) {
  return redactLogLine(String(value || "admin"))
    .replace(/[\r\n\t]/g, " ")
    .slice(0, MAX_ACTION_LENGTH);
}

function sanitizePath(value) {
  const pathname = String(value || "/").replace(/[\r\n\t]/g, "");
  return pathname.startsWith("/admin/") ? pathname : "/admin/unknown";
}

function sanitizeRemote(value) {
  return String(value || "")
    .replace(/[^0-9a-fA-F:.]/g, "")
    .slice(0, 80);
}

function sanitizeQueryKeys(keys) {
  return [...new Set(Array.from(keys).map(key => String(key).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)).filter(Boolean))]
    .slice(0, MAX_QUERY_KEYS);
}
