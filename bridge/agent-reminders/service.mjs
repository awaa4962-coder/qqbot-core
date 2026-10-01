import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { clearInterval, setInterval } from "node:timers";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";
import { containsSensitiveText } from "../privacy.mjs";

const MINUTE = 60000;
const HORIZON = 7 * 86400000;
const GRACE = 5 * MINUTE;
const MAX_ROWS = 128;
const MAX_STORED = 256;
const MAX_BYTES = 256 * 1024;
const MAX_CLOCK = 8640000000000000 - HORIZON;
const REF = /^rem_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(["armed", "sending", "sent", "failed", "unknown", "partial", "cancelled", "expired"]);
const RECEIPTS = new Set(["sent", "failed", "unknown", "partial"]);
const liveClaims = new Map();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const unavailable = () => ({ status: "unavailable", reason: "reminder_store_unavailable" });
const denied = () => ({ status: "denied", reason: "not_allowed" });
const invalid = () => ({ status: "invalid_arguments", reason: "invalid_reminder_arguments" });
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CLOCK;
const validDelay = value => Number.isInteger(value) && value >= 1 && value <= 10080;
const beijingDateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", calendar: "gregory", numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function fields(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => typeof key === "string" &&
    [...required, ...optional].includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
function identity(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : null;
  return typeof value === "string" && /^(?:0|-?[1-9][0-9]{0,19})$/.test(value) ? value : null;
}
function qqIdentity(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}
function boundScope(value) {
  if (!fields(value, ["surface", "groupId", "userId"], ["messageId", "currentMessageId"]) || value.surface !== "group") return null;
  for (const key of ["messageId", "currentMessageId"]) {
    if (Object.hasOwn(value, key) && value[key] !== undefined && identity(value[key]) === null) return null;
  }
  const groupId = qqIdentity(value.groupId), userId = qqIdentity(value.userId);
  return groupId !== null && userId !== null ? Object.freeze({ surface: "group", groupId, userId }) : null;
}
function sameScope(a, b) { return a && b && a.groupId === b.groupId && a.userId === b.userId; }
function containsAuthCredentials(text) {
  if (/\bDigest\s+["']?(?:username|realm|nonce|uri|response|cnonce|opaque|algorithm|qop|nc)["']?\s*=/i.test(text)) return true;
  for (const [, token] of text.matchAll(/\bBasic\s+["']?([a-z0-9+/]+={0,2})(?=$|[^a-z0-9+/=])/gi)) {
    const decoded = Buffer.from(token, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") === token.replace(/=+$/, "") && decoded.includes(0x3a)) return true;
  }
  return false;
}
function safeText(text, limit = 300) {
  return typeof text === "string" && text.trim() === text && text.length > 0 && [...text].length <= limit &&
    Buffer.byteLength(text, "utf8") <= limit * 4 && !containsSensitiveText(text) && !containsAuthCredentials(text) &&
    !/[\p{Cc}\p{Cf}\p{Cs}<>]/u.test(text) &&
    !/\[\s*CQ\s*:|\b(?:sk|ghp|github_pat)[-_][a-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[a-z0-9-]{8,}|https?:\/\/[^\s/]+:[^\s/]+@|\b(?:bearer|authorization)\s+\S+|\b(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]/i.test(text);
}
function validZone(zone) {
  if (zone === "Z") return true;
  const hours = +zone.slice(1, 3), minutes = +zone.slice(4);
  return hours <= 14 && minutes <= 59 && (hours !== 14 || minutes === 0);
}
function isoTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second, , zone] = match;
  if (+m < 1 || +m > 12 || +d < 1 || +d > new Date(Date.UTC(+y, +m, 0)).getUTCDate() ||
      +h > 23 || +minute > 59 || +second > 59) return null;
  if (!validZone(zone)) return null;
  const time = Date.parse(value);
  return integer(time) ? time : null;
}
function beijingTime(value) {
  const date = new Date(value);
  const parts = Object.fromEntries(beijingDateTime.formatToParts(date).map(part => [part.type, part.value]));
  const fraction = date.getUTCMilliseconds();
  const suffix = fraction === 0 ? "" : `.${String(fraction).padStart(3, "0")}`;
  return `${parts.year}\u5e74${parts.month}\u6708${parts.day}\u65e5 ${parts.hour}:${parts.minute}:${parts.second}${suffix}`;
}
function preview(action, parameters) {
  return action === "create"
    ? `\u521b\u5efa\u63d0\u9192\uff1a\u5317\u4eac\u65f6\u95f4 ${beijingTime(parameters.dueAt)}\uff0c\u4ec5\u5728\u5f53\u524d\u7fa4\u63d0\u9192\u672c\u4eba\u3002\u5185\u5bb9\uff1a${parameters.text}`
    : `\u53d6\u6d88\u672c\u4eba\u5728\u5f53\u524d\u7fa4\u7684\u63d0\u9192\uff1a${parameters.ref}\u3002`;
}
function validParameters(action, parameters) {
  if (action === "create") return fields(parameters, ["text", "dueAt"]) && safeText(parameters.text) && isoTime(parameters.dueAt) !== null;
  if (action === "cancel") return fields(parameters, ["ref"]) && typeof parameters.ref === "string" && REF.test(parameters.ref);
  return false;
}
function preparedOperation(value, sourceIdentity) {
  if (!fields(value, ["domain", "action", "parameters", "baseline", "preview"]) || value.domain !== "reminder" ||
      !fields(value.baseline, ["revision", "sourceIdentity"]) || !integer(value.baseline.revision) ||
      value.baseline.sourceIdentity !== sourceIdentity) return null;
  if (!validParameters(value.action, value.parameters)) return null;
  if (value.preview !== preview(value.action, value.parameters) || !safeText(value.preview, 1200)) return null;
  const snapshot = copy(value);
  return JSON.stringify(snapshot).length <= 4096 ? snapshot : null;
}
function active(row) { return row.state === "armed" || row.state === "sending"; }
function reserved(row) { return active(row) || row.state === "unknown" || row.state === "partial"; }
function validRowIdentity(row) {
  return typeof row.ref === "string" && REF.test(row.ref) && typeof row.keyHash === "string" && HASH.test(row.keyHash) &&
    (row.operationHash === null || typeof row.operationHash === "string" && HASH.test(row.operationHash)) &&
    STATES.has(row.state) && typeof row.cancelRequested === "boolean";
}
function validRowScope(row) {
  if (row.scope === null) return row.text === "" && row.operationHash === null && row.state !== "armed" && row.cancelRequested;
  return fields(row.scope, ["surface", "groupId", "userId"]) && Boolean(boundScope(row.scope)) &&
    typeof row.scope.groupId === "string" && typeof row.scope.userId === "string" &&
    (row.text === "" && !active(row) || safeText(row.text));
}
function validRowDeadline(row, updatedAt) {
  return integer(row.createdAt) && integer(row.dueAt) && row.dueAt > row.createdAt &&
    row.dueAt - row.createdAt <= HORIZON && integer(row.privacyCutoff) && row.createdAt > row.privacyCutoff && row.createdAt <= updatedAt;
}
function validRowProgress(row, updatedAt) {
  if (row.claimedAt !== null && (!integer(row.claimedAt) || row.claimedAt < row.dueAt || row.claimedAt > updatedAt)) return false;
  if (row.state === "armed") return row.claimedAt === null && row.finishedAt === null && !row.cancelRequested;
  if (row.state === "sending") return row.claimedAt !== null && row.finishedAt === null;
  return integer(row.finishedAt) && row.finishedAt >= (row.claimedAt ?? row.createdAt) && row.finishedAt <= updatedAt &&
    (!RECEIPTS.has(row.state) || row.claimedAt !== null);
}
function validRow(row, updatedAt) {
  return fields(row, ["ref", "keyHash", "operationHash", "scope", "text", "createdAt", "dueAt", "privacyCutoff", "state", "claimedAt", "finishedAt", "cancelRequested"]) &&
    validRowIdentity(row) && validRowScope(row) && validRowDeadline(row, updatedAt) && validRowProgress(row, updatedAt);
}
function validRows(rows, updatedAt) {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > MAX_STORED ||
      Reflect.ownKeys(rows).length !== rows.length + 1) return false;
  for (let i = 0; i < rows.length; i++) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(rows, String(i)) || {}, "value") || !validRow(rows[i], updatedAt)) return false;
  }
  return new Set(rows.map(row => row.ref)).size === rows.length && new Set(rows.map(row => row.keyHash)).size === rows.length &&
    rows.filter(reserved).length <= MAX_ROWS && rows.every(row => !reserved(row) || row.scope === null ||
      rows.filter(other => reserved(other) && other.scope?.userId === row.scope.userId).length <= 8);
}
function validState(state) {
  return fields(state, ["version", "salt", "revision", "updatedAt", "rows"]) && state.version === 1 &&
    typeof state.salt === "string" && /^[a-f0-9]{32}$/.test(state.salt) && integer(state.revision) && integer(state.updatedAt) &&
    validRows(state.rows, state.updatedAt);
}
function requestedParameters(args, at) {
  if (args.action === "cancel") return fields(args, ["action", "ref"]) && typeof args.ref === "string" && REF.test(args.ref)
    ? { ref: args.ref } : null;
  if (args.action !== "create" || !safeText(args.text) || Object.hasOwn(args, "ref") ||
      Object.hasOwn(args, "delay_minutes") === Object.hasOwn(args, "when")) return null;
  let dueAt;
  if (Object.hasOwn(args, "delay_minutes")) {
    if (!validDelay(args.delay_minutes)) return null;
    dueAt = at + args.delay_minutes * MINUTE;
  } else dueAt = isoTime(args.when);
  if (dueAt === null || dueAt - at < MINUTE || dueAt - at > HORIZON) return null;
  return { text: args.text, dueAt: new Date(dueAt).toISOString() };
}
function projection(row, own) {
  return { ref: row.ref, phase: row.state, dueAt: new Date(row.dueAt).toISOString(), createdAt: row.createdAt,
    claimedAt: row.claimedAt, finishedAt: row.finishedAt, cancelRequested: row.cancelRequested,
    ...(own && row.text ? { text: row.text } : {}) };
}
function receiptOutcome(receipt) {
  try {
    const descriptor = receipt && typeof receipt === "object" ? Object.getOwnPropertyDescriptor(receipt, "status") : null;
    return descriptor && Object.hasOwn(descriptor, "value") && RECEIPTS.has(descriptor.value) ? descriptor.value : "unknown";
  } catch { return "unknown"; }
}
function committedReminderView(result) {
  if (result.status === "applied") return { status: "applied", ref: result.ref,
    text: result.reused ? "\u8be5\u63d0\u9192\u5df2\u8bb0\u5f55\uff0c\u672a\u518d\u6b21\u53d1\u9001" :
      result.phase === "armed" ? "\u5df2\u521b\u5efa\u63d0\u9192\uff0c\u5c1a\u672a\u53d1\u9001" :
        result.phase === "sending" ? "\u5df2\u8bf7\u6c42\u53d6\u6d88\uff0c\u53d1\u9001\u53ef\u80fd\u5df2\u7ecf\u5f00\u59cb" : "\u5df2\u53d6\u6d88\u63d0\u9192" };
  if (result.status === "unknown") return { status: "unknown", text: "\u63d0\u9192\u53d8\u66f4\u7ed3\u679c\u672a\u77e5\uff0c\u8bf7\u52ff\u91cd\u8bd5" };
  return { status: "not_applied", text: "\u672a\u6267\u884c\u63d0\u9192\u53d8\u66f4" };
}
function fitsReminderCapacity(state, candidate) {
  // Budget-only projection reserves future claim/receipt timestamps; it is never persisted.
  const budget = { ...state, revision: MAX_CLOCK, updatedAt: MAX_CLOCK,
    rows: [...state.rows, candidate].map(row => ({ ...row, state: "cancelled", claimedAt: MAX_CLOCK,
      finishedAt: MAX_CLOCK, cancelRequested: false })) };
  return Buffer.byteLength(JSON.stringify(budget), "utf8") <= MAX_BYTES;
}

function finishRow(row, state, at) { row.state = state; row.finishedAt = at; }
function scrub(row) { row.scope = null; row.text = ""; row.operationHash = null; row.cancelRequested = true; }
function scrubLocalRevocations(state, at, localRevocations) {
  for (const row of state.rows) {
    const cutoffAt = row.scope && localRevocations.get(row.scope.userId);
    if (cutoffAt === undefined || cutoffAt === null || row.createdAt > cutoffAt) continue;
    if (row.state === "armed") finishRow(row, "cancelled", at);
    scrub(row);
  }
}

function createReminderLedger({ configured, destination, now, read, write, recover }) {
  const empty = { version: 1, salt: randomBytes(16).toString("hex"), revision: 0, updatedAt: 0, rows: [] };
  let fault = false, seen = false, lastRevision = -1, lastHash = null, lastTime = 0;
  function fail() { fault = true; return null; }
  function time() {
    try { const at = now(); if (!integer(at) || at < lastTime) return fail(); lastTime = at; return at; }
    catch { return fail(); }
  }
  function load() {
    if (!configured || fault) return null;
    try {
      const state = read(destination, null, { maxBytes: MAX_BYTES });
      if (state === null || state === undefined) {
        if (seen) return fail();
        return copy(empty);
      }
      seen = true;
      if (!validState(state) || Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_BYTES) return fail();
      const signature = hash(state);
      if (state.revision < lastRevision || state.revision === lastRevision && signature !== lastHash) return fail();
      lastRevision = state.revision; lastHash = signature;
      return copy(state);
    } catch (error) {
      if (error?.code === "ENOENT" && !seen) return copy(empty);
      return fail();
    }
  }
  function update(change) {
    const state = load(), at = time();
    if (!state || at === null || at < state.updatedAt) { fail(); return unavailable(); }
    const before = JSON.stringify(state);
    recover(state, at);
    const result = change(state, at);
    if (JSON.stringify(state) === before) return result;
    state.updatedAt = at; state.revision++;
    if (!validState(state)) { fail(); return unavailable(); }
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_BYTES) return { status: "not_applied", reason: "reminder_capacity" };
    // No rollback or retry: even a throwing writer may already have renamed its new state.
    seen = true;
    const saved = write(destination, copy(state), { durable: true });
    if (saved === false || saved && typeof saved.then === "function") throw new Error("unverified_write");
    const verified = read(destination, null, { maxBytes: MAX_BYTES });
    if (!validState(verified) || hash(verified) !== hash(state)) throw new Error("unverified_write");
    lastRevision = state.revision; lastHash = hash(state);
    return result;
  }
  function mutate(change) {
    if (!load()) return unavailable();
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(`${destination}.lock`, "wx", 0o600);
    } catch (error) { return error?.code === "EEXIST" ? { status: "unavailable", reason: "reminder_store_busy" } : (fail(), unavailable()); }
    let result = unavailable();
    try {
      result = update(change);
    } catch { fail(); result = { status: "unknown", reason: "reminder_persistence_unknown" }; }
    finally {
      try { fs.closeSync(descriptor); fs.unlinkSync(`${destination}.lock`); }
      catch { fail(); result = { status: "unknown", reason: "reminder_persistence_unknown" }; }
    }
    return result;
  }
  return { load, mutate, time, get fault() { return fault; }, get lastTime() { return lastTime; } };
}

