import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG } from "../bridge/config.mjs";
import { chatRunStopReason, chatRunSignal, stopChatRuns, withChatRun } from "../bridge/cognition/chat-run.mjs";
import { invalidateMemoryPrivacyGeneration, invalidateUserMemoryGeneration } from "../bridge/memory-profile/generation.mjs";
import { createTraceRecorder, traceStage, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";

const scope = { surface: "group", groupId: 501, userId: 601 };
const config = () => ({ ...CFG, groupWhitelist: [501, 502], friendWhitelist: [601, 602], botBlacklist: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("chat guards are absent outside a run and reject initial permissions", async () => {
  assert.equal(chatRunStopReason(), "");
  assert.equal(chatRunSignal(), undefined);
  for (const request of [{ ...scope, groupId: 503 }, { surface: "private", userId: 999 }, { ...scope, userId: "invalid" }]) {
    const result = await withChatRun(request, () => assert.fail("no work allowed"), { cfg: config() });
    assert.equal(result.reason, "permission_changed");
  }
});

test("permissions are checked again and revocation remains sticky", async () => {
  const cfg = config();
  const result = await withChatRun(scope, async () => {
    assert.equal(chatRunStopReason(), "");
    cfg.groupWhitelist = [];
    assert.equal(chatRunStopReason(), "permission_changed");
    cfg.groupWhitelist = [501];
    assert.equal(chatRunStopReason(), "permission_changed");
    assert.equal(chatRunSignal().aborted, true);
  }, { cfg });
  assert.equal(result.kind, "cancelled");
});

test("private allowlist and blacklist changes invalidate active chats", async () => {
  for (const change of [cfg => { cfg.friendWhitelist = []; }, cfg => { cfg.botBlacklist = [601]; }]) {
    const cfg = config();
    const result = await withChatRun({ surface: "private", userId: 601 }, () => { change(cfg); }, { cfg });
    assert.equal(result.reason, "permission_changed");
  }
});

test("any privacy clear invalidates captured context, including another participant", async () => {
  for (const clear of [() => invalidateUserMemoryGeneration(999), invalidateMemoryPrivacyGeneration]) {
    const result = await withChatRun(scope, () => { clear(); }, { cfg: config() });
    assert.equal(result.reason, "privacy_changed");
  }
});

test("preference revisions affect their user without invalidating other users", async () => {
  const result = await withChatRun(scope, () => {
    invalidateUserMemoryGeneration(602, { privacy: false });
    assert.equal(chatRunStopReason(), "");
    invalidateUserMemoryGeneration(601, { privacy: false });
    assert.equal(chatRunStopReason(), "preferences_changed");
  }, { cfg: config() });
  assert.equal(result.reason, "preferences_changed");
});

test("a newer active request replaces only the same user and conversation", async () => {
  const cfg = config();
  const waiting = deferred();
  let oldSignal;
  const old = withChatRun(scope, async () => { oldSignal = chatRunSignal(); await waiting.promise; }, { cfg });
  await withChatRun({ ...scope, userId: 602 }, () => assert.equal(oldSignal.aborted, false), { cfg });
  await withChatRun({ ...scope, groupId: 502 }, () => assert.equal(oldSignal.aborted, false), { cfg });
  await withChatRun({ surface: "private", userId: 601 }, () => assert.equal(oldSignal.aborted, false), { cfg });
  await withChatRun({ ...scope, groupId: "501" }, () => assert.equal(oldSignal.aborted, true), { cfg });
  waiting.resolve();
  assert.equal((await old).reason, "reply_superseded");
  assert.equal(await withChatRun(scope, () => "next", { cfg }), "next");
});

test("monotonic deadline and exception paths release active scopes", async () => {
  let time = 1;
  const result = await withChatRun(scope, () => { time += 1001; }, { cfg: config(), now: () => time, maxDurationMs: 1000 });
  assert.equal(result.reason, "reply_expired");
  await assert.rejects(withChatRun(scope, () => { throw new Error("synthetic failure"); }, { cfg: config() }), /synthetic failure/);
  assert.equal(await withChatRun(scope, () => "clean", { cfg: config() }), "clean");
});

test("diagnostics distinguish no-send cancellation from partial delivery", async () => {
  const recorder = createTraceRecorder();
  for (const sent of [false, true]) {
    await withMessageTrace({ message_type: "group", group_id: 501, user_id: 601, message_id: sent ? 2 : 1 }, () =>
      withChatRun(scope, () => {
        if (sent) traceStage("send", { status: "ok" });
        invalidateMemoryPrivacyGeneration();
      }, { cfg: config() }), recorder);
    const record = recorder.list().items[0];
    assert.equal(record.status, sent ? "partial" : "cancelled");
    assert.equal(record.reason, "privacy_changed");
    assert.ok(record.stages.some(item => item.turnRevision > 0 && item.privacyRevision >= 0));
  }
});

test("active run capacity is bounded and released when callers finish", async () => {
  const waiting = deferred();
  const cfg = { ...config(), friendWhitelist: Array.from({ length: 1001 }, (_, index) => 7000 + index) };
  const pending = cfg.friendWhitelist.slice(0, 1000).map(userId =>
    withChatRun({ surface: "private", userId }, () => waiting.promise, { cfg }));
  const denied = await withChatRun({ surface: "private", userId: 8000 }, () => assert.fail("over capacity"), { cfg });
  assert.equal(denied.reason, "reply_capacity");
  waiting.resolve();
  await Promise.all(pending);
  assert.equal(await withChatRun(scope, () => "released", { cfg }), "released");
});

// Keep terminal shutdown last; a stopped process intentionally cannot resume chat runs.
test("shutdown aborts current requests and denies new generations", async () => {
  const ready = deferred();
  let signal;
  const run = withChatRun(scope, async () => { signal = chatRunSignal(); await ready.promise; }, { cfg: config() });
  stopChatRuns();
  assert.equal(signal.aborted, true);
  ready.resolve();
  assert.equal((await run).reason, "bridge_stopping");
  assert.equal((await withChatRun(scope, () => assert.fail("stopped"), { cfg: config() })).reason, "bridge_stopping");
});
