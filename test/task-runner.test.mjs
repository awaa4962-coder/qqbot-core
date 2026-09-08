import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers";
import { createTaskRunner } from "../bridge/tasks/runner.mjs";
import { createAdminTaskManager } from "../bridge/admin-api/task-manager.mjs";
import { handleAdminApiRequest } from "../bridge/admin-api/routes.mjs";
import { Readable } from "node:stream";

function sandbox(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-jobs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { filename: path.join(root, "jobs.json"), ...options };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("task returns an ID immediately and retains only metadata on disk", async t => {
  const options = sandbox(t);
  const tasks = createTaskRunner(options);
  const hold = deferred();
  const job = tasks.start({ scope: "test", action: "sample", run: async ({ progress }) => { progress("analyzing"); await hold.promise; return { ok: true, body: "private-result" }; }, resultView: value => value });
  assert.ok(job.jobId);
  await Promise.resolve();
  assert.equal(tasks.inspect(job.jobId).phase, "analyzing");
  assert.throws(() => tasks.start({ scope: "test", run: () => assert.fail() }), /正在运行/);
  hold.resolve(); await tasks.wait();
  assert.equal(tasks.inspect(job.jobId).result.body, "private-result");
  assert.doesNotMatch(fs.readFileSync(options.filename, "utf8"), /private-result/);
});

test("timeout is advisory and cannot unlock a still-running side effect", async t => {
  const tasks = createTaskRunner(sandbox(t));
  const hold = deferred();
  let signal;
  const job = tasks.start({ scope: "upload", action: "upload", timeoutMs: 5, run: async context => { signal = context.signal; await hold.promise; return { ok: true }; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, true); assert.equal(tasks.inspect(job.jobId).phase, "overdue");
  assert.throws(() => tasks.start({ scope: "upload", run: () => assert.fail() }), /正在运行/);
  hold.resolve(); await tasks.wait();
  assert.equal(tasks.inspect(job.jobId).phase, "done");
  assert.equal(tasks.inspect(job.jobId).timedOut, true);
});

test("task errors are sanitized and process replacement never replays abandoned work", async t => {
  const options = sandbox(t);
  const first = createTaskRunner(options);
  const bad = first.start({ scope: "one", action: "sample", run: () => { throw new Error("private-server-detail"); } });
  await first.wait();
  assert.equal(first.inspect(bad.jobId).phase, "failed");
  assert.doesNotMatch(JSON.stringify(first.list()), /private-server-detail/);
  const hold = deferred();
  const pending = first.start({ scope: "two", action: "sample", run: () => hold.promise });
  const replacement = createTaskRunner(options);
  assert.equal(replacement.inspect(pending.jobId).phase, "interrupted");
  hold.resolve({ ok: true }); await first.wait();
});

test("active tasks survive history trimming and result payloads expire", async t => {
  let now = 1;
  const tasks = createTaskRunner(sandbox(t, { now: () => now, historyLimit: 2 }));
  const hold = deferred();
  const long = tasks.start({ scope: "long", action: "sample", run: () => hold.promise });
  for (let i = 0; i < 4; i++) {
    const done = deferred();
    tasks.start({ scope: "short", action: "sample", run: async () => { done.resolve(); return { ok: true }; } });
    await done.promise; await new Promise(resolve => setTimeout(resolve, 0)); now++;
  }
  assert.ok(tasks.list().some(job => job.id === long.jobId));
  hold.resolve({ ok: true }); await tasks.wait();
  const final = tasks.start({ scope: "short", action: "sample", run: () => ({ ok: true, value: 1 }), resultView: value => value });
  await tasks.wait(); now += 10 * 60000;
  assert.equal(tasks.inspect(final.jobId).resultAvailable, false);
});

test("task quota rejects excess work without invoking another handler", async t => {
  const tasks = createTaskRunner(sandbox(t, { maxConcurrent: 1 }));
  const hold = deferred(); tasks.start({ scope: "one", run: () => hold.promise });
  assert.throws(() => tasks.start({ scope: "two", run: () => assert.fail() }), /已满/);
  hold.resolve({ ok: true }); await tasks.wait();
});

test("admin task adapter allowlists operations and drops arbitrary client fields", async t => {
  const calls = [];
  const manager = createAdminTaskManager(sandbox(t, { handlers: { memes: async payload => { calls.push(payload); return { ok: true, entry: { meaning: "result" }, snapshot: { secret: "must-not-retain" } }; } } }));
  assert.throws(() => manager.start({ module: "config", payload: { action: "save" } }), /不支持/);
  assert.throws(() => manager.start({ module: "memes", payload: { action: "delete" } }), /不支持/);
  const job = manager.start({ module: "memes", payload: { action: "research-web", query: "示例", admin: true, filename: "/etc/private" } });
  await manager.wait();
  assert.deepEqual(calls, [{ action: "research-web", query: "示例" }]);
  const task = manager.snapshot({ id: job.jobId }).task;
  assert.equal(task.phase, "done"); assert.equal(task.result.entry.meaning, "result");
  assert.equal(Object.hasOwn(task.result, "snapshot"), false);
});

test("nested unsuccessful module results are not reported as successful tasks", async t => {
  const manager = createAdminTaskManager(sandbox(t, { handlers: { stickers: async () => ({ result: { ok: false } }) } }));
  const job = manager.start({ module: "stickers", payload: { action: "sync" } });
  await manager.wait(); assert.equal(manager.snapshot({ id: job.jobId }).task.phase, "failed");
});

test("task read and start endpoints retain the existing admin authentication boundary", async () => {
  for (const method of ["GET", "POST"]) {
    const req = Readable.from([]);
    Object.assign(req, { method, url: "/admin/tasks", socket: { remoteAddress: "203.0.113.5" }, headers: {} });
    let code;
    await handleAdminApiRequest(req, {}, { pathname: "/admin/tasks", requiredToken: "test-only", sendJson(_res, status) { code = status; } });
    assert.equal(code, 403);
  }
});