// read/write are synchronous JSON-store hooks. A successful write must be a durable commit.
// Permission returns exactly true; cutoff returns a persisted, nonnegative epoch-millisecond value.
// deliver({ref, scope, text, createdAt, dueAt}, {signal}) settles only with the actual transport.
export function createReminderService({ filename, now = Date.now, read = readJsonFile, write = writeJsonFileSync,
  isPermitted, readPrivacyCutoff, deliver } = {}) {
  const configured = typeof filename === "string" && filename.trim() && typeof now === "function" &&
    typeof read === "function" && typeof write === "function";
  const destination = configured ? path.resolve(filename) : null;
  const sourceIdentity = hash(["finite-reminders-v1", destination]);
  const enabled = Boolean(configured && typeof isPermitted === "function" && typeof readPrivacyCutoff === "function" && typeof deliver === "function");
  const pending = new Map(), localRevocations = new Map();
  const ledger = createReminderLedger({ configured, destination, now, read, write, recover });
  const { load, time, mutate } = ledger;
  const delivery = createReminderDelivery({ enabled, destination, ledger, pending, localRevocations, cutoff, permitted, deliver });
  function recover(state, at) {
    for (const row of state.rows) if (row.state === "sending" && !liveClaims.has(`${destination}:${row.ref}`)) finishRow(row, "unknown", at);
    scrubLocalRevocations(state, at, localRevocations);
  }
  function cutoff(scope) {
    if (!enabled) return null;
    try { const value = readPrivacyCutoff(Object.freeze({ ...scope })); return integer(value) ? value : null; }
    catch { return null; }
  }
  function permitted(scope) {
    if (!enabled) return false;
    try { return isPermitted(Object.freeze({ ...scope })) === true; } catch { return false; }
  }
  function prepare(scope, args) {
    scope = boundScope(scope);
    if (!scope || !permitted(scope, "prepare")) return denied();
    if (!load()) return unavailable();
    if (!fields(args, ["action"], ["text", "delay_minutes", "when", "ref"])) return invalid();
    const at = time(), privacyCutoff = cutoff(scope);
    if (at === null) return unavailable();
    if (privacyCutoff === null || privacyCutoff >= at) return denied();
    const parameters = requestedParameters(args, at);
    if (!parameters) return invalid();
    return { status: "ready", operation: { domain: "reminder", action: args.action, parameters,
      baseline: { revision: privacyCutoff, sourceIdentity }, preview: preview(args.action, parameters) } };
  }
  function commitPrepared(scope, operation, settings = {}) {
    scope = boundScope(scope);
    if (!scope || delivery.stopping || !permitted(scope, "commit")) return denied();
    operation = preparedOperation(operation, sourceIdentity);
    if (!operation || !fields(settings, ["idempotencyKey"]) || !safeText(settings.idempotencyKey, 128)) return invalid();
    return mutate((state, at) => {
      const privacyCutoff = cutoff(scope);
      if (privacyCutoff === null || !permitted(scope, "commit")) return denied();
      const keyHash = createHmac("sha256", state.salt).update(JSON.stringify([scope, settings.idempotencyKey])).digest("hex");
      const operationHash = hash(operation);
      const previous = state.rows.find(row => row.keyHash === keyHash);
      if (previous) return previous.operationHash === operationHash && sameScope(scope, previous.scope)
        ? { status: "applied", reused: true, ...projection(previous, false) }
        : { status: "not_applied", reason: "idempotency_conflict" };
      if (privacyCutoff !== operation.baseline.revision || privacyCutoff >= at) return { status: "not_applied", reason: "privacy_changed" };
      if (operation.action === "cancel") return cancelRow(state, scope, operation.parameters.ref, at);
      const dueAt = isoTime(operation.parameters.dueAt);
      if (dueAt <= at || dueAt - at > HORIZON) return { status: "not_applied", reason: "deadline_changed" };
      state.rows = state.rows.filter(row => reserved(row) || at <= row.dueAt + GRACE + HORIZON);
      if (state.rows.length >= MAX_STORED || state.rows.filter(reserved).length >= MAX_ROWS ||
          state.rows.filter(row => reserved(row) && row.scope?.userId === scope.userId).length >= 8)
        return { status: "not_applied", reason: "reminder_capacity" };
      const row = { ref: `rem_${randomBytes(16).toString("hex")}`, keyHash, operationHash, scope: { ...scope },
        text: operation.parameters.text, createdAt: at, dueAt, privacyCutoff, state: "armed", claimedAt: null, finishedAt: null, cancelRequested: false };
      if (!fitsReminderCapacity(state, row)) return { status: "not_applied", reason: "reminder_capacity" };
      state.rows.push(row);
      return { status: "applied", ...projection(row, false) };
    });
  }
  function commit(scope, operation, settings = {}) {
    return committedReminderView(commitPrepared(scope, operation, settings));
  }
  function list(scope) {
    const own = scope !== undefined;
    if (own) { scope = boundScope(scope); if (!scope || !permitted(scope, "list")) return { status: "unavailable", reason: "not_allowed", items: [] }; }
    const state = load();
    if (!state) return { ...unavailable(), items: [] };
    scrubLocalRevocations(state, Math.max(ledger.lastTime, state.updatedAt), localRevocations);
    const privacyCutoff = own ? cutoff(scope) : null;
    if (own && privacyCutoff === null) return { status: "unavailable", reason: "privacy_unavailable", items: [] };
    return { status: "ready", items: state.rows.filter(row => !own || sameScope(row.scope, scope) && row.createdAt > privacyCutoff && privacyCutoff >= row.privacyCutoff)
      .map(row => projection(row, own)) };
  }
  function cancelRow(state, scope, ref, at) {
    const row = state.rows.find(item => item.ref === ref && sameScope(item.scope, scope));
    if (!row) return { status: "not_applied", reason: "reminder_not_found" };
    if (row.state === "sending") { row.cancelRequested = true; liveClaims.get(`${destination}:${ref}`)?.controller.abort(); }
    else if (row.state === "armed") { row.cancelRequested = true; finishRow(row, "cancelled", at); }
    else if (row.state !== "cancelled") return { status: "not_applied", ...projection(row, false) };
    return { status: "applied", ...projection(row, false) };
  }
  function cancel(scope, ref) {
    scope = boundScope(scope);
    if (typeof ref !== "string" || !REF.test(ref)) return { status: "unavailable", text: "\u63d0\u9192\u4e0d\u53ef\u7528" };
    if (!scope || !permitted(scope, "cancel")) return { status: "unavailable", ref, text: "\u63d0\u9192\u4e0d\u53ef\u7528" };
    const result = mutate((state, at) => cancelRow(state, scope, ref, at));
    if (result.status === "unknown" || ["sending", "sent", "partial", "unknown"].includes(result.phase))
      return { status: "unknown", ref, text: "\u63d0\u9192\u53ef\u80fd\u6b63\u5728\u53d1\u9001\u6216\u5df2\u53d1\u9001\uff0c\u672a\u91cd\u65b0\u5c1d\u8bd5\u53d1\u9001" };
    if (result.status === "applied") return { status: "cancelled", ref, text: "\u5df2\u53d6\u6d88\u63d0\u9192" };
    return { status: "unavailable", ref, text: "\u63d0\u9192\u4e0d\u53ef\u7528" };
  }
  function revokeUser(uid, settings = {}) {
    uid = qqIdentity(uid);
    if (uid === null || !fields(settings, [], ["persist"]) ||
        Object.hasOwn(settings, "persist") && typeof settings.persist !== "boolean") return false;
    // Abort actual sends even when the disk is damaged; never release their live locks here.
    for (const flight of liveClaims.values()) if (flight.destination === destination && flight.userId === uid) flight.controller.abort();
    const currentState = load(), currentAt = time();
    if (!currentState || currentAt === null) return false;
    if (currentState.rows.some(row => row.scope?.userId === uid)) localRevocations.set(uid, currentAt);
    if (settings.persist === false) return true;
    const result = mutate((state, at) => {
      for (const row of state.rows) if (row.scope?.userId === uid) {
        if (row.state === "armed") finishRow(row, "cancelled", at); scrub(row);
      }
      return { status: "applied" };
    });
    if (result.status === "applied") localRevocations.delete(uid);
    return result.status === "applied";
  }
  return { prepare, commit, list, cancel, revokeUser, tick: delivery.tick, start: delivery.start, stop: delivery.stop };
}

