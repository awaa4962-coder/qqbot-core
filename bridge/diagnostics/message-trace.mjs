import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monotonicNow } from "../runtime-clock.mjs";

const storage = new AsyncLocalStorage();
const STAGES = new Set(["received", "admission", "route", "context", "model", "output", "send", "complete"]);
const STATES = new Set(["started", "ok", "failed", "skipped"]);
const REASONS = new Set([
  "accepted", "ingress_rate_limited", "scope_rate_limited", "priority_rate_limited",
  "group_not_whitelisted", "blacklisted_user", "self_message", "duplicate_event",
  "private_not_whitelisted", "duplicate_text", "preview_sent", "mentioned", "empty",
  "short", "no_probability", "cooldown", "random", "triggered", "empty_reply",
  "empty_content", "empty_content_with_reasoning", "reasoning_leak", "secret_leak",
  "sanitized_empty", "unsafe_output", "unsafe_reasoning", "model_unavailable", "send_failed", "exception",
]);
const ROUTES = new Set(["group_at", "interjection", "private_chat", "private_file", "command", "jm", "resource-transfer", "link-preview", "wordcloud", "preview", "file"]);
const NUMBERS = ["chars", "messages", "pruned", "truncated", "images", "mentions", "httpStatus", "attempt", "reasoningLength", "promptTokens", "cachedTokens", "completionTokens", "probability"];

// Records accept metadata only. No caller can attach message bodies or raw errors.
function safeDetails(details) {
  const safe = {};
  if (STATES.has(details.status)) safe.status = details.status;
  if (REASONS.has(details.reason)) safe.reason = details.reason;
  if (ROUTES.has(details.route)) safe.route = details.route;
  for (const key of ["provider", "task", "position"]) {
    if (/^[a-z][a-z0-9_-]{0,47}$/i.test(details[key] || "") && !/^(sk-|bearer|token|secret)/i.test(details[key])) safe[key] = details[key];
  }
  for (const key of NUMBERS) {
    if (typeof details[key] === "number" && Number.isFinite(details[key])) safe[key] = Math.max(0, Math.min(1e9, details[key]));
  }
  if (Array.isArray(details.sources)) safe.sources = safeSources(details.sources);
  return safe;
}

function safeSources(sources) {
  const kinds = new Set(["quote", "thread", "memory", "group", "image"]);
  const reasons = new Set(["reply_chain", "continuation", "keywords", "synonyms", "mention", "recent", "image_reference"]);
  return sources.filter(item => kinds.has(item?.kind) && reasons.has(item.reason)).slice(0, 24).map(item => ({
    kind: item.kind, reason: item.reason, messageId: numericId(item.messageId), userId: numericId(item.userId),
    score: Number.isFinite(item.score) ? Math.max(0, Math.min(12, item.score)) : 0, clipped: item.clipped === true,
  }));
}

function numericId(value) {
  const text = String(value ?? "");
  return /^-?\d{1,20}$/.test(text) ? text : "";
}

export function createTraceRecorder(options = {}) {
  const records = new Map();
  const now = options.now || monotonicNow;
  const maxRecords = Math.max(1, Math.min(1000, options.maxRecords || 300));
  const ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;

  function begin(ctx) {
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      started: now(),
      messageId: numericId(ctx.message_id),
      groupId: ctx.message_type === "group" ? numericId(ctx.group_id) : "",
      userId: numericId(ctx.user_id),
      scope: ctx.message_type === "private" ? "private" : "group",
      mentioned: ctx.isAtMe === true,
      status: "processing",
      route: "",
      reason: "",
      stages: [],
      sends: 0,
      sendFailures: 0,
      closed: false,
    };
    records.set(record.id, record);
    while (records.size > maxRecords) records.delete(records.keys().next().value);
    append(record, "received", { status: "ok", chars: ctx.text?.length || 0, images: ctx.images?.length || 0 });
    return record;
  }

  function append(record, stage, details = {}) {
    if (!record || record.closed || !STAGES.has(stage)) return;
    const safe = safeDetails(details);
    if (safe.route) record.route = safe.route;
    if (safe.reason) record.reason = safe.reason;
    if (stage === "send" && safe.status === "ok") record.sends++;
    if (stage === "send" && safe.status === "failed") record.sendFailures++;
    if (record.stages.length < 63) record.stages.push({ stage, elapsedMs: elapsed(record), ...safe });
  }

  function elapsed(record) {
    return Math.max(0, Math.round(now() - record.started));
  }

  function finish(record, failed = false) {
    if (record.closed) return;
    record.status = finalStatus(record, failed);
    record.durationMs = elapsed(record);
    if (failed) record.reason = "exception";
    record.stages.push({ stage: "complete", elapsedMs: record.durationMs, status: record.status });
    record.closed = true;
  }

  function list(query = {}) {
    for (const [id, record] of records) {
      if (now() - record.started > ttlMs) records.delete(id);
    }
    const rows = [...records.values()].reverse().filter(record => matchesQuery(record, query));
    const requested = Number(query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(100, Math.floor(requested)) : 50;
    return {
      items: rows.slice(0, limit).map(record => publicRecord(record, elapsed(record))),
      total: rows.length,
      capacity: maxRecords,
      retentionHours: ttlMs / 3600000,
      persistent: false,
    };
  }

  return { begin, append, finish, list };
}

function finalStatus(record, failed) {
  if (record.sends && (failed || record.sendFailures)) return "partial";
  if (failed || record.sendFailures) return "failed";
  if (record.sends) return "sent";
  if (record.stages.some(item => item.status === "skipped")) return "ignored";
  return record.route ? "no_reply" : "processed";
}

function matchesQuery(record, query) {
  return (!query.status || query.status === "all" || record.status === query.status) &&
    (!query.messageId || record.messageId === String(query.messageId)) &&
    (!query.groupId || record.groupId === String(query.groupId));
}

function publicRecord(record, duration) {
  const { started: _started, closed: _closed, ...data } = record;
  return JSON.parse(JSON.stringify({ ...data, durationMs: record.durationMs ?? duration }));
}

const recorder = createTraceRecorder();

export async function withMessageTrace(ctx, handler, target = recorder) {
  const record = target.begin(ctx);
  return await storage.run({ record, recorder: target }, async () => {
    try {
      const result = await handler();
      target.finish(record);
      return result;
    } catch (error) {
      target.finish(record, true);
      throw error;
    }
  });
}

export function traceStage(stage, details = {}) {
  const active = storage.getStore();
  if (active) active.recorder.append(active.record, stage, details);
}

export function listMessageTraces(query = {}) {
  return recorder.list(query);
}
