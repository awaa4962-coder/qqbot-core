import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskRunner, taskEventKey } from "../bridge/tasks/runner.mjs";

function sandbox(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { filename: path.join(root, "jobs.json"), ...options };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("scope-bound reads and cancellation do not affect another owner's task", async t => {
  const tasks = createTaskRunner(sandbox(t));
  const hold = deferred();
  let signal;
  const job = tasks.start({ scope: "owner-a", action: "draft", run: context => { signal = context.signal; return hold.promise; } });
  await Promise.resolve();
  assert.equal(tasks.list("owner-b").length, 0);
  assert.throws(() => tasks.inspect(job.jobId, "owner-b"), /不存在/);
  assert.throws(() => tasks.cancel(job.jobId, "owner-b"), /不存在/);
  assert.equal(signal.aborted, false);
  assert.equal(tasks.cancel(job.jobId, "owner-a").phase, "cancelling");
  assert.equal(signal.aborted, true);
  assert.throws(() => tasks.start({ scope: "owner-a", run: () => assert.fail() }), /正在运行/);
  hold.resolve({ ok: true });
  const result = await tasks.waitFor(job.jobId, "owner-a");
  assert.equal(result.phase, "cancelled");
  assert.equal(result.resultAvailable, false);
});

test("cancelling queued work skips its handler and finalizes its lock", async t => {
  const tasks = createTaskRunner(sandbox(t));
  const job = tasks.start({ scope: "queued", run: () => assert.fail("cancelled handler ran") });
  tasks.cancel(job.jobId, "queued");
  assert.equal((await tasks.waitFor(job.jobId, "queued")).phase, "cancelled");
  const next = tasks.start({ scope: "queued", run: () => ({ ok: true }) });
  assert.equal((await tasks.waitFor(next.jobId, "queued")).phase, "done");
});

test("strict draft tasks reject late success without releasing a live worker early", async t => {
  const tasks = createTaskRunner(sandbox(t, { rejectLateResults: true }));
  const hold = deferred();
  const job = tasks.start({ scope: "draft", timeoutMs: 5, run: () => hold.promise, resultView: value => value });
  await delay(25);
  assert.equal(tasks.inspect(job.jobId).phase, "overdue");
  assert.throws(() => tasks.start({ scope: "draft", run: () => assert.fail() }), /正在运行/);
  hold.resolve({ ok: true, text: "late private draft" });
  const finished = await tasks.waitFor(job.jobId);
  assert.equal(finished.phase, "failed");
  assert.equal(finished.timedOut, true);
  assert.equal(finished.resultAvailable, false);
});

test("corrupt or disappeared task store cannot be overwritten as an empty history", async t => {
  const options = sandbox(t);
  const tasks = createTaskRunner(options);
  const job = tasks.start({ scope: "first", run: () => ({ ok: true }) });
  await tasks.waitFor(job.jobId);
  fs.writeFileSync(options.filename, "{broken", "utf8");
  assert.throws(() => tasks.start({ scope: "second", run: () => assert.fail() }));
  assert.equal(fs.readFileSync(options.filename, "utf8"), "{broken");
  fs.unlinkSync(options.filename);
  assert.throws(() => tasks.list(), /task_store_unavailable/);
  assert.throws(() => tasks.start({ scope: "third", run: () => assert.fail() }), /task_store_unavailable/);
  await tasks.wait();
  assert.equal(fs.existsSync(options.filename), false);
});

test("an unadmitted aborted worker cannot delete a replacement scope lock", async () => {
  let history = [], writes = 0;
  const tasks = createTaskRunner({ read: () => history, write: value => { if (++writes === 1) throw new Error("disk failed"); history = value; } });
  assert.throws(() => tasks.start({ scope: "shared", run: () => assert.fail() }), /disk failed/);
  const hold = deferred();
  const replacement = tasks.start({ scope: "shared", run: () => hold.promise });
  await Promise.resolve();
  assert.throws(() => tasks.start({ scope: "shared", run: () => assert.fail() }), /正在运行/);
  hold.resolve({ ok: true });
  assert.equal((await tasks.waitFor(replacement.jobId)).phase, "done");
});

test("task cancellation metadata persists but private result does not survive restart", async t => {
  const options = sandbox(t);
  const tasks = createTaskRunner(options);
  const hold = deferred();
  const job = tasks.start({ scope: "owner", run: () => hold.promise, resultView: value => value });
  await Promise.resolve();
  tasks.cancel(job.jobId, "owner");
  const replacement = createTaskRunner(options);
  assert.equal(replacement.inspect(job.jobId, "owner").phase, "interrupted");
  assert.equal(replacement.inspect(job.jobId).cancelRequested, true);
  hold.resolve({ ok: true, text: "never-persist-draft" });
  await tasks.wait();
  assert.doesNotMatch(fs.readFileSync(options.filename, "utf8"), /never-persist-draft/);
});

test("caller request reuse cannot change the admitted lock or handler", async t => {
  const tasks = createTaskRunner(sandbox(t));
  const request = { scope: "original", action: "draft", run: () => ({ ok: true }) };
  const job = tasks.start(request);
  request.scope = "replacement";
  request.run = () => assert.fail("replacement handler ran");
  assert.equal((await tasks.waitFor(job.jobId, "original")).phase, "done");
  const next = tasks.start({ scope: "original", run: () => ({ ok: true }) });
  await tasks.waitFor(next.jobId);
});

test("request mutation while running cannot leave its original scope locked", async t => {
  const tasks = createTaskRunner(sandbox(t));
  const hold = deferred();
  const request = { scope: "original", run: () => hold.promise };
  const job = tasks.start(request);
  await Promise.resolve();
  request.scope = "replacement";
  hold.resolve({ ok: true });
  assert.equal((await tasks.waitFor(job.jobId)).phase, "done");
  const next = tasks.start({ scope: "original", run: () => ({ ok: true }) });
  await tasks.waitFor(next.jobId);
});

test("signed OneBot message identities are bounded and never share unsigned fingerprints", () => {
  assert.match(taskEventKey("group", "50150", "-70150"), /^[a-f\d]{32}$/);
  assert.notEqual(taskEventKey("group", "50150", "-70150"), taskEventKey("group", "50150", "70150"));
  for (const id of ["-0", -0, "01", "-01", "1.5", "9".repeat(21)]) assert.equal(taskEventKey("group", "50150", id), "");
  assert.equal(taskEventKey("group", "50150", 0), taskEventKey("group", "50150", "0"));
});

test("a failed task save cannot make the common drain return before another actual worker settles", async () => {
  let history = [], finished = false;
  const tasks = createTaskRunner({ read: () => history, write: value => {
    if (value.some(job => job.action === "bad" && job.phase === "done")) throw new Error("terminal write failed");
    history = value;
  } });
  const first = deferred(), second = deferred();
  const bad = tasks.start({ scope: "first", action: "bad", run: () => first.promise });
  const good = tasks.start({ scope: "second", action: "good", run: () => second.promise });
  const drain = tasks.wait(); drain.then(() => { finished = true; }, () => { finished = true; });
  first.resolve({ ok: true });
  await assert.rejects(tasks.waitFor(bad.jobId), /terminal write failed/);
  assert.equal(finished, false);
  second.resolve({ ok: true });
  await assert.rejects(drain, /terminal write failed/);
  assert.equal(tasks.inspect(good.jobId).phase, "done"); assert.equal(finished, true);
});
