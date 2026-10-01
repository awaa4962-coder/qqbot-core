import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { types } from "node:util";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";

const TTL_MS = 300000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 128;
const MAX_BYTES = 1024 * 1024;
const MAX_OPERATION = 4096;
const MISSING = Symbol("missing");
const PROCESS_INSTANCE = randomBytes(16).toString("hex");
const PROCESS_SECRET = randomBytes(32);
const observedStores = new Map();
const deferredRevocations = new Map();
const HASH = /^[a-f0-9]{64}$/;
const REF = /^cf_[a-f0-9]{32}$/;
const INSTANCE = /^[a-f0-9]{32}$/;
const TERMINAL = new Set(["applied", "not_applied", "unknown", "revoked", "expired", "invalidated"]);
const COLLECTABLE = new Set(["applied", "not_applied", "revoked", "expired", "invalidated"]);
const RESULTS = new Set(["applied", "not_applied", "unknown"]);
const ACTIONS = Object.freeze({ personal: ["set_name", "set_style", "memory_create", "memory_update", "memory_remove"],
  reminder: ["create", "cancel"] });
const ROW_KEYS = ["ref", "ownerKey", "userKey", "messageId", "operationHash", "bindingHash", "seal", "domain", "action",
  "instance", "createdAt", "expiresAt", "status", "finishedAt", "operation", "binding", "text"];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () => ({ status: "unavailable" });
const invalid = () => ({ status: "invalid_arguments" });
const outcome = (result, changed = false) => ({ result, changed });
const isHash = value => typeof value === "string" && HASH.test(value);
const validAction = (domain, action) => Object.hasOwn(ACTIONS, domain) && ACTIONS[domain].includes(action);
const active = row => ["pending", "executing"].includes(row.status);

// Descriptors are read before values: no getter, proxy, toJSON or inherited input is evaluated.
function fields(value) {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" ||
      !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) throw new TypeError("Invalid fields");
  return Object.fromEntries(Object.keys(descriptors).sort().map(key => [key, descriptors[key].value]));
}

function snapshot(value, budget = { chars: 0 }, depth = 0) {
  if (depth > 8) throw new TypeError("Invalid depth");
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) return value;
  if (typeof value === "string") {
    budget.chars += value.length;
    if (budget.chars > MAX_BYTES) throw new TypeError("Invalid size");
    return value;
  }
  if (Array.isArray(value)) return snapshotArray(value, budget, depth);
  const own = fields(value);
  if (Object.keys(own).length > 32) throw new TypeError("Invalid field count");
  return Object.fromEntries(Object.entries(own).map(([key, item]) => {
    budget.chars += key.length;
    if (budget.chars > MAX_BYTES) throw new TypeError("Invalid size");
    return [key, snapshot(item, budget, depth + 1)];
  }));
}
function snapshotArray(value, budget, depth) {
  if (types.isProxy(value) || value.length > MAX_ROWS) throw new TypeError("Invalid array");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw new TypeError("Invalid array fields");
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[index];
    if (!item || !Object.hasOwn(item, "value") || !item.enumerable) throw new TypeError("Invalid array item");
    return snapshot(item.value, budget, depth + 1);
  });
}

