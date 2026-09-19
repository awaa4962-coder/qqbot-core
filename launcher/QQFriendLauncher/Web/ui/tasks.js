import { host } from "./state.js";

const TERMINAL = new Set(["done", "failed", "interrupted"]);
const watched = new Map();
const PENDING_KEY = "qqfriend-pending-tasks-v1";
const SUPPORTED = {
  manageStickers: ["stickers", ["sync", "analyze", "capabilities", "cleanup"]],
  runMemeWebUpdate: ["memes", ["run-web-update"]],
  researchMemeWeb: ["memes", ["research-web"]],
  replayAction: ["replay", ["generate"]],
};

export function taskPhaseLabel(phase) {
  return ({ unknown: "任务状态暂不可读，正在重试查询，请勿重复提交", queued: "等待执行", running: "正在处理", analyzing: "正在分析", overdue: "等待较久，任务仍在收尾，请勿重复提交", done: "任务完成", failed: "任务失败", interrupted: "服务已重启，原任务中断，不会自动重做" })[phase] || phase;
}

export async function waitForTask(read, options = {}) {
  let failures = 0;
  const pause = options.sleep || (ms => new Promise(resolve => window.setTimeout(resolve, ms)));
  while (true) {
    let value;
    try {
      value = await read();
      if (!value) throw new Error("任务记录暂不可读");
      failures = 0;
    } catch (cause) {
      failures++;
      const retryable = cause.transportFailure || ["TypeError", "AbortError", "TimeoutError"].includes(cause.name) ||
        [408, 429].includes(cause.status) || cause.status >= 500;
      if (retryable && failures <= 3) {
        options.onReadError?.(cause);
        await pause(Math.min(5000, 1000 * 2 ** (failures - 1)));
        continue;
      }
      const error = new Error("任务结果尚未确认，可能仍在运行；请刷新控制台继续查看，不要重复提交。", { cause });
      error.taskStateUnknown = true;
      throw error;
    }
    options.onProgress?.(value);
    if ((options.isDone || (task => TERMINAL.has(task.phase)))(value)) return value;
    await pause(document.visibilityState === "hidden" ? 5000 : 1200);
  }
}

function pendingIds() {
  try { return JSON.parse(window.sessionStorage.getItem(PENDING_KEY) || "[]").filter(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)); }
  catch { return []; }
}
function remember(id, add) {
  const ids = new Set(pendingIds());
  if (add) ids.add(id); else ids.delete(id);
  try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify([...ids].slice(-20))); } catch { /* Storage may be disabled. */ }
}
export function retainTaskResult(id) { remember(id, true); }

function watch(jobId, onProgress) {
  if (watched.has(jobId)) return watched.get(jobId);
  const promise = waitForTask(async () => (await host.call("getTasks", { id: jobId })).task, {
    onProgress, onReadError: () => onProgress?.({ id: jobId, phase: "unknown" }),
  })
    .then(task => { remember(jobId, false); return task; })
    .finally(() => watched.delete(jobId));
  watched.set(jobId, promise);
  return promise;
}

export async function callManagedAction(action, payload, options = {}) {
  const entry = SUPPORTED[action];
  if (host.mode !== "browser" || !entry?.[1].includes(payload.action)) return await host.call(action, payload);
  const started = await host.call("startTask", { module: entry[0], payload });
  remember(started.jobId, true);
  options.onStarted?.(started.jobId);
  const task = await watch(started.jobId, options.onProgress);
  if (task.phase !== "done") throw new Error(task.error || taskPhaseLabel(task.phase));
  if (!task.resultAvailable) throw new Error("任务已完成，结果缓存已过期，请刷新对应页面");
  return task.result;
}

export async function resumeManagedTasks() {
  if (host.mode !== "browser") return;
  const known = new Set(pendingIds());
  const snapshot = await host.call("getTasks");
  const present = new Set(snapshot.tasks.map(task => task.id));
  for (const id of known) if (!present.has(id)) remember(id, false);
  for (const task of snapshot.tasks.filter(item => !TERMINAL.has(item.phase) || known.has(item.id))) {
    if (watched.has(task.id)) continue;
    remember(task.id, true);
    notify("started", task);
    watch(task.id, value => notify("progress", { ...task, ...value }))
      .then(value => notify("complete", value))
      .catch(error => notify("error", { ...task, phase: "unknown", taskStateUnknown: true, error: error.message }));
  }
}

function notify(type, task) { window.dispatchEvent(new CustomEvent("qqfriend:task", { detail: { type, task } })); }
