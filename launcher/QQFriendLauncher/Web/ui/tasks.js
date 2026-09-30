import { host } from "./state.js";

const TERMINAL = new Set(["done", "failed", "interrupted", "cancelled"]);
const watched = new Map();
const blocked = new Map();
const visibleTasks = new Map();
const PENDING_KEY = "qqfriend-pending-tasks-v1";
const SCOPES_KEY = "qqfriend-pending-task-scopes-v1";
const MODULE_LABELS = { stickers: "表情", replay: "对话回放", agent_tools: "模型工具验证" };
const SUPPORTED = {
  manageStickers: ["stickers", ["sync", "analyze", "capabilities", "cleanup"]],
  replayAction: ["replay", ["generate"]],
  probeAgentTools: ["agent_tools", ["probe"]],
};

export function taskPhaseLabel(phase) {
  return ({ unknown: "任务状态尚未确认，请刷新核实，勿重复提交", pending: "任务结果待确认，请刷新核实，勿重复提交", queued: "等待执行", running: "正在处理", analyzing: "正在分析", overdue: "等待较久，任务仍在收尾，尚未确认停止，请勿重复提交", done: "任务已结束", failed: "任务失败", cancelled: "任务已取消，未完成这次操作", interrupted: "服务已重启，原任务中断，不会自动重做" })[phase] || "任务阶段未知，请刷新核实";
}

export function managedTaskIsBlocked(module) { return blocked.has(module); }

export function taskResultError(task) {
  if (task.phase !== "done") return task.error || taskPhaseLabel(task.phase);
  const result = task.result;
  if (result?.cancelled || result?.result?.cancelled) return "任务已取消，未完成这次操作。";
  if (result?.ok === false || result?.result?.ok === false) return result.error || result.result?.error || "任务未完成，请检查对应页面。";
  if (!task.resultAvailable || !result || result.refreshRequired) return "任务已结束，但结果缓存不可用；请刷新对应页面核实，不代表旧操作成功。";
  return "";
}

function persistScopes() {
  try { window.sessionStorage.setItem(SCOPES_KEY, JSON.stringify([...blocked.values()])); } catch { /* Storage may be disabled. */ }
}

function block(task) {
  blocked.set(task.module, task);
  persistScopes();
  recordTask(task);
}

function recordTask(task) {
  visibleTasks.set(task.id || `unknown-${task.module}`, task);
  renderManagedTasks();
}

function taskNotice(message, error = false) {
  const node = document.getElementById("managedTaskNotice");
  if (!node) return;
  node.textContent = message; node.dataset.error = String(error);
}

function renderManagedTasks() {
  const body = document.getElementById("managedTaskRows");
  if (!body?.insertRow) return;
  body.replaceChildren();
  for (const task of [...visibleTasks.values()].reverse()) {
    const row = body.insertRow();
    const label = Object.hasOwn(MODULE_LABELS, task.module) ? MODULE_LABELS[task.module] : "未知模块";
    const done = task.module === "agent_tools" ? "验证任务已结束，请查看主备模型证据" : "操作已确认完成";
    const values = [label, task.id || "提交结果未知", task.error || (TERMINAL.has(task.phase) ? taskResultError(task) || done : taskPhaseLabel(task.phase))];
    values.forEach((value, index) => { const cell = row.insertCell(); cell.textContent = value; cell.dataset.label = ["模块", "任务编号", "真实状态"][index]; });
  }
  if (!visibleTasks.size) { const cell = body.insertRow().insertCell(); cell.colSpan = 3; cell.textContent = "暂无后台任务"; }
}

export function initializeManagedTaskPanel() {
  const panel = document.getElementById("managedTaskPanel");
  if (host.mode !== "browser" || !panel) return;
  panel.hidden = false;
  document.getElementById("refreshManagedTasks")?.addEventListener("click", () => {
    resumeManagedTasks().catch(error => taskNotice(`任务读取失败：${error.message}；未确认任务仍禁止重复提交。`, true));
  });
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SCOPES_KEY) || "[]");
    if (Array.isArray(saved)) for (const task of saved) {
      if (task && Object.hasOwn(MODULE_LABELS, task.module)) block({ ...task, phase: "unknown" });
    }
  } catch { /* A later server snapshot is authoritative. */ }
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
    onProgress: task => {
      const previous = visibleTasks.get(jobId) || {};
      if (task.id && task.id !== jobId) throw new Error("任务响应编号不符，请刷新核实。");
      if (typeof task.phase !== "string" || !task.phase) throw new Error("任务响应不完整，请刷新核实。");
      recordTask({ ...previous, ...task, id: jobId, error: task.error || "" });
      onProgress?.(task);
    },
    onReadError: () => {
      const previous = visibleTasks.get(jobId);
      if (previous) recordTask({ ...previous, phase: "unknown", error: taskPhaseLabel("unknown") });
      onProgress?.({ id: jobId, phase: "unknown" });
    },
  })
    .then(task => {
      remember(jobId, false);
      for (const [module, pending] of blocked) if (pending.id === jobId) blocked.delete(module);
      persistScopes();
      return visibleTasks.get(jobId) || task;
    })
    .catch(cause => {
      const task = visibleTasks.get(jobId) || { id: jobId };
      const error = cause.taskStateUnknown ? cause : Object.assign(new Error("任务结果尚未确认；请刷新后台任务核实，勿重复提交。", { cause }), { taskStateUnknown: true });
      if (task.module) block({ ...task, phase: "unknown", error: error.message });
      throw error;
    })
    .finally(() => watched.delete(jobId));
  watched.set(jobId, promise);
  return promise;
}

