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

  function start() {
    if (stopped || completed || exhausted || timer) return;
    schedule(initialDelayMs);
  }

  async function runNow() {
    timer = null;
    if (stopped || completed || exhausted) return null;
    if (!isReady()) {
      log("deferred", { reason: "onebot_not_ready" });
      schedule(retryDelayMs);
      return null;
    }
    runAttempts++;
    const dateText = resolvePreviousSummaryDate(now());
    const result = await run({ dateText, log: (event, detail) => log(event, detail) });
    completed = result.ok === true && !result.pending;
    log(completed ? "complete" : result.pending ? "pending" : "failed", { dateText, ok: result.ok, sent: result.sent, groups: result.groups });
    if (!completed) retryOrExhaust();
    return result;
  }

  function stop() {
    stopped = true;
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
    timer = setTimeoutFn(() => { runNow().catch(error => {
      log("error", { error: error.message });
      retryOrExhaust();
    }); }, delayMs);
    timer?.unref?.();
  }

  return { start, runNow, stop, status };
}
