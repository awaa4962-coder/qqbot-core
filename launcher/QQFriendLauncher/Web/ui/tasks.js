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
  return ({ queued: "等待执行", running: "正在处理", analyzing: "正在分析", overdue: "等待较久，任务仍在收尾，请勿重复提交", done: "任务完成", failed: "任务失败", interrupted: "服务已重启，原任务中断，不会自动重做" })[phase] || phase;
}

export async function waitForTask(read, options = {}) {
  while (true) {
    const value = await read();
    options.onProgress?.(value);
    if ((options.isDone || (task => TERMINAL.has(task.phase)))(value)) return value;
    await new Promise(resolve => window.setTimeout(resolve, document.visibilityState === "hidden" ? 5000 : 1200));
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
  const promise = waitForTask(async () => (await host.call("getTasks", { id: jobId })).task, { onProgress })
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
    watch(task.id, value => notify("progress", value))
      .then(value => notify("complete", value))
      .catch(() => notify("error", { ...task, error: "任务状态暂不可读，任务可能仍在运行，请刷新确认" }));
  }
}

function notify(type, task) { window.dispatchEvent(new CustomEvent("qqfriend:task", { detail: { type, task } })); }