export async function callManagedAction(action, payload, options = {}) {
  const entry = SUPPORTED[action];
  if (host.mode !== "browser" || !entry?.[1].includes(payload.action)) return await host.call(action, payload);
  if (managedTaskIsBlocked(entry[0])) throw new Error("同类任务仍在运行或结果未确认；请刷新后台任务核实，勿重复提交。");
  let started;
  try {
    started = await host.call("startTask", { module: entry[0], payload });
    if (!/^[a-f0-9-]{36}$/.test(started?.jobId || "")) throw Object.assign(new Error("任务提交响应不完整"), { responseInvalid: true });
  } catch (cause) {
    if (cause.status && cause.status < 500 && !cause.responseInvalid) throw cause;
    block({ module: entry[0], action: payload.action, phase: "unknown" });
    const error = new Error("任务提交结果尚未确认；请刷新后台任务核实，勿重复提交。", { cause });
    error.taskStateUnknown = true;
    throw error;
  }
  block({ id: started.jobId, module: entry[0], action: payload.action, phase: started.phase || "queued" });
  remember(started.jobId, true);
  options.onStarted?.(started.jobId);
  const task = await watch(started.jobId, options.onProgress);
  const problem = taskResultError(task);
  if (problem) throw Object.assign(new Error(problem), { taskTerminal: true });
  return task.result;
}

export async function resumeManagedTasks() {
  if (host.mode !== "browser") return;
  const known = new Set(pendingIds());
  const panel = document.getElementById("managedTaskPanel");
  const button = document.getElementById("refreshManagedTasks");
  panel?.setAttribute?.("aria-busy", "true");
  if (button) button.disabled = true;
  taskNotice("正在读取后台任务…");
  let snapshot;
  try {
    snapshot = await host.call("getTasks");
    if (!Array.isArray(snapshot?.tasks) || snapshot.tasks.some(task => !task || typeof task.id !== "string" || !task.id || typeof task.phase !== "string" || !task.phase || typeof task.module !== "string" || !task.module)) throw new Error("任务目录响应不完整");
  } catch (error) {
    taskNotice(`任务读取失败：${error.message}；以下状态未更新，勿重复提交。`, true);
    throw error;
  } finally {
    panel?.setAttribute?.("aria-busy", "false");
    if (button) button.disabled = false;
  }
  const tasks = snapshot.tasks.filter(task => Object.hasOwn(MODULE_LABELS, task.module));
  visibleTasks.clear();
  for (const task of tasks) recordTask(task);
  let unknownSubmission = false;
  let unresolvedProbe = false;
  for (const [module, pending] of blocked) {
    const active = tasks.find(task => task.module === module && !TERMINAL.has(task.phase) &&
      (module !== "agent_tools" || !pending.id || task.id === pending.id));
    if (active) block(active);
    else {
      // Absence from a bounded history does not resolve an uncertain paid submission.
      const completed = tasks.find(task => task.module === module && task.id === pending.id && TERMINAL.has(task.phase));
      if (module === "agent_tools" && !completed) {
        block({ ...pending, phase: "unknown", error: "验证任务记录尚未确认，请刷新核实，勿重复提交。" });
        unresolvedProbe = true;
        continue;
      }
      blocked.delete(module);
      if (!pending.id) unknownSubmission = true;
    }
  }
  persistScopes();
  renderManagedTasks();
  if (unresolvedProbe) taskNotice("验证任务结果仍未确认；未知范围继续阻止重复提交，请核对任务记录。", true);
  else if (unknownSubmission) taskNotice("暂无仍在运行的同类任务；先前提交结果无法确认，请核对对应页面。", true);
  else if (tasks.length) taskNotice(`${tasks.length} 条任务记录；刷新只查询状态，不重做任务。`);
  else taskNotice("暂无后台任务");
  const present = new Set(snapshot.tasks.map(task => task.id));
  for (const task of snapshot.tasks) if (task.module === "memes") remember(task.id, false);
  for (const id of known) if (!present.has(id) && ![...blocked.values()].some(task => task.id === id)) remember(id, false);
  // Refresh proof for the latest completed probe without replaying historical work.
  const latestProbe = blocked.has("agent_tools") ? null : tasks.filter(task => task.module === "agent_tools").at(-1);
  for (const task of tasks.filter(item => !TERMINAL.has(item.phase) || known.has(item.id) || item.id === latestProbe?.id)) {
    const pending = blocked.get(task.module);
    if (task.module === "agent_tools" && pending && pending.id !== task.id) continue;
    if (watched.has(task.id)) continue;
    remember(task.id, true);
    if (!TERMINAL.has(task.phase)) block(task);
    notify("started", task);
    watch(task.id, value => notify("progress", { ...task, ...value }))
      .then(value => notify("complete", value))
      .catch(error => {
        const uncertain = { ...task, phase: "unknown", taskStateUnknown: true, error: error.message };
        block(uncertain);
        notify("error", uncertain);
      });
  }
}

function notify(type, task) { window.dispatchEvent(new CustomEvent("qqfriend:task", { detail: { type, task } })); }