function exact(value, required, optional = []) {
  return value && !Array.isArray(value) && typeof value === "object" && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function decimal(value, signed = false) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return (signed ? /^(?:0|-?[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(text) ? text : null;
}
function scopeKeys(value) {
  const scope = fields(value);
  if (!exact(scope, ["surface", "groupId", "userId"]) || scope.surface !== "group") throw new TypeError("Invalid scope");
  const userId = decimal(scope.userId);
  const groupId = decimal(scope.groupId);
  if (!userId || !groupId) throw new TypeError("Invalid identity");
  return { ownerKey: hash(["confirmation-owner", groupId, userId]), userKey: hash(["confirmation-user", userId]) };
}
function safeText(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
    !/\[CQ:|<\/?(?:think|analysis|reasoning|script)\b|(?:api[_-]?key|token|password|secret)\s*[:=]|\bBearer\s+|\bsk-[a-z0-9]{8}|(?:[a-z]:\\|\\\\|\/(?:home|root|etc|tmp|var|users)\/)/i.test(value);
}
function safeOperationPreview(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1200) return false;
  const body = value.replace(/^\n+|\n+$/g, "");
  return safeText(body.replace(/\n/g, " "), 1200) && safeText(body.replace(/\n/g, ""), 1200);
}
function revision(value) {
  return integer(value) || (typeof value === "string" && /^[a-z0-9_.:-]{1,128}$/i.test(value));
}
function validBinding(value) {
  return exact(value, ["privacyRevision", "userRevision", "sourceIdentity"]) &&
    revision(value.privacyRevision) && revision(value.userRevision) && typeof value.sourceIdentity === "string" && HASH.test(value.sourceIdentity);
}
function dueAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const at = Date.parse(value);
  return integer(at) && new Date(at).toISOString() === value;
}
function validOperation(value) {
  if (!exact(value, ["domain", "action", "parameters", "baseline", "preview"]) ||
      !validAction(value.domain, value.action) || !validBaseline(value.baseline) ||
      !safeOperationPreview(value.preview) || JSON.stringify(value).length > MAX_OPERATION) return false;
  return value.domain === "reminder" ? validReminderParameters(value.action, value.parameters) : validPersonalParameters(value.action, value.parameters);
}
function validBaseline(value) {
  return exact(value, ["revision", "sourceIdentity"]) && revision(value.revision) && isHash(value.sourceIdentity);
}
function validReminderParameters(action, p) {
  return action === "create" ? exact(p, ["text", "dueAt"]) && safeText(p.text, 300) && dueAt(p.dueAt) :
    exact(p, ["ref"]) && typeof p.ref === "string" && /^rem_[a-f0-9]{32}$/.test(p.ref);
}
function validNewMemory(p) {
  return exact(p, ["title", "text"], ["ttlDays"]) && safeText(p.title, 32) && safeText(p.text, 300) &&
    (!Object.hasOwn(p, "ttlDays") || (integer(p.ttlDays) && p.ttlDays >= 1 && p.ttlDays <= 90));
}
function validNoteId(value) { return typeof value === "string" && /^[a-f0-9]{12}$/.test(value); }
function validPersonalParameters(action, p) {
  switch (action) {
    case "set_name": return exact(p, ["value"]) && safeText(p.value, 16);
    case "set_style": return exact(p, ["value"]) && safeText(p.value, 300);
    case "memory_create": return validNewMemory(p);
    case "memory_update": return exact(p, ["noteId", "text"]) && validNoteId(p.noteId) && safeText(p.text, 300);
    case "memory_remove": return exact(p, ["noteId"]) && validNoteId(p.noteId);
    default: return false;
  }
}
function seal(row) {
  return createHmac("sha256", PROCESS_SECRET).update(JSON.stringify([row.ref, row.ownerKey, row.userKey, row.messageId,
    row.operationHash, row.bindingHash, row.domain, row.action, row.instance, row.createdAt, row.expiresAt])).digest("hex");
}
function validRow(row, updatedAt) {
  if (!exact(row, ROW_KEYS) || !validRowIdentity(row) || !validRowClock(row, updatedAt) ||
      (row.instance === PROCESS_INSTANCE && row.seal !== seal(row)) || !validReceiptText(row.text)) return false;
  return TERMINAL.has(row.status) ? validTerminalRow(row, updatedAt) : validActiveRow(row);
}
function validRowIdentity(row) {
  return typeof row.ref === "string" && REF.test(row.ref) &&
    [row.ownerKey, row.userKey, row.operationHash, row.bindingHash, row.seal].every(isHash) &&
    typeof row.messageId === "string" && decimal(row.messageId, true) === row.messageId &&
    validAction(row.domain, row.action) && typeof row.instance === "string" && INSTANCE.test(row.instance);
}
function validRowClock(row, updatedAt) {
  return integer(row.createdAt) && integer(row.expiresAt) && row.expiresAt - row.createdAt === TTL_MS && row.createdAt <= updatedAt;
}
function validReceiptText(text) {
  return typeof text === "string" && (text === "" || (safeText(text, 1200) && safePreview(text) === text));
}
function validTerminalRow(row, updatedAt) {
  return row.operation === null && row.binding === null && integer(row.finishedAt) &&
    row.finishedAt >= row.createdAt && row.finishedAt <= updatedAt;
}
function validActiveRow(row) {
  return active(row) && row.text === "" && row.finishedAt === null && validOperation(row.operation) &&
    validBinding(row.binding) && hash(row.operation) === row.operationHash && hash(row.binding) === row.bindingHash &&
    row.domain === row.operation.domain && row.action === row.operation.action;
}
function validState(state) {
  if (!exact(state, ["version", "sequence", "updatedAt", "rows"]) || state.version !== 1 || !integer(state.sequence) ||
      !integer(state.updatedAt) || !Array.isArray(state.rows) || state.rows.length > MAX_ROWS ||
      !state.rows.every(row => validRow(row, state.updatedAt))) return false;
  const events = state.rows.map(row => hash([row.ownerKey, row.messageId, row.operationHash]));
  if (new Set(state.rows.map(row => row.ref)).size !== state.rows.length || new Set(events).size !== events.length) return false;
  const owners = new Map();
  for (const row of state.rows) if (row.status === "pending") owners.set(row.ownerKey, (owners.get(row.ownerKey) || 0) + 1);
  return [...owners.values()].every(count => count <= 4);
}
function finish(row, status, at, text = "") {
  Object.assign(row, { status, finishedAt: at, operation: null, binding: null, text });
}
function freeze(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function project(row, own = false) {
  return { ref: row.ref, action: row.action, phase: row.status, createdAt: row.createdAt, expiresAt: row.expiresAt,
    ...(own && row.status === "pending" ? { preview: safePreview(row.operation.preview) } : {}) };
}
function safePreview(text) { return text.replace(/\b[1-9]\d{4,19}\b/g, "[ID hidden]"); }
function draft(row) { return { status: "pending", ref: row.ref, preview: safePreview(row.operation.preview), expiresAt: row.expiresAt }; }
function execution(status, ref, text = "") {
  if (!["applied", "not_applied", "unknown", "denied", "expired"].includes(status)) {
    status = ["executing", "unavailable"].includes(status) ? "unknown" : "denied";
  }
  return { status, ref: typeof ref === "string" && REF.test(ref) ? ref : "", ...(text ? { text } : {}) };
}
function current(guard) {
  if (types.isAsyncFunction(guard)) return false;
  try {
    const result = guard();
    if (types.isPromise(result)) { result.catch(() => {}); return false; }
    return result === undefined || result === true;
  } catch { return false; }
}

function replacedReceipt(previous, row) {
  return TERMINAL.has(previous.status) && (previous.finishedAt !== row.finishedAt ||
    (row.text !== previous.text && row.text !== ""));
}
function assertObservedRows(state, observation) {
  const observed = observation.rows;
  for (const row of state.rows) {
    const previous = observed.get(row.ref);
    if (!previous && row.createdAt <= observation.retiredThrough) throw new Error("Retired record");
    if (previous && (previous.seal !== row.seal || (previous.status !== "pending" && row.status === "pending") ||
        (TERMINAL.has(previous.status) && row.status !== previous.status))) throw new Error("Replaced record");
    if (previous && replacedReceipt(previous, row)) throw new Error("Replaced receipt");
  }
  for (const ref of observed.keys()) if (!state.rows.some(row => row.ref === ref)) throw new Error("Removed record");
}
function recoverRow(row, at, deferred, flushRevocations) {
  if (flushRevocations && deferred.has(row.ref)) {
    if (active(row)) finish(row, row.status === "executing" ? "unknown" : "revoked", at);
    row.text = "";
    return true;
  }
  if (row.instance !== PROCESS_INSTANCE && active(row)) {
    finish(row, row.status === "executing" ? "unknown" : "invalidated", at);
    return true;
  }
  if (row.status === "pending" && at >= row.expiresAt) { finish(row, "expired", at); return true; }
  return false;
}
function recoverRows(state, at, deferred, flushRevocations) {
  let changed = false;
  for (const row of state.rows) if (recoverRow(row, at, deferred, flushRevocations)) changed = true;
  return changed;
}

function collectRows(state, at) {
  let retiredThrough = -1;
  // Scoped owner/message/operation idempotency lasts while its row is retained:
  // certain outcomes retain seven days from finishedAt; unknown never ages out.
  state.rows = state.rows.filter(row => {
    if (!COLLECTABLE.has(row.status) || at - row.finishedAt < RETENTION_MS) return true;
    retiredThrough = Math.max(retiredThrough, row.createdAt);
    return false;
  });
  return retiredThrough;
}

function createStorePersistence({ filename, now, read, write }) {
  const lockfile = `${filename}.lock`;
  let fault = false;
  const observation = observedStores.get(filename) || { seen: false, rows: new Map(), sequence: -1, digest: null,
    lastAt: 0, retiredThrough: -1 };
  observedStores.set(filename, observation);
  const observed = observation.rows;
  const deferred = deferredRevocations.get(filename) || new Set();
  deferredRevocations.set(filename, deferred);

  function fail() { fault = true; return unavailable(); }
  function load() {
    let raw;
    try { raw = read(filename, MISSING, { maxBytes: MAX_BYTES }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; raw = MISSING; }
    if (raw === MISSING) {
      if (observation.seen) throw new Error("Missing state");
      return { version: 1, sequence: 0, updatedAt: 0, rows: [] };
    }
    observation.seen = true;
    const state = snapshot(raw);
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_BYTES || !validState(state)) throw new Error("Invalid state");
    const digest = hash(state);
    if (state.sequence < observation.sequence || (state.sequence === observation.sequence && observation.digest !== digest)) throw new Error("Replaced state");
    assertObservedRows(state, observation);
    observe(state);
    return state;
  }
  function observe(state, replace = false) {
    observation.sequence = state.sequence; observation.digest = hash(state);
    if (replace) observed.clear();
    for (const row of state.rows) observed.set(row.ref, { seal: row.seal, status: row.status,
      finishedAt: row.finishedAt, text: row.text });
  }
  function time(state) {
    const at = now();
    if (!integer(at) || !integer(at + TTL_MS) || at < state.updatedAt || at < observation.lastAt) throw new Error("Invalid clock");
    observation.lastAt = at;
    return at;
  }
  function persist(state, at, retiredThrough = -1) {
    state.sequence++; state.updatedAt = at;
    if (!validState(state) || Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_BYTES) throw new Error("Invalid state");
    const expected = hash(snapshot(state));
    const written = write(filename, snapshot(state), { durable: true });
    if (types.isPromise(written)) { written.catch(() => {}); throw new Error("Asynchronous persistence"); }
    if (written === false) throw new Error("Persistence failed");
    observation.seen = true;
    const verified = snapshot(read(filename, MISSING, { maxBytes: MAX_BYTES }));
    if (!validState(verified) || hash(verified) !== expected) throw new Error("Persistence not confirmed");
    // Only a durable, verified transaction may retire observations. The scalar
    // creation-time floor rejects resurrection without retaining old ref/body maps.
    observe(verified, true);
    observation.retiredThrough = Math.max(observation.retiredThrough, retiredThrough);
  }
  function locked(change, persistRecovery = true) {
    if (fault) return unavailable();
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(lockfile, "wx", 0o600);
    } catch (error) { return error?.code === "EEXIST" ? unavailable() : fail(); }
    let result;
    try {
      const state = load();
      const at = time(state);
      // A nonpersisting forget only queues refs; all recovery waits for the next normal access.
      const changed = persistRecovery && recoverRows(state, at, deferred, true);
      const retiredThrough = persistRecovery ? collectRows(state, at) : -1;
      if (changed || retiredThrough >= 0) { persist(state, at, retiredThrough); deferred.clear(); }
      const transaction = change(state, at);
      if (transaction.changed) persist(state, at);
      result = transaction.result;
    } catch { result = fail(); }
    finally {
      try { fs.closeSync(descriptor); fs.unlinkSync(lockfile); } catch { result = fail(); }
    }
    return result;
  }
  return { locked, load, time, deferred };
}

// Injected read/write use the synchronous JSON helper signatures. A write must be durable or throw.
export function createConfirmationStore({ filename, now = Date.now, read = readJsonFile, write = writeJsonFileSync } = {}) {
  if (typeof filename !== "string" || !filename.trim() || [now, read, write].some(value => typeof value !== "function" || types.isAsyncFunction(value))) {
    throw new TypeError("Invalid confirmation store options");
  }
  const persistence = createStorePersistence({ filename: path.resolve(filename), now, read, write });
  const { locked, deferred } = persistence;

  function create(scope, operation, settings) {
    let keys, op, binding, messageId;
    try {
      keys = scopeKeys(scope); op = snapshot(operation);
      const options = snapshot(settings);
      if (!exact(options, ["messageId", "binding"])) return invalid();
      messageId = decimal(options.messageId, true); binding = options.binding;
      if (messageId === null || !validOperation(op) || !validBinding(binding)) return invalid();
    } catch { return invalid(); }
    const operationHash = hash(op);
    const bindingHash = hash(binding);
    return locked((state, at) => {
      const previous = state.rows.find(row => row.ownerKey === keys.ownerKey && row.messageId === messageId && row.operationHash === operationHash);
      if (previous) {
        if (previous.status === "pending" && previous.bindingHash !== bindingHash) {
          finish(previous, "invalidated", at); return outcome({ status: "invalidated", ref: previous.ref }, true);
        }
        return outcome(previous.status === "pending" ? draft(previous) : { status: previous.status, ref: previous.ref });
      }
      if (state.rows.length >= MAX_ROWS || state.rows.filter(row => row.ownerKey === keys.ownerKey && row.status === "pending").length >= 4) {
        return outcome({ status: "capacity" });
      }
      let ref;
      do { ref = `cf_${randomBytes(16).toString("hex")}`; } while (state.rows.some(row => row.ref === ref));
      const row = { ref, ...keys, messageId, operationHash, bindingHash, domain: op.domain, action: op.action,
        instance: PROCESS_INSTANCE, createdAt: at, expiresAt: at + TTL_MS, status: "pending", finishedAt: null, operation: op, binding, text: "" };
      row.seal = seal(row);
      state.rows.push(row);
      return outcome(draft(row), true);
    });
  }
  function inspect(scope, ref) {
    let keys;
    try { keys = scopeKeys(scope); if (typeof ref !== "string" || !REF.test(ref)) return { status: "denied" }; } catch { return { status: "denied" }; }
    return locked(state => {
      const row = state.rows.find(item => item.ref === ref && item.ownerKey === keys.ownerKey);
      return outcome(row ? { status: "ready", item: project(row, true) } : { status: "denied" });
    });
  }
  function list(scope) {
    let keys;
    try { if (scope !== undefined) keys = scopeKeys(scope); } catch { return { status: "unavailable", items: [] }; }
    const result = locked(state => outcome({ status: "ready", items: state.rows.filter(row => !keys || row.ownerKey === keys.ownerKey).map(row => project(row, Boolean(keys))) }));
    return result.status === "ready" ? result : { status: "unavailable", items: [] };
  }
  function revoke(scope, ref) {
    let keys;
    try { keys = scopeKeys(scope); if (typeof ref !== "string" || !REF.test(ref)) return invalid(); } catch { return invalid(); }
    return locked((state, at) => {
      const row = state.rows.find(item => item.ref === ref && item.ownerKey === keys.ownerKey);
      if (!row) return outcome({ status: "not_found" });
      if (row.status !== "pending") return outcome({ status: row.status, ref: row.ref });
      finish(row, "revoked", at);
      return outcome({ status: row.status, ref: row.ref }, true);
    });
  }
  function revokeUser(uid, settings = {}) {
    const normalized = decimal(uid);
    if (!normalized) return false;
    let options;
    try { options = fields(settings); } catch { return false; }
    if (!exact(options, [], ["persist"]) || (Object.hasOwn(options, "persist") && typeof options.persist !== "boolean")) return false;
    const userKey = hash(["confirmation-user", normalized]);
    const result = locked((state, at) => {
      let changed = false;
      for (const row of state.rows) if (row.userKey === userKey) {
        if (options.persist === false) { deferred.add(row.ref); continue; }
        if (["pending", "executing"].includes(row.status)) { finish(row, row.status === "executing" ? "unknown" : "revoked", at); changed = true; }
        if (row.text) { row.text = ""; changed = true; }
      }
      return outcome(true, changed);
    }, options.persist !== false);
    return result === true;
  }
  const execute = (scope, ref, settings) => executeConfirmation(persistence, scope, ref, settings);
  return Object.freeze({ create, inspect, list, revoke, revokeUser, execute });
}

function executionRequest(scope, ref, settings) {
  const keys = scopeKeys(scope);
  const options = fields(settings);
  if (!exact(options, ["binding", "assertCurrent", "apply"]) || typeof ref !== "string" || !REF.test(ref) ||
      typeof options.assertCurrent !== "function" || typeof options.apply !== "function") throw new TypeError("Invalid execution");
  const binding = snapshot(options.binding);
  if (!validBinding(binding)) throw new TypeError("Invalid binding");
  return { keys, binding, assertCurrent: options.assertCurrent, apply: options.apply };
}
function claimConfirmation(persistence, ref, { keys, binding, assertCurrent }) {
  return persistence.locked((state, at) => {
    const row = state.rows.find(item => item.ref === ref && item.ownerKey === keys.ownerKey);
    if (!row) return outcome(execution("denied", ref));
    if (row.status !== "pending") return outcome(execution(row.status, ref, row.text));
    if (row.bindingHash !== hash(binding)) { finish(row, "invalidated", at); return outcome(execution("denied", ref), true); }
    if (!current(assertCurrent)) return outcome(execution("denied", ref));
    if (hash(persistence.load()) !== hash(state) || persistence.time(state) >= row.expiresAt) return outcome(execution("denied", ref));
    row.status = "executing";
    return outcome({ status: "claimed", operation: freeze(snapshot(row.operation)), seal: row.seal }, true);
  });
}
function checkClaimBeforeApply(persistence, ref, { keys, binding, assertCurrent }, claimed) {
  return persistence.locked((state, at) => {
    const row = state.rows.find(item => item.ref === ref && item.ownerKey === keys.ownerKey && item.seal === claimed.seal);
    if (!row || row.status !== "executing" || row.bindingHash !== hash(binding)) return outcome("unknown");
    if (at >= row.expiresAt || !current(assertCurrent)) return outcome("not_applied");
    if (hash(persistence.load()) !== hash(state)) return outcome("unknown");
    return outcome(persistence.time(state) < row.expiresAt ? "ready" : "not_applied");
  });
}
function saveExecutionReceipt(persistence, ref, { keys }, claimed, status, text) {
  const receipt = persistence.locked((state, at) => {
    const row = state.rows.find(item => item.ref === ref && item.ownerKey === keys.ownerKey && item.seal === claimed.seal);
    if (!row || row.status !== "executing") return outcome(execution("unknown", ref));
    finish(row, status, at, text);
    return outcome(execution(status, ref, text), true);
  });
  return execution(receipt.status, ref, receipt.text);
}
async function executeConfirmation(persistence, scope, ref, settings) {
  let request;
  try { request = executionRequest(scope, ref, settings); } catch { return execution("denied", ref); }
  const claimed = claimConfirmation(persistence, ref, request);
  if (claimed.status !== "claimed") return execution(claimed.status, ref, claimed.text);

  // There is no await between the final parent guard and invoking the captured apply callback.
  let status = "not_applied";
  let text = "";
  try {
    const checked = checkClaimBeforeApply(persistence, ref, request, claimed);
    if (checked === "unknown" || checked?.status === "unavailable") status = "unknown";
    else if (checked === "ready") {
      const { apply } = request;
      const result = snapshot(await apply(claimed.operation));
      status = RESULTS.has(result?.status) ? result.status : "unknown";
      if (RESULTS.has(result?.status) && safeText(result.text, 1200)) text = safePreview(result.text);
    }
  } catch { status = "unknown"; }
  return saveExecutionReceipt(persistence, ref, request, claimed, status, text);
}
