import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-draft-tasks-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { createDraftTaskService } = await import("../bridge/chat-tools/draft-tasks.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const scope = { surface: "group", groupId: "50150", userId: "60150", currentMessageId: "70150" };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cfg = { dataRoot: directory, groupWhitelist: [50150], botBlacklist: [], agentGroupWhitelist: [50150],
    agentDraftGroupWhitelist: [50150], summaryGroupWhitelist: [50150], conversationSummaryGroupWhitelist: [50150] };
  const controller = new globalThis.AbortController();
  const runtime = { cfg, scope, signal: controller.signal, userMessage: "总结今天的聊天", messageId: "70150", mentioned: true,
    task: "group_chat", remainingMs: () => 85000, assertCurrent: () => {}, callModel: async () => ({ ok: true }) };
  const service = createDraftTaskService({ cfg, ...options });
  return { cfg, controller, runtime, service, filename: path.join(directory, ".qqfriend/tasks/agent-drafts.json") };
}
function draft(text = "一段合成草稿") { return { ok: true, text, kind: "daily", coverage: { partial: true }, sent: false, persisted: false }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("completed drafts have true task state, owner-only preview, and no persistent body", async t => {
  let calls = 0;
  const f = fixture(t, { createAdapter: () => ({ generate: async () => { calls++; return draft("SYNTHETIC_PRIVATE_BODY"); } }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  assert.equal(result.status, "ok");
  assert.equal(result.phase, "done");
  assert.equal(result.sent, false);
  assert.equal(result.persisted, false);
  assert.equal(f.service.snapshot(result.task_ref).task.result.text, "SYNTHETIC_PRIVATE_BODY");
  assert.equal(f.service.snapshot().tasks[0].resultAvailable, true);
  assert.equal(f.service.initialReferences(f.runtime)[0].resultAvailable, true);
  assert.doesNotMatch(JSON.stringify(f.service.initialReferences(f.runtime)), /SYNTHETIC_PRIVATE_BODY/);
  assert.doesNotMatch(fs.readFileSync(f.filename, "utf8"), /SYNTHETIC_PRIVATE_BODY|50150|60150|70150/);
  const other = { ...f.runtime, scope: { ...scope, userId: "60151" } };
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, other).status, "unavailable");
  await f.service.generate({ kind: "daily" }, f.runtime);
  assert.equal(calls, 1);
});

test("default-off and passive/private admission cannot launch an adapter", async t => {
  const f = fixture(t, { createAdapter: () => assert.fail("unavailable adapter ran") });
  f.cfg.agentDraftGroupWhitelist = [];
  assert.equal((await f.service.generate({ kind: "daily" }, f.runtime)).status, "denied");
  f.cfg.agentDraftGroupWhitelist = [50150];
  for (const override of [{ mentioned: false }, { task: "interjection" }, { scope: { surface: "private", userId: "60150" } }]) {
    assert.equal((await f.service.generate({ kind: "daily" }, { ...f.runtime, ...override })).status, "denied");
  }
  assert.equal((await f.service.generate({ kind: "daily" }, { ...f.runtime, userMessage: "你好" })).status, "denied");
  for (const userMessage of ["不要总结今天的聊天", "别生成日报草稿", "取消回顾", "不\u200B要总\u200B结今天的聊天"]) {
    assert.equal((await f.service.generate({ kind: "daily" }, { ...f.runtime, userMessage })).status, "denied");
  }
});

test("empty or failed business output cannot become a completed readable draft", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => ({ ok: false, reason: "no_records", sent: false, persisted: false }) }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  assert.equal(result.status, "unavailable"); assert.equal(result.phase, "failed");
  const snapshot = f.service.snapshot(result.task_ref);
  assert.equal(snapshot.task.phase, "failed"); assert.equal(snapshot.task.resultAvailable, false);
  assert.equal(Object.hasOwn(snapshot.task, "result"), false);
});

test("equivalent argument key order reuses the same admitted task instead of generating twice", async t => {
  let calls = 0;
  const f = fixture(t, { createAdapter: () => ({ generate: async () => { calls++; return draft(); } }) });
  const first = await f.service.generate({ kind: "daily", day: "today" }, f.runtime);
  const second = await f.service.generate({ day: "today", kind: "daily" }, f.runtime);
  assert.equal(first.task_ref, second.task_ref); assert.equal(calls, 1);
  assert.equal(f.service.snapshot().tasks.length, 1);
});

test("admission refuses accessors and unknown fields without invoking them or starting work", async t => {
  let reads = 0;
  const f = fixture(t, { createAdapter: () => assert.fail("unsafe arguments started work") });
  const accessor = { get kind() { reads++; return "daily"; } };
  for (const args of [accessor, { kind: "daily", groupId: "50151" }, { kind: "daily", separate: "true" }]) {
    assert.equal((await f.service.generate(args, f.runtime)).status, "invalid_arguments");
  }
  assert.equal(reads, 0); assert.equal(f.service.snapshot().tasks.length, 0);
});

test("queued argument and runtime mutation cannot replace the admitted action or owner", async t => {
  const started = deferred(), released = deferred();
  let admittedScope;
  const f = fixture(t, { createAdapter: runtime => ({ generate: async args => {
    admittedScope = runtime.scope; started.resolve(); await released.promise;
    return { ...draft(), kind: args.kind, text: args.kind };
  } }) });
  const originalScope = { ...scope }; f.runtime.scope = { ...scope };
  const args = { kind: "daily" };
  const completion = f.service.generate(args, f.runtime);
  args.kind = "conversation"; f.runtime.scope.groupId = "50151"; f.runtime.scope.userId = "60151";
  await started.promise; released.resolve(); const result = await completion;
  assert.deepEqual(admittedScope, originalScope); assert.equal(result.text, "daily");
  const view = f.service.snapshot(result.task_ref).task;
  assert.equal(view.action, "daily"); assert.equal(view.result.kind, "daily");
  f.cfg.summaryGroupWhitelist = [];
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, { ...f.runtime, scope: originalScope }).status, "denied");
  assert.equal(f.service.snapshot(result.task_ref).task.resultAvailable, false);
});