function createReminderDelivery({ enabled, destination, ledger, pending, localRevocations, cutoff, permitted, deliver }) {
  const { load, time, mutate } = ledger;
  let timer = null, ticking = null, stopping = false;
  function eligible(row, at) {
    if (!row.scope || !permitted(row.scope, "deliver")) return false;
    if (row.createdAt <= (localRevocations.get(row.scope.userId) ?? -1)) return false;
    const privacyCutoff = cutoff(row.scope);
    return privacyCutoff !== null && privacyCutoff >= row.privacyCutoff && privacyCutoff < row.createdAt &&
      at !== null && at >= row.dueAt && at <= row.dueAt + GRACE && !row.cancelRequested;
  }
  function claimNext(state, at) {
    for (const row of state.rows) {
      if (row.state !== "armed") continue;
      const privacyCutoff = cutoff(row.scope);
      if (privacyCutoff === null) continue;
      if (privacyCutoff < row.privacyCutoff || privacyCutoff >= row.createdAt) {
        finishRow(row, "cancelled", at); scrub(row); continue;
      }
      if (!permitted(row.scope)) { finishRow(row, "cancelled", at); row.text = ""; continue; }
      if (at > row.dueAt + GRACE) { finishRow(row, "expired", at); row.text = ""; continue; }
      if (at < row.dueAt) continue;
      if ([...liveClaims.values()].some(flight => flight.destination === destination && flight.userId === row.scope.userId)) continue;
      row.state = "sending"; row.claimedAt = at;
      return copy(row);
    }
    return null;
  }
  async function runTick() {
    let delivered = 0, attempted = 0;
    while (!stopping && !ledger.fault) {
      let job = null;
      const claimed = mutate((state, at) => {
        job = claimNext(state, at);
        return { status: "applied" };
      });
      if (claimed.status !== "applied") return claimed;
      if (!job) break;
      if (stopping || ledger.fault || !eligible(job, time())) {
        const cancelled = mutate((state, at) => {
          const row = state.rows.find(item => item.ref === job.ref);
          if (row) { finishRow(row, "cancelled", at); scrub(row); }
          return { status: "applied" };
        });
        if (cancelled.status !== "applied") return cancelled;
        continue;
      }
      const controller = new AbortController();
      const flight = { controller, userId: job.scope.userId, destination };
      pending.set(job.ref, flight); liveClaims.set(`${destination}:${job.ref}`, flight);
      try {
        let receipt;
        try {
          receipt = await deliver(Object.freeze({ ref: job.ref, scope: Object.freeze({ ...job.scope }), text: job.text,
            createdAt: job.createdAt, dueAt: new Date(job.dueAt).toISOString() }), Object.freeze({ signal: controller.signal }));
        } catch { receipt = null; }
        const outcome = receiptOutcome(receipt);
        const finished = mutate((state, at) => {
          const row = state.rows.find(item => item.ref === job.ref);
          if (!row || row.state !== "sending") return { status: "unknown" };
          finishRow(row, outcome, at); return { status: "applied" };
        });
        if (finished.status !== "applied") return { status: "unknown", reason: "reminder_receipt_unknown" };
        attempted++;
        if (outcome === "sent") delivered++;
      } finally { pending.delete(job.ref); liveClaims.delete(`${destination}:${job.ref}`); }
    }
    return { status: "ok", delivered, attempted, pending: pending.size };
  }
  function tick() {
    if (!enabled || stopping) return Promise.resolve(denied());
    if (ledger.fault) return Promise.resolve(unavailable());
    if (ticking) return ticking;
    // Defer the worker so concurrent callers see the same promise before any callback runs.
    ticking = Promise.resolve().then(runTick).finally(() => { ticking = null; });
    return ticking;
  }
  function start() {
    if (!enabled || ledger.fault || pending.size) return denied();
    if (timer) return { status: "started" };
    if (!load()) return unavailable();
    stopping = false;
    timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
    timer.unref?.();
    void tick().catch(() => {});
    return { status: "started" };
  }
  function stop(settings = {}) {
    stopping = true; clearInterval(timer); timer = null;
    for (const flight of pending.values()) flight.controller.abort();
    return drainReminderTransport(ticking, pending, settings);
  }
  return { tick, start, stop, get stopping() { return stopping; } };
}

async function drainReminderTransport(ticking, pending, settings) {
  if (!ticking && !pending.size) return true;
  const value = fields(settings, [], ["drainMs"]) ? settings.drainMs ?? 10000 : 10000;
  const drainMs = Number.isFinite(value) ? Math.max(0, Math.min(10000, value)) : 10000;
  let timeout;
  try {
    return await Promise.race([(ticking || Promise.resolve()).then(() => pending.size === 0, () => pending.size === 0),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), drainMs); })]);
  } finally { clearTimeout(timeout); }
}
