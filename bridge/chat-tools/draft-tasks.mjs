import path from "node:path";
import { createHash } from "node:crypto";
import { CFG } from "../config.mjs";
import { createTaskRunner, taskEventKey } from "../tasks/runner.mjs";
import { getMemoryPrivacyGeneration } from "../memory-profile/generation.mjs";
import { createBusinessDraftAdapter } from "./business-drafts.mjs";
import { agentDraftsAllowed } from "./policy.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";

const TASK_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerKey = scope => hash(["agent-draft", scope.surface, String(scope.groupId), String(scope.userId)]);
const activePhases = new Set(["queued", "collecting", "analyzing", "fallback", "overdue", "cancelling"]);

export function permitsDraftRequest(message) {
  if (typeof message !== "string") return false;
  const text = message.normalize("NFKC").replace(/\p{Cf}/gu, "");
  return /总结|日报|回顾|草稿|聊了什么|聊了啥|说了什么|说了啥|聊的事/.test(text) &&
    !/(?:不要|不用|别|无需|禁止|取消|停止|不必).{0,8}(?:总结|日报|回顾|草稿)|\b(?:don't|do not|never|cancel|stop)\b.{0,24}\b(?:summarize|summary|draft|recap)\b/i.test(text);
}

export function createDraftTaskService(options = {}) {
  const cfg = options.cfg || CFG;
  const scopes = new Map();
  const revokedResults = new WeakSet();
  let stopping = false;
  const tasks = options.tasks || createTaskRunner({
    filename: options.filename || path.join(cfg.dataRoot, ".qqfriend", "tasks", "agent-drafts.json"),
    maxConcurrent: 2, historyLimit: 30, rejectLateResults: true,
    resultError: () => "草稿未完成，未发送或保存正文。",
    describeResult: () => ({ sent: false, persisted: false }),
  });
  const createAdapter = options.createAdapter || createBusinessDraftAdapter;

  async function generate(args, runtime) {
    if (stopping) return { status: "unavailable", reason: "task_stopping" };
    if (!authorized(runtime, cfg) || !permitsDraftRequest(runtime.userMessage)) return denied();
    runtime.assertCurrent();
    runtime = Object.freeze({ ...runtime, scope: Object.freeze({ ...runtime.scope }) });
    args = snapshotDraftArguments(args);
    const owner = ownerKey(runtime.scope);
    const event = taskEventKey("group", runtime.scope.groupId, runtime.messageId);
    if (!event || !args) return { status: "invalid_arguments" };
    const eventKey = hash([owner, event, args]);
    try {
      const previous = tasks.list(owner).find(job => job.eventKey === eventKey);
      if (previous) return taskToolView(tasks.inspect(previous.id, owner), runtime, cfg, revokedResults);
      const job = tasks.start({ scope: owner, action: args.kind, timeoutMs: Math.max(1, Math.min(85000, runtime.remainingMs())),
        meta: { module: "agent_drafts", eventKey, privacyRevision: getMemoryPrivacyGeneration(), ...readDraftPrivacyState(cfg), sent: false, persisted: false },
        run: context => runDraftWorker(args, runtime, context, createAdapter), resultView: result => result });
      scopes.set(job.jobId, Object.freeze({ ...runtime.scope }));
      while (scopes.size > 30) scopes.delete(scopes.keys().next().value);
      const stopUnfinished = () => { try { tasks.cancel(job.jobId, owner); } catch { /* No unconfirmed cancel acknowledgement. */ } };
      runtime.signal.addEventListener("abort", stopUnfinished, { once: true });
      try {
        if (runtime.signal.aborted) stopUnfinished();
        const completed = await tasks.waitFor(job.jobId, owner);
        runtime.assertCurrent();
        return taskToolView(completed, runtime, cfg, revokedResults);
      } finally { runtime.signal.removeEventListener("abort", stopUnfinished); }
    } catch {
      runtime.assertCurrent();
      return { status: "unavailable", reason: "draft_not_completed", text: "草稿尚未完成，没有发送或保存正文。" };
    }
  }

  function inspect(args, runtime) {
    if (!authorized(runtime, cfg)) return denied();
    runtime.assertCurrent();
    if (!TASK_ID.test(args?.task_ref || "") || ![undefined, "status", "cancel"].includes(args.action)) return { status: "invalid_arguments" };
    const owner = ownerKey(runtime.scope);
    try {
      const job = tasks.inspect(args.task_ref, owner);
      if (args.action === "cancel") {
        const result = tasks.cancel(args.task_ref, owner);
        return { status: "ok", task_ref: args.task_ref, phase: result.phase, sent: false, persisted: false,
          text: result.cancelRequested ? "已请求取消，后台尚未确认停止。" : "任务已经结束，没有重新执行。" };
      }
      return taskToolView(job, runtime, cfg, revokedResults);
    } catch { return { status: "unavailable", reason: "task_not_available" }; }
  }

  function initialReferences(runtime) {
    if (!authorized(runtime, cfg)) return [];
    runtime.assertCurrent();
    try {
      const owner = ownerKey(runtime.scope);
      return tasks.list(owner).slice(-6).map(job => {
        const inspected = tasks.inspect(job.id, owner);
        return publicTask(inspected, mayReadTask(inspected, runtime.scope, cfg, revokedResults));
      });
    }
    catch { return []; }
  }

  function snapshot(id) {
    const enabled = (cfg.agentDraftGroupWhitelist || []).some(group => (cfg.agentGroupWhitelist || []).some(base => String(base) === String(group)));
    try {
      const jobs = tasks.list();
      const task = id ? tasks.inspect(id) : null;
      const mayRead = task && mayReadTask(task, scopes.get(id), cfg, revokedResults);
      return { status: "ready", enabled, tasks: jobs.map(job => {
        const inspected = tasks.inspect(job.id);
        return publicTask(inspected, mayReadTask(inspected, scopes.get(job.id), cfg, revokedResults));
      }),
        ...(task ? { task: { ...publicTask(task, Boolean(mayRead)), ...(mayRead && task.phase === "done" && task.resultAvailable
          ? { result: task.result } : {}) } } : {}) };
    } catch { return { status: "unavailable", enabled, tasks: [] }; }
  }

  function cancel(id) {
    if (!TASK_ID.test(id || "")) throw new Error("invalid_task_id");
    return tasks.cancel(id);
  }
  return { generate, inspect, initialReferences, snapshot, cancel, wait: tasks.wait,
    stop: settings => { stopping = true; return stopDraftTasks(tasks, settings); } };
}

function snapshotDraftArguments(args) {
  if (!args || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return null;
  const keys = Reflect.ownKeys(args);
  const fields = { kind: "string", day: "string", targets: "string", separate: "boolean" };
  if (keys.some(key => typeof key !== "string" || !Object.hasOwn(fields, key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), "value") || typeof args[key] !== fields[key])) return null;
  if (!Object.hasOwn(args, "kind") || !["daily", "conversation"].includes(args.kind)) return null;
  return Object.freeze(Object.fromEntries(keys.sort().map(key => [key, args[key]])));
}

async function stopDraftTasks(tasks, settings = {}) {
  let timer;
  try {
    for (const job of tasks.list()) if (activePhases.has(job.phase)) tasks.cancel(job.id);
    const requested = Number(settings.drainMs ?? 10000);
    const drainMs = Number.isFinite(requested) ? Math.max(0, Math.min(10000, requested)) : 10000;
    return await Promise.race([
      tasks.wait().then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), drainMs); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

async function runDraftWorker(args, runtime, { progress, signal }, createAdapter) {
  const sharedSignal = AbortSignal.any([signal, runtime.signal]);
  const pending = new Set();
  const callModel = (...parameters) => {
    const operation = Promise.resolve().then(() => runtime.callModel(...parameters));
    pending.add(operation);
    operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const assertCurrent = () => { runtime.assertCurrent(); sharedSignal.throwIfAborted(); };
  try {
    const adapter = createAdapter({ ...runtime, signal: sharedSignal, assertCurrent, callModel, onProgress: progress });
    const result = await adapter.generate(args);
    assertCurrent();
    return result;
  } finally {
    // A cancelled wrapper may finish before its transport. Keep the scope lock until all actual callbacks settle.
    while (pending.size) await Promise.allSettled([...pending]);
  }
}

function authorized(runtime, cfg) {
  return runtime && typeof runtime.assertCurrent === "function" && runtime.signal &&
    agentDraftsAllowed(runtime.scope, cfg, runtime);
}

function authorizedSnapshotScope(scope, cfg) {
  return scope && agentDraftsAllowed(scope, cfg, { mentioned: true, task: "group_chat" });
}

function mayReadTask(task, scope, cfg, revokedResults) {
  if (revokedResults.has(task.result)) return false;
  const whitelist = task.action === "daily" ? cfg.summaryGroupWhitelist : cfg.conversationSummaryGroupWhitelist;
  if (!authorizedSnapshotScope(scope, cfg) || !Array.isArray(whitelist) || !whitelist.some(id => String(id) === String(scope.groupId)) ||
      task.privacyRevision !== getMemoryPrivacyGeneration()) return false;
  let current;
  try { current = readDraftPrivacyState(cfg); }
  catch { if (task.result && typeof task.result === "object") revokedResults.add(task.result); return false; }
  const matches = task.summaryPrivacyRevision === current.summaryPrivacyRevision && task.summarySourceIdentity === current.summarySourceIdentity;
  if (!matches && task.result && typeof task.result === "object") revokedResults.add(task.result);
  return matches;
}

export function readDraftPrivacyState(cfg) {
  const root = cfg.dataRoot || CFG.dataRoot;
  const epoch = summaryPrivacy({ root: path.join(root, ".qqfriend", "summaries") }).epoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("summary_privacy_unavailable");
  return { summaryPrivacyRevision: epoch, summarySourceIdentity: hash([root, cfg.chatLogFile || CFG.chatLogFile]) };
}

function taskToolView(job, runtime, cfg, revokedResults) {
  runtime.assertCurrent();
  if (!authorized(runtime, cfg) || !mayReadTask(job, runtime.scope, cfg, revokedResults)) return denied();
  const base = { task_ref: job.id, phase: job.phase, sent: false, persisted: false };
  if (job.phase === "done" && job.resultAvailable && job.result?.ok === true) {
    const text = job.result.text.slice(0, 1200).replace(/[\uD800-\uDBFF]$/u, "");
    return { ...base, status: "ok", text, coverage: job.result.coverage, truncated: text.length < job.result.text.length };
  }
  if (activePhases.has(job.phase)) return { ...base, status: "ok", text: job.phase === "cancelling" ? "已请求取消，等待后台停止。" : "草稿还在处理，尚未生成可用结果。" };
  return { ...base, status: "unavailable", reason: "draft_not_available", text: "草稿未完成或可读结果已过期，没有重新执行。" };
}

function publicTask(job, includeResult) {
  return { id: job.id, module: "agent_drafts", action: ["daily", "conversation"].includes(job.action) ? job.action : "unknown",
    phase: job.phase, startedAt: job.startedAt, finishedAt: job.finishedAt,
    error: job.phase === "failed" ? "draft_failed" : job.phase === "interrupted" ? "interrupted" : "",
    resultAvailable: Boolean(includeResult && job.phase === "done" && job.resultAvailable === true) };
}

function denied() { return { status: "denied", reason: "not_allowed" }; }
export const agentDraftTasks = createDraftTaskService();
