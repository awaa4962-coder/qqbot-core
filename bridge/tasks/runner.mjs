import { createHash, randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";

const TERMINAL = new Set(["done", "failed", "interrupted", "cancelled"]);

export function taskEventKey(surface, scopeId, messageId) {
  const scope = String(scopeId || "");
  const message = String(messageId ?? "");
  if (!["group", "private"].includes(surface) || !/^[1-9]\d{0,19}$/.test(scope) ||
      !/^-?(?:0|[1-9]\d{0,19})$/.test(message) || message === "-0" || Object.is(messageId, -0)) return "";
  return createHash("sha256").update(`${surface}:${scope}:${message}`).digest("hex").slice(0, 32);
}

export function createTaskRunner(options) {
  const bootId = randomUUID();
  const running = new Map();
  const results = new Map();
  const { read, write } = createTaskStore(options);
  const mutate = options.mutate || (operation => operation());
  const keyFor = options.keyFor || (job => job.scope);
  const now = options.now || Date.now;
  const limit = options.historyLimit || 30;

  function list(scope) {
    return read().filter(job => scope === undefined || job.scope === scope).map(job => {
      const live = running.get(keyFor(job))?.id === job.id;
      const phase = !TERMINAL.has(job.phase) && (job.bootId !== bootId || !live) ? "interrupted" : job.phase;
      const { bootId: _bootId, scope: _scope, ...publicJob } = job;
      return { ...publicJob, phase };
    });
  }

  function save(job) {
    mutate(() => {
      const history = read().filter(item => item.id !== job.id);
      history.push(job);
      const activeIds = new Set([...running.values()].map(item => item.id));
      const active = history.filter(item => activeIds.has(item.id));
      const completed = history.filter(item => !activeIds.has(item.id)).slice(-Math.max(1, limit - active.length));
      write([...active, ...completed].sort((a, b) => a.startedAt - b.startedAt));
    });
  }

  function start(request) {
    request = Object.freeze({ ...request, meta: request.meta ? { ...request.meta } : undefined });
    if (running.has(request.scope)) throw new Error(options.busyMessage || "同类任务正在运行，请稍后再试");
    if (running.size >= (options.maxConcurrent || 2)) throw new Error("后台任务已满，请稍后再试");
    const job = { ...request.meta, id: randomUUID(), bootId, scope: request.scope,
      action: request.action, phase: "queued", startedAt: now(), error: "" };
    const controller = new AbortController();
    const task = Promise.resolve().then(() => execute(job, request, controller));
    running.set(request.scope, { id: job.id, task, job, controller });
    try { save(job); }
    catch (error) { controller.abort(); running.delete(request.scope); throw error; }
    task.catch(() => {});
    return { jobId: job.id, ...request.meta, phase: "queued" };
  }

  const execute = createTaskExecution({ options, running, results, now, save, pruneResults });

  function pruneResults() {
    for (const [id, result] of results) if (result.expiresAt <= now()) results.delete(id);
    while (results.size > limit) results.delete(results.keys().next().value);
  }
  function inspect(id, scope) {
    pruneResults();
    const job = list(scope).find(item => item.id === id);
    if (!job) throw new Error("任务不存在或已过期");
    return { ...job, resultAvailable: results.has(id), result: results.get(id)?.value };
  }
  const cancel = (id, scope) => cancelTask({ read, running, keyFor, save, inspect }, id, scope);
  async function waitFor(id, scope) {
    inspect(id, scope);
    const live = [...running.values()].find(item => item.id === id);
    if (live) await live.task;
    return inspect(id, scope);
  }
  function hasEvent(eventKey) { return Boolean(eventKey && list().some(job => job.eventKey === eventKey)); }
  async function wait() {
    const failures = [];
    while (running.size) {
      const settled = await Promise.allSettled([...running.values()].map(item => item.task));
      for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw failures[0];
  }
  return { start, list, inspect, cancel, waitFor, hasEvent, wait };
}

function createTaskStore(options) {
  const missing = Symbol("missing task store");
  let seenStore = false;
  const read = options.read || (() => {
    const value = readJsonFile(options.filename, missing);
    if (value === missing && !seenStore) return [];
    if (!Array.isArray(value)) throw new Error("task_store_unavailable");
    seenStore = true;
    return value;
  });
  const write = options.write || (entries => {
    writeJsonFileSync(options.filename, entries, { durable: true });
    seenStore = true;
  });
  return { read, write };
}

function cancelTask({ read, running, keyFor, save, inspect }, id, scope) {
  const saved = read().find(job => job.id === id && (scope === undefined || job.scope === scope));
  if (!saved) throw new Error("任务不存在或已过期");
  const live = running.get(keyFor(saved));
  if (!live || live.id !== id) return { jobId: id, phase: inspect(id, scope).phase, cancelRequested: false };
  live.job.cancelRequested = true;
  live.job.phase = "cancelling";
  try { save(live.job); }
  finally { live.controller.abort(); }
  return { jobId: id, phase: "cancelling", cancelRequested: true };
}

function createTaskExecution({ options, running, results, now, save, pruneResults }) {
  return async function execute(job, request, controller) {
    if (running.get(request.scope)?.id !== job.id) return;
    if (controller.signal.aborted) {
      job.phase = "cancelled";
      job.finishedAt = now();
      running.delete(request.scope);
      save(job);
      return;
    }
    let overdue = false;
    const progress = phase => {
      if (overdue || controller.signal.aborted) return;
      job.phase = String(phase).slice(0, 40); save(job);
    };
    const timer = setTimeout(() => {
      overdue = true;
      job.phase = "overdue"; job.timedOut = true;
      controller.abort();
      // Abort is advisory: retain the scope lock until the actual worker settles.
      try { save(job); } catch { /* The business operation still owns its own durable state. */ }
    }, request.timeoutMs ?? 300000);
    timer.unref?.();
    try {
      const result = await request.run({ progress, signal: controller.signal });
      const { acceptResult, ...status } = taskResultStatus(job, result, controller, options);
      Object.assign(job, options.describeResult?.(result) || {}, status);
      if (acceptResult && request.resultView) results.set(job.id, { value: request.resultView(result), expiresAt: now() + 10 * 60000 });
      pruneResults();
    } catch {
      job.phase = job.cancelRequested ? "cancelled" : "failed";
      job.error = job.cancelRequested ? "任务已取消。" : options.failureMessage || "任务失败，请检查对应模块状态";
    }
    finally {
      clearTimeout(timer);
      finalizeTask(job, request, { now, running, results, save });
    }
  };
}

function finalizeTask(job, request, { now, running, results, save }) {
  job.finishedAt = now();
  if (running.get(request.scope)?.id === job.id) running.delete(request.scope);
  try { save(job); }
  catch (error) { results.delete(job.id); throw error; }
}

function taskResultStatus(job, result, controller, options) {
  if (job.cancelRequested === true) return { phase: "cancelled", error: "任务已取消。", acceptResult: false };
  if (options.rejectLateResults === true && controller.signal.aborted) {
    return { phase: "failed", error: "任务已超时，迟到结果未接纳。", acceptResult: false };
  }
  if (result?.ok === false) {
    return { phase: "failed", error: options.resultError?.(result) || "任务未完成，请检查对应模块状态", acceptResult: true };
  }
  return { phase: "done", error: "", acceptResult: true };
}
