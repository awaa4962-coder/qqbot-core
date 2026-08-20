import { CFG } from "./config.mjs";
import {
  markEventAccepted,
  markEventDropped,
  markInboundEvent,
} from "./pipeline-state.mjs";
import { createFixedWindowLimiter, monotonicNow } from "./runtime-clock.mjs";

const DEFAULT_INGRESS_LIMIT = 500;
const DEFAULT_SCOPE_LIMIT = 40;
const DEFAULT_PRIORITY_LIMIT = 40;
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEDUPE_MAX = 10_000;

export function createEventAdmissionController(options = {}) {
  const cfg = options.cfg || CFG;
  const now = options.now;
  const ingress = createFixedWindowLimiter({
    limit: options.ingressLimit || DEFAULT_INGRESS_LIMIT,
    windowMs: 1000,
    maxScopes: 1,
    now,
  });
  const ordinary = createFixedWindowLimiter({
    limit: options.scopeLimit || DEFAULT_SCOPE_LIMIT,
    windowMs: 1000,
    maxScopes: 2000,
    now,
  });
  const priority = createFixedWindowLimiter({
    limit: options.priorityLimit || DEFAULT_PRIORITY_LIMIT,
    windowMs: 1000,
    maxScopes: 2000,
    now,
  });
  const telemetry = options.telemetry || defaultTelemetry;
  const monotonicClock = now || monotonicNow;
  const dedupeTtlMs = Math.max(1000, Number(options.dedupeTtlMs || DEFAULT_DEDUPE_TTL_MS));
  const dedupeMax = Math.max(100, Number(options.dedupeMax || DEFAULT_DEDUPE_MAX));
  const seenMessageIds = new Map();

  function admit(ctx) {
    telemetry.received();
    if (!ingress.take("all").ok) return reject("ingress_rate_limited", eventScope(ctx));

    const routeRejection = rejectRoute(ctx, cfg);
    if (routeRejection) return reject(routeRejection, eventScope(ctx));
    const messageKey = eventMessageKey(ctx);
    if (messageKey && isDuplicate(messageKey)) {
      return reject("duplicate_event", eventScope(ctx));
    }

    const lane = isPriorityEvent(ctx, cfg) ? priority : ordinary;
    const scope = eventScope(ctx);
    if (!lane.take(scope).ok) {
      return reject(isPriorityEvent(ctx, cfg) ? "priority_rate_limited" : "scope_rate_limited", scope);
    }
    if (messageKey) rememberMessage(messageKey);
    telemetry.accepted();
    return { ok: true, reason: "accepted", scope, priority: lane === priority };
  }

  function reject(reason, scope = eventScope(null)) {
    telemetry.dropped(reason);
    return { ok: false, reason, scope };
  }

  function status() {
    return {
      ingress: ingress.status(),
      ordinary: ordinary.status(),
      priority: priority.status(),
      dedupeSize: seenMessageIds.size,
    };
  }

  function reset() {
    ingress.reset();
    ordinary.reset();
    priority.reset();
    seenMessageIds.clear();
  }

  function isDuplicate(key) {
    const current = Number(monotonicClock());
    const expiresAt = Number(seenMessageIds.get(key) || 0);
    if (expiresAt > current) return true;
    if (expiresAt) seenMessageIds.delete(key);
    return false;
  }

  function rememberMessage(key) {
    const current = Number(monotonicClock());
    seenMessageIds.set(key, current + dedupeTtlMs);
    pruneSeenMessages(seenMessageIds, current, dedupeMax);
  }

  return { admit, status, reset };
}

const defaultTelemetry = {
  received: markInboundEvent,
  accepted: markEventAccepted,
  dropped: markEventDropped,
};

const defaultController = createEventAdmissionController();

export function admitMessageContext(ctx) {
  return defaultController.admit(ctx);
}

export function getAdmissionStatus() {
  return defaultController.status();
}

function rejectRoute(ctx, cfg) {
  if (listIncludes(cfg.botBlacklist, ctx?.user_id)) return "blacklisted_user";
  if (ctx?.message_type !== "group") return "";
  if (Number(ctx.user_id) === Number(cfg.selfUin)) return "self_message";
  if (!listIncludes(cfg.groupWhitelist, ctx.group_id)) return "group_not_whitelisted";
  return "";
}

function isPriorityEvent(ctx, cfg) {
  if (ctx?.isAtMe) return true;
  return listIncludes(cfg.adminUins, ctx?.user_id);
}

function eventScope(ctx) {
  if (ctx?.message_type === "group") return "group:" + String(ctx.group_id || "unknown");
  if (ctx?.message_type === "private") return "private:" + String(ctx.user_id || "unknown");
  return "unknown";
}

function eventMessageKey(ctx) {
  if (ctx?.message_id === null || ctx?.message_id === undefined || ctx?.message_id === "") return "";
  return eventScope(ctx) + ":" + String(ctx.message_id);
}

function pruneSeenMessages(seen, now, maxSize) {
  if (seen.size <= maxSize) return;
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now || seen.size > maxSize) seen.delete(key);
    if (seen.size <= maxSize) break;
  }
}

function listIncludes(values, candidate) {
  return (values || []).some(value => String(value) === String(candidate));
}
