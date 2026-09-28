import { AsyncResource } from "node:async_hooks";

export function createVisionDescriptionFlights(options = {}) {
  const maxActive = bounded(options.maxActive, 8);
  const maxWaiters = bounded(options.maxWaiters, 16);
  const timeoutMs = bounded(options.timeoutMs, 40000);
  const byKey = new Map();
  const active = new Set();
  let started = 0; let joined = 0; let cancelled = 0; let rejected = 0;

  function run(key, calculate, caller = {}) {
    if (!/^[a-f0-9]{64}$/.test(key)) return Promise.reject(stopped("vision_shared_identity"));
    const check = AsyncResource.bind(() => caller.assertCurrent?.());
    try { check(); if (caller.signal?.aborted) throw stopped("task_cancelled"); }
    catch (error) { return Promise.reject(error); }
    let entry = byKey.get(key);
    const shared = Boolean(entry);
    if ((entry && entry.waiters.size >= maxWaiters) || (!entry && active.size >= maxActive)) {
      rejected++; return Promise.reject(stopped("vision_shared_capacity"));
    }
    if (!entry) {
      entry = { key, controller: new globalThis.AbortController(), waiters: new Set(), timer: null };
      active.add(entry); byKey.set(key, entry); started++;
    } else joined++;
    const answer = subscribe(entry, { signal: caller.signal, check, shared });
    if (!shared) start(entry, calculate);
    return answer;
  }

  function subscribe(entry, caller) {
    return new Promise((resolve, reject) => {
      const waiter = { ...caller, resolve, reject, abort: null };
      waiter.abort = () => {
        if (!entry.waiters.has(waiter)) return;
        cancelled++; settle(entry, waiter, stopped("task_cancelled"));
        if (!entry.waiters.size) cancel(entry, "task_cancelled");
      };
      entry.waiters.add(waiter);
      waiter.signal?.addEventListener("abort", waiter.abort, { once: true });
      if (waiter.signal?.aborted) waiter.abort();
    });
  }

  function start(entry, calculate) {
    entry.timer = setTimeout(() => cancel(entry, "task_deadline"), timeoutMs);
    Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted();
      return calculate(entry.controller.signal, () => requireWaiter(entry));
    }).then(value => complete(entry, null, value), error => complete(entry, error)).catch(() => {});
  }

  function complete(entry, error, value) {
    clearTimeout(entry.timer);
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key);
    // Aborted work keeps its capacity until the underlying operation actually ends.
    active.delete(entry);
    if (entry.controller.signal.aborted) error ||= stopped("task_cancelled");
    for (const waiter of [...entry.waiters]) settle(entry, waiter, error, value);
    // Completed transport controls cannot be reused for a later attempt.
    entry.controller.abort(stopped("vision_shared_completed"));
  }

  function requireWaiter(entry) {
    entry.controller.signal.throwIfAborted();
    for (const waiter of [...entry.waiters]) {
      try { waiter.check(); if (waiter.signal?.aborted) throw stopped("task_cancelled"); }
      catch (error) { settle(entry, waiter, error); }
    }
    if (!entry.waiters.size) cancel(entry, "task_cancelled");
    entry.controller.signal.throwIfAborted();
  }

  function settle(entry, waiter, error, value) {
    entry.waiters.delete(waiter);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    try { waiter.check(); if (waiter.signal?.aborted) throw stopped("task_cancelled"); }
    catch (currentError) { error = currentError; }
    if (error) waiter.reject(error);
    else waiter.resolve({ value, shared: waiter.shared });
  }

  function cancel(entry, reason) {
    clearTimeout(entry.timer);
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key);
    entry.controller.abort(stopped(reason));
    for (const waiter of [...entry.waiters]) settle(entry, waiter, stopped(reason));
  }

  function clear() {
    for (const entry of active) cancel(entry, "privacy_changed");
  }

  return Object.freeze({ run, clear, status: () => ({ active: active.size,
    waiters: [...active].reduce((sum, entry) => sum + entry.waiters.size, 0), started, joined, cancelled, rejected,
    maxActive, maxWaitersPerFlight: maxWaiters, persistent: false, storesFinalReplies: false }) });
}

function bounded(value, limit) {
  if (value === undefined) return limit;
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new TypeError("invalid vision flight limit");
  return value;
}

function stopped(reason) { return Object.assign(new Error(reason), { code: "VISION_SHARED_STOPPED" }); }

export const visionDescriptionFlights = createVisionDescriptionFlights();
export function clearVisionDescriptionFlights() { visionDescriptionFlights.clear(); }
