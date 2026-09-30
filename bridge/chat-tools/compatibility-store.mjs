import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";

const MAX_BYTES = 64 * 1024;
const MAX_RECORDS = 32;
const QUOTA_MS = 86400000;
const MISSING = Symbol("missing");
const IDENTITY = /^[a-f0-9]{64}$/;
const CLAIM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TOKEN_KEYS = ["promptTokens", "cachedTokens", "completionTokens", "reasoningTokens", "totalTokens"];
const AGGREGATE_KEYS = ["promptTokens", "completionTokens", "totalTokens"];
const REPORT_KEYS = ["usageReported", "cacheReported", "reasoningReported"];
const USAGE_KEYS = [...TOKEN_KEYS, "transportAttempts", ...REPORT_KEYS];
const MAX_TOKENS = 1_000_000_000;
const STATUSES = new Set(["verified", "failed", "unsupported"]);
const REASONS = new Set(["native_tools_not_declared", "protocol_not_supported", "provider_not_configured",
  "tool_call_missing", "tool_arguments", "unexpected_tool", "tool_result_wrong", "reply_unusable", "wrong_answer",
  "configuration_changed", "cancelled", "probe_deadline", "transport_unavailable", "probe_budget", "result_budget",
  "proof_persistence_failed", "malformed_state", "probe_pending", "claim_busy"]);

