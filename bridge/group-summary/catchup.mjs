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
  let runAttempts = 0;

  function start() {
    if (stopped || completed || timer) return;
    schedule(initialDelayMs);
  }

  async function runNow() {
    timer = null;
    if (stopped || completed) return null;
    if (!isReady()) {
      log("deferred", { reason: "onebot_not_ready" });
      schedule(retryDelayMs);
      return null;
    }
    runAttempts++;
    const dateText = resolvePreviousSummaryDate(now());
    const result = await run({ dateText, log: (event, detail) => log(event, detail) });
    log("complete", { dateText, ok: result.ok, sent: result.sent, groups: result.groups });
    if (result.ok || runAttempts >= maxRunAttempts) completed = true;
    else schedule(retryDelayMs);
    return result;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  function status() {
    return { scheduled: Boolean(timer), stopped, completed, runAttempts };
  }

  function schedule(delayMs) {
    if (stopped || completed || timer) return;
    timer = setTimeoutFn(() => { runNow().catch(error => {
      log("error", { error: error.message });
      if (runAttempts >= maxRunAttempts) completed = true;
      else schedule(retryDelayMs);
    }); }, delayMs);
    timer?.unref?.();
  }

  return { start, runNow, stop, status };
}
