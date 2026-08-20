import {
  clearInterval as nodeClearInterval,
  setInterval as nodeSetInterval,
} from "node:timers";
import { cleanupTemporaryStickerFiles } from "./features/stickers/index.mjs";
import { cleanupExpiredWordcloudFiles } from "./features/wordcloud/index.mjs";
import { cleanupExpiredJmTempDirs } from "./jm-provider.mjs";
import { cleanupExpiredResourceTempDirs } from "./resource-transfer.mjs";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export function createRuntimeMaintenance(options = {}) {
  const tasks = options.tasks || defaultTasks();
  const log = options.log || (() => {});
  const logError = options.logError || (() => {});
  const setIntervalFn = options.setIntervalFn || nodeSetInterval;
  const clearIntervalFn = options.clearIntervalFn || nodeClearInterval;
  const intervalMs = Math.max(60_000, Number(options.intervalMs || DEFAULT_INTERVAL_MS));
  let timer = null;
  let running = null;

  async function runOnce() {
    if (running) return running;
    running = Promise.all(tasks.map(async task => {
      try {
        const result = await task.run();
        const removed = removedCount(result);
        if (removed) log("runtime cleanup", task.name, "removed", removed);
        return { name: task.name, ok: true, removed };
      } catch (error) {
        logError("runtime cleanup failed:", task.name, error.message);
        return { name: task.name, ok: false, error: error.message, removed: 0 };
      }
    })).finally(() => { running = null; });
    return await running;
  }

  function start() {
    if (timer) return;
    runOnce().catch(() => {});
    timer = setIntervalFn(() => { runOnce().catch(() => {}); }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

function defaultTasks() {
  return [
    { name: "jm", run: () => cleanupExpiredJmTempDirs() },
    { name: "resource", run: () => cleanupExpiredResourceTempDirs() },
    { name: "wordcloud", run: () => cleanupExpiredWordcloudFiles() },
    { name: "stickers", run: () => cleanupTemporaryStickerFiles() },
  ];
}

function removedCount(result) {
  if (Number.isFinite(Number(result))) return Number(result);
  return Number(result?.removed || 0);
}