function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validIdentity(value) { return typeof value === "string" && IDENTITY.test(value); }
function validClaimId(value) { return typeof value === "string" && CLAIM_ID.test(value); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function unavailable(reason) { return { ok: false, reason }; }
function statusOf(record) { return record.result?.status ?? "pending"; }

function validUsage(usage, attempts) {
  if (!exactKeys(usage, USAGE_KEYS) || !REPORT_KEYS.every(key => typeof usage[key] === "boolean")) return false;
  if (!TOKEN_KEYS.every(key => usage[key] === null || (integer(usage[key]) && usage[key] <= MAX_TOKENS))) return false;
  if (usage.transportAttempts !== null && (!integer(usage.transportAttempts) || usage.transportAttempts > attempts)) return false;
  return usage.usageReported === AGGREGATE_KEYS.some(key => usage[key] !== null)
    && usage.cacheReported === (usage.cachedTokens !== null) && usage.reasoningReported === (usage.reasoningTokens !== null);
}
function validResult(result, attempts) {
  return exactKeys(result, ["status", "reason", "usage", "durationMs"]) && STATUSES.has(result.status)
    && (result.status === "verified" ? result.reason === "" : REASONS.has(result.reason))
    && integer(result.durationMs) && result.durationMs <= QUOTA_MS && validUsage(result.usage, attempts);
}
function validAttempts(attempts) {
  return Array.isArray(attempts) && (attempts.length === 0 || (attempts[0] === 0
    && (attempts.length === 1 || (attempts.length === 2 && attempts[1] === 1))));
}
function validCompletion(record) {
  if (record.result === null) return record.finishedAt === null && record.verifiedUntil === null;
  if (!validResult(record.result, record.attempts.length) || !integer(record.finishedAt)) return false;
  if (record.finishedAt < record.claimedAt || record.finishedAt >= record.expiresAt) return false;
  if (record.result.status !== "verified") return record.verifiedUntil === null;
  return record.attempts.length === 2 && integer(record.verifiedUntil) && record.verifiedUntil > record.finishedAt;
}
function validRecord(record, updatedAt) {
  return exactKeys(record, ["identity", "claimId", "claimedAt", "expiresAt", "attempts", "finishedAt", "verifiedUntil", "result"])
    && validIdentity(record.identity) && validClaimId(record.claimId) && integer(record.claimedAt)
    && integer(record.expiresAt) && record.expiresAt - record.claimedAt === QUOTA_MS
    && record.claimedAt <= updatedAt && (record.finishedAt === null || record.finishedAt <= updatedAt)
    && validAttempts(record.attempts) && validCompletion(record);
}
function validState(state) {
  if (!exactKeys(state, ["version", "updatedAt", "records"]) || state.version !== 1 || !integer(state.updatedAt)) return false;
  if (!Array.isArray(state.records) || state.records.length > MAX_RECORDS) return false;
  return state.records.every(record => validRecord(record, state.updatedAt))
    && new Set(state.records.map(record => record.identity)).size === state.records.length
    && new Set(state.records.map(record => record.claimId)).size === state.records.length;
}
function sanitizedResult(result, attempts) {
  if (!object(result) || (result.usage !== undefined && !object(result.usage))) return null;
  const raw = result.usage ?? {};
  const usage = Object.fromEntries([...TOKEN_KEYS, "transportAttempts"].map(key => [key, raw[key] ?? null]));
  if (!TOKEN_KEYS.every(key => usage[key] === null || (integer(usage[key]) && usage[key] <= MAX_TOKENS))) return null;
  const inferred = { usageReported: AGGREGATE_KEYS.some(key => usage[key] !== null),
    cacheReported: usage.cachedTokens !== null, reasoningReported: usage.reasoningTokens !== null };
  for (const key of REPORT_KEYS) usage[key] = raw[key] ?? inferred[key];
  // Some transports fill missing usage with zero. Explicit reporting flags take precedence.
  if (usage.usageReported === false) for (const key of AGGREGATE_KEYS) usage[key] = null;
  if (usage.cacheReported === false) usage.cachedTokens = null;
  if (usage.reasoningReported === false) usage.reasoningTokens = null;
  const reason = result.status === "verified" ? (result.reason ?? "") : result.reason;
  const safe = { status: result.status, reason, usage, durationMs: result.durationMs };
  return validResult(safe, attempts) ? safe : null;
}
function projectedRecord(record) {
  const status = statusOf(record);
  return { status, checkedAt: record.finishedAt ?? record.claimedAt,
    expiresAt: status === "verified" ? record.verifiedUntil : record.expiresAt, attempts: record.attempts.length,
    reason: record.result?.reason ?? "probe_pending", usage: record.result ? copy(record.result.usage) : null,
    durationMs: record.result?.durationMs ?? null };
}
function unknown(reason, healthCode = "ok") {
  return { status: "unknown", healthCode, ...(reason ? { reason } : {}) };
}
function readView(identity, current) {
  if (!current.ok) return unknown(current.reason, current.reason);
  const record = current.state.records.find(entry => entry.identity === identity);
  if (!record) return unknown();
  const until = statusOf(record) === "verified" ? record.verifiedUntil : record.expiresAt;
  if (current.at >= until) return unknown("expired");
  return { ...projectedRecord(record), healthCode: "ok" };
}
function snapshotView(current, ttlMs) {
  if (!current.ok) return { ok: false, status: "unavailable", health: "unavailable", reason: current.reason, healthCode: current.reason };
  const counts = { pending: 0, verified: 0, failed: 0, unsupported: 0, expired: 0 };
  for (const record of current.state.records) {
    const until = statusOf(record) === "verified" ? record.verifiedUntil : record.expiresAt;
    counts[current.at >= until ? "expired" : statusOf(record)]++;
  }
  return { ok: true, status: current.missing ? "empty" : "ready", health: "ready", healthCode: "ok", recordCount: current.state.records.length,
    counts, maxRecords: MAX_RECORDS, maxBytes: MAX_BYTES, quotaMs: QUOTA_MS, ttlMs };
}

export function createToolCompatibilityStore({ file, now = Date.now, ttlMs = QUOTA_MS } = {}) {
  if (typeof file !== "string" || !file.trim() || typeof now !== "function" || !integer(ttlMs) || ttlMs === 0) {
    throw new TypeError("Invalid tool compatibility store options");
  }
  const filename = path.resolve(file);
  const lockfile = `${filename}.lock`;
  let seenFile = false;
  let fault = null;
  let lastSeen = 0;

  function fail(reason) { fault = reason; return unavailable(reason); }
  function load() {
    if (fault) return unavailable(fault);
    let stat;
    try { stat = fs.lstatSync(filename); }
    catch (error) {
      if (error.code === "ENOENT" && !seenFile) return { ok: true, missing: true, state: { version: 1, updatedAt: 0, records: [] } };
      return fail("read_failed");
    }
    seenFile = true;
    if (!stat.isFile()) return fail("read_failed");
    if (stat.size > MAX_BYTES) return fail("oversized");
    let state;
    try { state = readJsonFile(filename, MISSING, { maxBytes: MAX_BYTES }); }
    catch (error) { return fail(error instanceof SyntaxError ? "corrupt" : "read_failed"); }
    if (state === MISSING) return fail("read_failed");
    if (!validState(state)) return fail("invalid_schema");
    return { ok: true, missing: false, state };
  }
  function time(state) {
    let value;
    try { value = now(); } catch { return unavailable("invalid_clock"); }
    if (!integer(value)) return unavailable("invalid_clock");
    if (value < lastSeen || value < state.updatedAt) return unavailable("clock_skew");
    lastSeen = value;
    return { ok: true, value };
  }
  function view() {
    const loaded = load();
    if (!loaded.ok) return loaded;
    const clock = time(loaded.state);
    return clock.ok ? { ...loaded, at: clock.value } : clock;
  }

  function mutate(change) {
    const preflight = load();
    if (!preflight.ok) return preflight;
    let descriptor;
    try {
      if (preflight.missing) fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(lockfile, "wx", 0o600);
    } catch (error) { return error.code === "EEXIST" ? unavailable("lock_busy") : fail("lock_failed"); }
    let outcome;
    try {
      // Every authorization rereads under the lock; no in-memory quota can authorize payment.
      const current = view();
      if (!current.ok) outcome = current;
      else {
        outcome = change(current.state, current.at);
        if (outcome.ok) {
          current.state.updatedAt = current.at;
          if (!validState(current.state)) outcome = fail("invalid_schema");
          else if (Buffer.byteLength(JSON.stringify(current.state), "utf8") > MAX_BYTES) outcome = fail("oversized");
          else {
            writeJsonFileSync(filename, current.state, { durable: true });
            seenFile = true;
          }
        }
      }
    } catch { outcome = fail("write_failed"); }
    finally {
      try { fs.closeSync(descriptor); } catch { outcome = fail("lock_failed"); }
      // Only this invocation's successfully acquired lock is removed. Never recover stale locks.
      try { fs.unlinkSync(lockfile); } catch { outcome = fail("lock_failed"); }
    }
    return outcome;
  }

  function read(identity) {
    if (!validIdentity(identity)) return unknown("invalid_identity", "invalid_identity");
    return readView(identity, view());
  }
  function claim(identity) {
    if (!validIdentity(identity)) return unavailable("invalid_identity");
    return mutate((state, at) => {
      const previous = state.records.find(entry => entry.identity === identity);
      if (previous && at < previous.expiresAt) return { ok: false, reason: "claim_busy", record: projectedRecord(previous) };
      if (!integer(at + QUOTA_MS)) return unavailable("invalid_clock");
      // Terminal records also retain their quota; only expired claims can be evicted.
      const retained = state.records.filter(entry => at < entry.expiresAt);
      if (retained.length >= MAX_RECORDS) return unavailable("capacity");
      const record = { identity, claimId: randomUUID(), claimedAt: at, expiresAt: at + QUOTA_MS,
        attempts: [], finishedAt: null, verifiedUntil: null, result: null };
      state.records = [...retained, record];
      return { ok: true, claimId: record.claimId, record: projectedRecord(record) };
    });
  }
  function activeRecord(state, identity, claimId, at) {
    const record = state.records.find(entry => entry.identity === identity && entry.claimId === claimId);
    return record && record.result === null && at < record.expiresAt ? record : null;
  }
  function reserveAttempt(identity, claimId, stage) {
    if (!validIdentity(identity) || !validClaimId(claimId) || (stage !== 0 && stage !== 1)) return false;
    return mutate((state, at) => {
      const record = activeRecord(state, identity, claimId, at);
      if (!record || record.attempts.length !== stage) return unavailable("attempt_denied");
      record.attempts.push(stage);
      return { ok: true };
    }).ok;
  }
  function finish(identity, claimId, result) {
    if (!validIdentity(identity) || !validClaimId(claimId)) return false;
    return mutate((state, at) => {
      const record = activeRecord(state, identity, claimId, at);
      if (!record) return unavailable("finish_denied");
      const safe = sanitizedResult(result, record.attempts.length);
      if (!safe || (safe.status === "verified" && record.attempts.length !== 2)) return unavailable("invalid_result");
      const verifiedUntil = safe.status === "verified" ? at + ttlMs : null;
      if (verifiedUntil !== null && !integer(verifiedUntil)) return unavailable("invalid_clock");
      Object.assign(record, { result: safe, finishedAt: at, verifiedUntil });
      return { ok: true };
    }).ok;
  }
  function snapshot() { return snapshotView(view(), ttlMs); }
  return { read, claim, reserveAttempt, finish, snapshot };
}
