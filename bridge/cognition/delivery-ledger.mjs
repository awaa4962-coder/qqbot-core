import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { CFG } from "../config.mjs";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10000;
const TERMINAL = new Set(["sent", "silent", "failed", "cancelled", "resolved"]);
const STATES = new Set([...TERMINAL, "processing", "sending", "partial", "unknown", "interrupted"]);
const COUNTERS = ["attempts", "pending", "confirmed", "rejected", "uncertain"];
const HASH = /^[a-f0-9]{64}$/;

export function createChatDeliveryLedger(options = {}) {
  const filename = options.filename || path.join(CFG.dataRoot, ".qqfriend", "chat-delivery.json");
  const now = options.now || Date.now;
  const active = new Set();
  let cached = null;
  let stamp = "";
  const write = options.write || (value => writeJsonFileSync(filename, value, { durable: true }));

  function load() {
    const current = fileStamp(filename);
    if (cached && current === stamp) return cached;
    const missing = Symbol("missing");
    const value = readJsonFile(filename, missing);
    cached = value === missing ? { schema: 1, salt: "", records: {} } : validateState(value);
    stamp = current;
    return cached;
  }

  function commit(operation) {
    const current = load();
    const next = { ...current, records: { ...current.records } };
    const result = operation(next);
    write(next);
    cached = next;
    stamp = fileStamp(filename);
    return result;
  }

  function find(scope) {
    const state = load();
    const key = state.salt && eventKey(scope, state.salt);
    const row = key && state.records[key];
    return row ? project(key, row, active.has(key)) : null;
  }

  function claim(scope) {
    if (!sourceId(scope)) return { ok: true, key: "" };
    validateScope(scope);
    const previous = find(scope);
    if (previous) return { ok: false, reason: "reply_duplicate" };
    const key = commit(state => {
      prune(state.records, now(), active);
      if (Object.keys(state.records).length >= (options.maxRecords || MAX_RECORDS)) throw new Error("delivery_capacity");
      state.salt ||= randomBytes(32).toString("hex");
      const id = eventKey(scope, state.salt);
      state.records[id] = {
        surface: scope.surface, scopeHash: scopeHash(scope, state.salt), actorHash: hash(state.salt, ["user", String(scope.userId)]),
        status: "processing", outcome: "", createdAt: now(), updatedAt: now(),
        eventTime: finiteTime(scope.eventTime), attempts: 0, pending: 0, confirmed: 0, rejected: 0, uncertain: 0,
      };
      return id;
    });
    active.add(key);
    return { ok: true, key };
  }

  function update(key, operation) {
    if (!key) return;
    commit(state => {
      const row = state.records[key];
      if (!row) throw new Error("delivery_missing");
      state.records[key] = { ...operation({ ...row }), updatedAt: now() };
    });
  }

  function attempt(key) {
    update(key, row => ({ ...row, status: "sending", attempts: row.attempts + 1, pending: row.pending + 1 }));
  }

  function receipt(key, kind) {
    update(key, row => ({ ...row, status: "processing", pending: Math.max(0, row.pending - 1),
      confirmed: row.confirmed + (kind === "sent" ? 1 : 0), uncertain: row.uncertain + (kind === "unknown" ? 1 : 0) }));
  }

  function reject(key) { update(key, row => ({ ...row, rejected: row.rejected + 1 })); }

  function finish(key, outcome = "", cancelled = false) {
    if (!key) return;
    try {
      update(key, row => ({ ...row, outcome: safeOutcome(outcome), status: completedStatus(row, outcome, cancelled) }));
    } finally { active.delete(key); }
  }

  function forget(userId, persist = true) {
    const state = load();
    if (!state.salt) return 0;
    const actor = hash(state.salt, ["user", String(userId)]);
    if (!Object.values(state.records).some(row => row.actorHash === actor)) return 0;
    const clear = draft => {
      let changed = 0;
      for (const [key, row] of Object.entries(draft.records)) {
        if (row.actorHash === actor) { draft.records[key] = { ...row, actorHash: "", scopeHash: "" }; changed++; }
      }
      return changed;
    };
    if (!persist) { cached = { ...state, records: { ...state.records } }; return clear(cached); }
    return commit(clear);
  }

  function resolve(id, delivered) {
    if (!HASH.test(id) || active.has(id)) throw new Error("这条回复不存在或仍在处理");
    update(id, row => {
      if (!["unknown", "partial", "interrupted"].includes(project(id, row, false).status)) throw new Error("这条回复不需要核实");
      return { ...row, status: "resolved", resolution: delivered ? "checked_delivered" : "checked_not_delivered" };
    });
  }

  function cleanup() {
    const state = load();
    const expired = Object.entries(state.records).some(([key, row]) => expiredRecord(key, row, now(), active));
    if (!expired) return 0;
    return commit(draft => prune(draft.records, now(), active));
  }

  function snapshot(query = {}) {
    const state = load();
    const rows = Object.entries(state.records).filter(([, row]) => matches(row, query, state.salt))
      .map(([key, row]) => project(key, row, active.has(key))).filter(row => matchesStatus(row, query.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { health: "ready", persistent: true, total: rows.length, stored: Object.keys(state.records).length, capacity: options.maxRecords || MAX_RECORDS, retentionHours: 24,
      holdsUnresolved: true, storesContent: false, items: rows.slice(0, 50) };
  }

  return { claim, find, attempt, receipt, reject, finish, forget, resolve, cleanup, snapshot };
}

function completedStatus(row, outcome, cancelled) {
  if (row.pending || row.uncertain) return "unknown";
  if (row.confirmed && (row.rejected || cancelled || outcome === "error")) return "partial";
  if (cancelled) return "cancelled";
  if (row.rejected || outcome === "error") return "failed";
  if (row.confirmed) return "sent";
  return outcome === "silence" ? "silent" : "interrupted";
}

function project(id, row, active) {
  const pending = ["processing", "sending"].includes(row.status);
  const recovered = row.pending || row.uncertain ? "unknown" : row.confirmed ? "partial" : "interrupted";
  return { id, surface: row.surface, status: pending && !active ? recovered : row.status,
    outcome: row.outcome, createdAt: row.createdAt, updatedAt: row.updatedAt,
    attempts: row.attempts, confirmed: row.confirmed, uncertain: row.uncertain + row.pending,
    resolution: row.resolution || "", active };
}

function validateState(value) {
  if (!value || value.schema !== 1 || !HASH.test(value.salt) || !value.records || typeof value.records !== "object" || Array.isArray(value.records)) throw new Error("delivery_invalid");
  for (const [key, row] of Object.entries(value.records)) {
    validateRecord(key, row);
  }
  return value;
}

function validateRecord(key, row) {
  if (!HASH.test(key) || !row || !STATES.has(row.status) || !["group", "private"].includes(row.surface)) throw new Error("delivery_invalid");
  if (COUNTERS.some(field => !Number.isSafeInteger(row[field]) || row[field] < 0)) throw new Error("delivery_invalid");
  if (![row.createdAt, row.updatedAt, row.eventTime].every(value => Number.isFinite(value) && value >= 0)) throw new Error("delivery_invalid");
  if (![row.actorHash, row.scopeHash].every(value => value === "" || (typeof value === "string" && HASH.test(value)))) throw new Error("delivery_invalid");
  if (safeOutcome(row.outcome) !== row.outcome || ![undefined, "checked_delivered", "checked_not_delivered"].includes(row.resolution)) throw new Error("delivery_invalid");
}

function sourceId(scope) {
  const value = scope.messageId;
  if (value === undefined || value === null || value === "") return "";
  if (!["number", "string"].includes(typeof value) || !/^[\w-]{1,80}$/.test(String(value))) throw new Error("delivery_invalid_source");
  return String(value);
}
function validateScope(scope) {
  if (!["group", "private"].includes(scope.surface) || !/^\d{1,20}$/.test(String(scope.userId))) throw new Error("delivery_invalid_scope");
  if (scope.surface === "group" && !/^\d{1,20}$/.test(String(scope.groupId))) throw new Error("delivery_invalid_scope");
}
function finiteTime(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function hash(salt, parts) { return createHmac("sha256", salt).update(JSON.stringify(parts)).digest("hex"); }
function scopeHash(scope, salt) { return hash(salt, [scope.surface, String(scope.surface === "private" ? scope.userId : scope.groupId)]); }
function eventKey(scope, salt) { return sourceId(scope) ? hash(salt, [String(CFG.selfUin), scopeHash(scope, salt), String(scope.userId), sourceId(scope)]) : ""; }
function safeOutcome(value) { return ["reply", "silence", "error", "cancelled"].includes(value) ? value : ""; }

function matches(row, query, salt) {
  if (query.userId && row.actorHash !== hash(salt, ["user", String(query.userId)])) return false;
  if (query.groupId && row.scopeHash !== scopeHash({ surface: "group", groupId: query.groupId }, salt)) return false;
  return true;
}

function matchesStatus(row, status) {
  if (status === "needs-review") return ["unknown", "partial", "interrupted"].includes(row.status);
  return !status || status === "all" || row.status === status;
}

function prune(records, now, active) {
  let removed = 0;
  for (const [key, row] of Object.entries(records)) {
    if (expiredRecord(key, row, now, active)) { delete records[key]; removed++; }
  }
  return removed;
}

function expiredRecord(key, row, now, active) { return !active.has(key) && TERMINAL.has(row.status) && now - row.updatedAt > RETENTION_MS; }

function fileStamp(filename) {
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("delivery_invalid_file");
    return stat.mtimeNs + ":" + stat.size;
  }
  catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

let defaultLedger;
export function chatDeliveryLedger() { return defaultLedger ||= createChatDeliveryLedger(); }

export function cleanupChatDeliveries() {
  try { return chatDeliveryLedger().cleanup(); }
  catch { throw new Error("delivery_state_unavailable"); }
}

// Reuse the existing durable erasure boundary rather than a second privacy history.
export function inspectChatEvent(ctx, options = {}) {
  const timestamp = finiteTime(ctx.eventTime);
  const privacy = (options.readPrivacy || summaryPrivacy)();
  const cutoff = Number(privacy.users[String(ctx.user_id)] || 0);
  if (cutoff && (!timestamp || timestamp <= cutoff)) return "forgotten_event";
  if (timestamp > 0 && (options.now ?? Date.now()) - timestamp > RETENTION_MS) return "stale_event";
  if (options.checkDelivery === false) return "";
  const row = (options.ledger || chatDeliveryLedger()).find({ surface: ctx.message_type, userId: ctx.user_id, groupId: ctx.group_id, messageId: ctx.message_id });
  return row ? "reply_duplicate" : "";
}

export function buildChatDeliverySnapshot(query = {}) {
  try { return chatDeliveryLedger().snapshot(query); }
  catch { return { health: "degraded", error: "发送状态无法读取，已停止有编号的聊天请求。", items: [], total: 0 }; }
}

export function resolveChatDelivery(payload) {
  if (!["confirm-delivered", "confirm-not-delivered"].includes(payload?.action)) throw new Error("不支持的核实操作");
  try { chatDeliveryLedger().resolve(String(payload.id || ""), payload.action === "confirm-delivered"); }
  catch { throw new Error("无法核实这条状态：记录不存在、仍在处理或状态文件不可用"); }
  return buildChatDeliverySnapshot();
}
