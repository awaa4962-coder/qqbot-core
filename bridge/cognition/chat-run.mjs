import { AsyncLocalStorage } from "node:async_hooks";
import { CFG } from "../config.mjs";
import { canUsePrivateChat } from "../commands/permissions.mjs";
import { messageRouteRejection } from "../event-admission.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../memory-profile/generation.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { traceStage } from "../diagnostics/message-trace.mjs";

const storage = new AsyncLocalStorage();
const active = new Map();
const MAX_ACTIVE_RUNS = 1000;
let revision = 0;
let stopping = false;
export const CHAT_CANCEL_REASONS = new Set(["privacy_changed", "permission_changed", "preferences_changed", "reply_superseded", "reply_expired", "reply_capacity", "bridge_stopping"]);

function permitted(scope, cfg) {
  if (!/^\d{1,20}$/.test(String(scope.userId || ""))) return false;
  const type = scope.surface === "private" ? "private" : "group";
  if (type === "group" && !/^\d{1,20}$/.test(String(scope.groupId || ""))) return false;
  if (messageRouteRejection({ message_type: type, group_id: scope.groupId, user_id: scope.userId }, cfg)) return false;
  return type !== "private" || canUsePrivateChat(scope.userId, cfg);
}

export function chatCancellation(reason = chatRunStopReason()) {
  return { kind: "cancelled", text: null, reason: CHAT_CANCEL_REASONS.has(reason) ? reason : "reply_superseded" };
}

export function chatRunStopReason() {
  return storage.getStore()?.check() || "";
}

export function chatRunSignal() {
  return storage.getStore()?.signal;
}

export function chatRunPrivacyChanged() {
  const run = storage.getStore();
  return Boolean(run && run.privacyGeneration !== getMemoryPrivacyGeneration());
}

export function stopChatRuns() {
  stopping = true;
  for (const run of active.values()) run.cancel("bridge_stopping");
}

export function assertChatRunCurrent() {
  const reason = chatRunStopReason();
  if (reason) throw Object.assign(new Error(reason), { code: "CHAT_CANCELLED" });
}

// One scope owns one active generation; transports inherit this boundary across awaits.
export async function withChatRun(scope, handler, options = {}) {
  if (stopping) {
    traceStage("output", { status: "skipped", reason: "bridge_stopping" });
    return chatCancellation("bridge_stopping");
  }
  const key = JSON.stringify([scope.surface, String(scope.groupId || "private"), String(scope.userId)]);
  const previous = active.get(key);
  if (!previous && active.size >= MAX_ACTIVE_RUNS) {
    traceStage("output", { status: "skipped", reason: "reply_capacity" });
    return chatCancellation("reply_capacity");
  }
  if (previous) previous.cancel("reply_superseded");
  const run = createRun(scope, options);
  active.set(key, run);
  return await storage.run(run, async () => {
    traceStage("context", { status: "started", turnRevision: run.revision, privacyRevision: run.privacyGeneration });
    try {
      if (run.check()) return chatCancellation(run.reason);
      const result = await handler();
      return run.check() ? chatCancellation(run.reason) : result;
    } catch (error) {
      if (run.check()) return chatCancellation(run.reason);
      throw error;
    } finally {
      if (run.check()) traceStage("output", { status: "skipped", reason: run.reason, turnRevision: run.revision });
      if (active.get(key) === run) active.delete(key);
    }
  });
}

function createRun(scope, options) {
  const now = options.now || monotonicNow;
  const cfg = options.cfg || CFG;
  const expiresAt = now() + Math.max(1000, Math.min(300000, Number(options.maxDurationMs || 180000)));
  const run = { revision: ++revision, privacyGeneration: getMemoryPrivacyGeneration(), reason: "" };
  const controller = new globalThis.AbortController();
  run.signal = controller.signal;
  run.cancel = reason => { run.reason ||= reason; controller.abort(); };
  const userGeneration = getUserMemoryGeneration(scope.userId);
  run.check = () => {
    if (run.reason) return run.reason;
    // Context can contain other participants' text, so any privacy clear invalidates it.
    if (run.privacyGeneration !== getMemoryPrivacyGeneration()) run.reason = "privacy_changed";
    else if (userGeneration !== getUserMemoryGeneration(scope.userId)) run.reason = "preferences_changed";
    else if (!permitted(scope, cfg)) run.reason = "permission_changed";
    else if (now() >= expiresAt) run.reason = "reply_expired";
    if (run.reason) controller.abort();
    return run.reason;
  };
  return run;
}
