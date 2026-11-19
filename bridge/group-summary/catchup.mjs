import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { resolvePreviousSummaryDate } from "./date.mjs";
import { runDailySummaries } from "./daily.mjs";

export function createDailySummaryCatchUp(options = {}) {
  const isReady = options.isReady || (() => true);
  const run = options.run || runDailySummaries;
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});
  const setTimeoutFn = options.setTimeoutFn || nodeSetTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || nodeClearTimeout;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs ?? 60_000));
  const retryDelayMs = Math.max(1000, Number(options.retryDelayMs ?? 60_000));
  const maxRunAttempts = Math.max(1, Number(options.maxRunAttempts || 3));
  let timer = null;
  let stopped = false;
  let completed = false;
  let exhausted = false;
  let runAttempts = 0;
  let inFlight = null;
  let running = false;

  function start() {
    if (stopped || completed || exhausted || timer || inFlight) return;
    schedule(initialDelayMs);
  }

  function runNow() {
    if (inFlight) return inFlight;
    if (stopped || completed || exhausted) return Promise.resolve(null);
    clearTimer();
    inFlight = Promise.resolve().then(runIfReady).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function runIfReady() {
    if (stopped) return null;
    let ready;
    try { ready = await isReady(); }
    catch { ready = false; }
    if (stopped) return null;
    if (!ready) {
      log("deferred", { reason: "onebot_not_ready" });
      schedule(retryDelayMs);
      return null;
    }
    runAttempts++;
    const dateText = resolvePreviousSummaryDate(now());
    running = true;
    try {
      const result = await run({ dateText, log });
      completed = result.ok === true && !result.pending;
      log(completed ? "complete" : result.pending ? "pending" : "failed", { dateText, ok: result.ok, sent: result.sent, groups: result.groups });
      if (!completed) retryOrExhaust();
      return result;
    } catch (error) {
      log("error", { error: error.message });
      retryOrExhaust();
      throw error;
    } finally {
      running = false;
    }
  }

  function stop() {
    stopped = true;
    clearTimer();
    // A pending readiness check cannot dispatch after stop; only wait for an actual run.
    return running ? inFlight.then(() => true, () => true) : true;
  }

  function clearTimer() {
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  function status() {
    return { scheduled: Boolean(timer), stopped, completed, exhausted, runAttempts };
  }

  function retryOrExhaust() {
    if (runAttempts >= maxRunAttempts) exhausted = true;
    else schedule(retryDelayMs);
  }

  function schedule(delayMs) {
    if (stopped || completed || exhausted || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      runNow().catch(() => {});
    }, delayMs);
    timer?.unref?.();
  }

  return { start, runNow, stop, status };
}
