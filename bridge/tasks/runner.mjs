import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonFileSync } from "../persistence/json-file.mjs";

const TERMINAL = new Set(["done", "failed", "interrupted"]);

export function createTaskRunner(options) {
  const bootId = randomUUID();
  const running = new Map();
  const results = new Map();
  const read = options.read || (() => readJsonFile(options.filename, []));
  const write = options.write || (entries => writeJsonFileSync(options.filename, entries));
  const mutate = options.mutate || (operation => operation());
  const keyFor = options.keyFor || (job => job.scope);
  const now = options.now || Date.now;
  const limit = options.historyLimit || 30;

  function list() {
    return read().map(job => {
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
    if (running.has(request.scope)) throw new Error(options.busyMessage || "同类任务正在运行，请稍后再试");
    if (running.size >= (options.maxConcurrent || 2)) throw new Error("后台任务已满，请稍后再试");
    const job = { ...request.meta, id: randomUUID(), bootId, scope: request.scope,
      action: request.action, phase: "queued", startedAt: now(), error: "" };
    const controller = new AbortController();
    const task = Promise.resolve().then(() => execute(job, request, controller));
    running.set(request.scope, { id: job.id, task });
    try { save(job); }
    catch (error) { controller.abort(); running.delete(request.scope); throw error; }
    task.catch(() => {});
    return { jobId: job.id, ...request.meta, phase: "queued" };
  }

  async function execute(job, request, controller) {
    if (controller.signal.aborted) return;
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
      Object.assign(job, options.describeResult?.(result) || {});
      job.phase = result?.ok === false ? "failed" : "done";
      job.error = result?.ok === false ? (options.resultError?.(result) || "任务未完成，请检查对应模块状态") : "";
      if (request.resultView) results.set(job.id, { value: request.resultView(result), expiresAt: now() + 10 * 60000 });
      pruneResults();
    } catch { job.phase = "failed"; job.error = options.failureMessage || "任务失败，请检查对应模块状态"; }
    finally {
      clearTimeout(timer); job.finishedAt = now();
      running.delete(request.scope); save(job);
    }
  }

  function pruneResults() {
    for (const [id, result] of results) if (result.expiresAt <= now()) results.delete(id);
    while (results.size > limit) results.delete(results.keys().next().value);
  }
  function inspect(id) {
    pruneResults();
    const job = list().find(item => item.id === id);
    if (!job) throw new Error("任务不存在或已过期");
    return { ...job, resultAvailable: results.has(id), result: results.get(id)?.value };
  }
  async function wait() { while (running.size) await Promise.all([...running.values()].map(item => item.task)); }
  return { start, list, inspect, wait };
}