test("cancelled wrappers retain the task lock until the actual ignored-signal model callback settles", async t => {
  const started = deferred(), transport = deferred(), aborted = deferred();
  const f = fixture(t, { createAdapter: runtime => ({ generate: async () => {
    const operation = runtime.callModel("group_summary", "primary", {});
    runtime.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await aborted.promise;
    operation.catch(() => {});
    return { ok: false, reason: "cancelled", sent: false, persisted: false };
  } }) });
  f.runtime.callModel = () => transport.promise;
  const completion = f.service.generate({ kind: "daily" }, f.runtime);
  await started.promise;
  const id = f.service.snapshot().tasks[0].id;
  f.service.cancel(id);
  await aborted.promise;
  assert.equal(f.service.snapshot().tasks[0].phase, "cancelling");
  const retry = await f.service.generate({ kind: "daily" }, { ...f.runtime, messageId: "70151" });
  assert.equal(retry.status, "unavailable");
  transport.resolve({ ok: true });
  assert.equal((await completion).status, "unavailable");
  assert.equal(f.service.snapshot().tasks[0].phase, "cancelled");
  assert.equal(f.service.snapshot().tasks[0].resultAvailable, false);
});

test("forgetting records hides completed preview before new reads", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => draft() }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  invalidateMemoryPrivacyGeneration();
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, f.runtime).status, "denied");
  assert.equal(f.service.snapshot(result.task_ref).task.resultAvailable, false);
  assert.equal(Object.hasOwn(f.service.snapshot(result.task_ref).task, "result"), false);
});

test("summary-specific privacy cleanup invalidates both owner reads and admin previews without a global epoch change", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => draft() }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  const filename = path.join(f.cfg.dataRoot, ".qqfriend", "summaries", "privacy.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ epoch: 1, users: {} }));
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, f.runtime).status, "denied");
  assert.equal(f.service.initialReferences(f.runtime)[0].resultAvailable, false);
  assert.equal(f.service.snapshot(result.task_ref).task.resultAvailable, false);
  assert.equal(Object.hasOwn(f.service.snapshot(result.task_ref).task, "result"), false);
  fs.writeFileSync(filename, JSON.stringify({ epoch: 0, users: {} }));
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, f.runtime).status, "denied");
  assert.equal(f.service.snapshot(result.task_ref).task.resultAvailable, false);
  assert.equal(f.service.initialReferences(f.runtime)[0].resultAvailable, false);
});

test("business allowlist withdrawal hides a formerly readable admin preview", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => draft() }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  f.cfg.summaryGroupWhitelist = [];
  assert.equal(f.service.snapshot().tasks[0].resultAvailable, false);
  assert.equal(Object.hasOwn(f.service.snapshot(result.task_ref).task, "result"), false);
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, { ...f.runtime, messageId: "70151" }).status, "denied");
});

test("conversation business withdrawal also closes a fresh owner's tool read", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => ({ ...draft(), kind: "conversation" }) }) });
  const result = await f.service.generate({ kind: "conversation" }, f.runtime);
  f.cfg.conversationSummaryGroupWhitelist = [];
  assert.equal(f.service.inspect({ task_ref: result.task_ref }, { ...f.runtime, messageId: "70151" }).status, "denied");
});

test("replacement never restores a body or resumes an old job", async t => {
  const f = fixture(t, { createAdapter: () => ({ generate: async () => draft() }) });
  const result = await f.service.generate({ kind: "daily" }, f.runtime);
  const replacement = createDraftTaskService({ cfg: f.cfg });
  assert.equal(replacement.snapshot(result.task_ref).task.resultAvailable, false);
  assert.equal(replacement.snapshot().tasks[0].resultAvailable, false);
  assert.match(JSON.stringify(replacement.snapshot()), /"resultAvailable":false/);
  assert.equal(Object.hasOwn(replacement.snapshot(result.task_ref).task, "result"), false);
});

test("shutdown cancels and drains actual nested work, returning false while an ignored-signal transport is still alive", async t => {
  const started = deferred(), transport = deferred(), aborted = deferred();
  const f = fixture(t, { createAdapter: runtime => ({ generate: async () => {
    const operation = runtime.callModel("group_summary", "primary", {});
    runtime.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve(); await aborted.promise; operation.catch(() => {});
    return { ok: false, reason: "cancelled", sent: false, persisted: false };
  } }) });
  f.runtime.callModel = () => transport.promise;
  const completion = f.service.generate({ kind: "daily" }, f.runtime);
  await started.promise;
  assert.equal(await f.service.stop({ drainMs: 5 }), false);
  assert.equal(f.service.snapshot().tasks[0].phase, "cancelling");
  assert.equal((await f.service.generate({ kind: "daily" }, { ...f.runtime, messageId: "70152" })).reason, "task_stopping");
  assert.equal(f.service.snapshot().tasks.length, 1);
  transport.resolve({ ok: true }); await completion;
  assert.equal(await f.service.stop({ drainMs: 100 }), true);
  assert.equal(f.service.snapshot().tasks[0].phase, "cancelled");
});

test("shutdown does not claim a successful drain from a corrupt task store", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.filename), { recursive: true });
  fs.writeFileSync(f.filename, "{broken");
  assert.equal(await f.service.stop({ drainMs: 1 }), false);
});
