import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { runVmTestFile } from "./vm-test-runner.mjs";
import { consoleHarness, deferred, flush } from "./p5-ui-harness.mjs";
import { uiFixtureData } from "./p5-ui-fixtures.mjs";

const ID = "00000000-0000-0000-0000-000000000061";
const OLD_ID = "00000000-0000-0000-0000-000000000060";
const SCOPES = "qqfriend-pending-task-scopes-v1";
const IDS = "qqfriend-pending-tasks-v1";
const failure = status => Object.assign(new Error("synthetic read failure"), { status });
const task = (phase = "done", extra = {}) => ({ id: ID, module: "agent_tools", action: "probe", phase,
  resultAvailable: true, result: { ok: true }, ...extra });

function capabilities(change = {}) {
  const value = uiFixtureData().capabilities;
  const now = Date.now();
  value.agentTools.compatibility = { status: "verified", provenance: "live", probeAllowed: false,
    slots: ["primary", "fallback"].map(position => ({ position, model: "synthetic-" + position,
      status: "verified", checkedAt: now - 1000, expiresAt: now + 60000, attempts: 2 })), ...change };
  return value;
}

async function fixture(saved = []) {
  const h = consoleHarness();
  h.window.fetch = () => assert.fail("real HTTP forbidden");
  h.session.set(SCOPES, JSON.stringify(saved));
  const [tasks, feedback, state] = await h.imports(["ui/tasks.js", "ui/background-feedback.js", "ui/state.js"]);
  feedback.installTaskFeedback();
  tasks.initializeManagedTaskPanel();
  return { h, tasks, state };
}

function assertReadOnly(h) {
  assert.ok(h.calls.every(call => ["getTasks", "getCapabilities", "getStickers"].includes(call.action)));
}

if (!vm.SourceTextModule) {
  test("agent task recovery uses isolated VM modules", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { timeout: 15000, minTests: 28 })));
  });
} else {
  for (const status of [403, 503]) {
    test(`restored unknown agent scope survives task directory ${status} and forbids a new submission`, async () => {
      const { h, tasks } = await fixture([{ module: "agent_tools", action: "probe", phase: "unknown" }]);
      assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
      assert.match(h.get("managedTaskRows").textContent, /模型工具验证.*提交结果未知.*尚未确认/);
      assert.doesNotMatch(h.get("managedTaskRows").textContent, /正在处理|正在重试|表情/);
      h.setReply(() => { throw failure(status); });
      await assert.rejects(tasks.resumeManagedTasks());
      assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
      await assert.rejects(tasks.callManagedAction("probeAgentTools", { action: "probe" }), /勿重复提交/);
      assert.equal(JSON.parse(h.session.get(SCOPES))[0].module, "agent_tools");
      assertReadOnly(h);
    });
  }

  for (const entries of [[], [task("done", { id: OLD_ID })]]) {
    test("an empty or unrelated terminal history cannot clear an unidentified probe scope", async () => {
      const { h, tasks } = await fixture([{ module: "agent_tools", action: "probe", phase: "unknown" }]);
      h.setReply(() => ({ tasks: entries }));
      await tasks.resumeManagedTasks(); await flush();
      assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
      assert.match(h.get("managedTaskNotice").textContent, /未知范围继续阻止重复提交/);
      assert.match(h.get("managedTaskRows").textContent, /提交结果未知/);
      assert.equal(h.calls.length, 1);
      assertReadOnly(h);
    });
  }

  test("a missing known probe record retains its ID and unknown scope across refresh", async () => {
    const { h, tasks } = await fixture([task("unknown")]);
    h.session.set(IDS, JSON.stringify([ID]));
    h.setReply(() => ({ tasks: [] }));
    await tasks.resumeManagedTasks();
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.deepEqual(JSON.parse(h.session.get(IDS)), [ID]);
    assert.match(h.get("managedTaskRows").textContent, new RegExp(ID));
    assertReadOnly(h);
  });

  test("malformed task directories keep the restored unknown scope and old visible records", async () => {
    const { h, tasks } = await fixture([task("unknown")]);
    h.setReply(() => ({ tasks: [{ id: ID, phase: "done" }] }));
    await assert.rejects(tasks.resumeManagedTasks(), /响应不完整/);
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.match(h.get("managedTaskRows").textContent, /模型工具验证/);
    assertReadOnly(h);
  });

  test("another running probe cannot replace a missing known task identity", async () => {
    const { h, tasks } = await fixture([task("unknown")]);
    h.session.set(IDS, JSON.stringify([ID]));
    h.setReply(() => ({ tasks: [task("running", { id: OLD_ID })] }));
    await tasks.resumeManagedTasks(); await flush();
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.equal(JSON.parse(h.session.get(SCOPES))[0].id, ID);
    assert.deepEqual(JSON.parse(h.session.get(IDS)), [ID]);
    assert.equal(h.calls.length, 1);
    assertReadOnly(h);
  });

  test("a real running record replaces unknown scope and completion refreshes capabilities with GETs only", async () => {
    const { h, tasks, state } = await fixture([{ module: "agent_tools", action: "probe", phase: "unknown" }]);
    const finishing = deferred();
    const snapshot = capabilities();
    h.setReply((action, payload) => {
      if (action === "getCapabilities") return snapshot;
      assert.equal(action, "getTasks");
      return payload?.id ? finishing.promise : { tasks: [task("running")] };
    });
    await tasks.resumeManagedTasks();
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.match(h.get("managedTaskRows").textContent, /模型工具验证.*正在处理/);
    finishing.resolve({ task: task() }); await flush();
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), false);
    assert.deepEqual(JSON.parse(h.session.get(SCOPES)), []);
    assert.deepEqual(JSON.parse(h.session.get(IDS)), []);
    assert.equal(state.uiState.capabilitySnapshot, snapshot);
    assert.match(h.get("capabilityNotice").textContent, /已确认完成/);
    assert.equal(h.get("activityBar").classes.has("success"), true);
    assert.equal(h.calls.filter(call => call.action === "getCapabilities").length, 1);
    assertReadOnly(h);
  });

  test("an unreadable individual probe remains unknown and blocked after all GET retries", async () => {
    const { h, tasks } = await fixture([task("unknown")]);
    h.setReply((action, payload) => {
      assert.equal(action, "getTasks");
      if (payload?.id) throw failure(503);
      return { tasks: [task("running")] };
    });
    await tasks.resumeManagedTasks(); await flush();
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.equal(h.calls.filter(call => call.payload?.id).length, 4);
    assert.match(h.get("managedTaskRows").textContent, /尚未确认/);
    assert.match(h.get("capabilityNotice").textContent, /尚未确认/);
    assert.equal(h.get("capabilityPanel").attributes["aria-busy"], "false");
    assert.equal(h.get("activityBar").classes.has("success"), false);
    assertReadOnly(h);
  });

  test("the latest completed probe is shown and inspected without resubmitting historical tasks", async () => {
    const { h, tasks } = await fixture();
    h.setReply((action, payload) => action === "getCapabilities" ? capabilities() : payload?.id
      ? { task: task() } : { tasks: [task("done", { id: OLD_ID }), task()] });
    await tasks.resumeManagedTasks(); await flush();
    const rows = h.get("managedTaskRows").textContent;
    assert.match(rows, new RegExp(OLD_ID)); assert.match(rows, new RegExp(ID));
    assert.doesNotMatch(rows, /暂无后台任务|表情/);
    assert.match(h.get("managedTaskNotice").textContent, /2 条任务记录/);
    assert.deepEqual(h.calls.filter(call => call.payload?.id).map(call => call.payload.id), [ID]);
    assert.equal(h.calls.filter(call => call.action === "getCapabilities").length, 1);
    assertReadOnly(h);
  });

  test("a terminal list record is not marked successful when its result cache cannot be read", async () => {
    const { h, tasks } = await fixture();
    h.setReply((action, payload) => action === "getCapabilities" ? capabilities() : payload?.id
      ? { task: task("done", { resultAvailable: false, result: undefined }) } : { tasks: [task()] });
    await tasks.resumeManagedTasks(); await flush();
    assert.match(h.get("managedTaskRows").textContent, /结果缓存不可用/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
    assert.equal(h.calls.filter(call => call.action === "getCapabilities").length, 1);
    assertReadOnly(h);
  });

  test("a readable but incomplete terminal result cannot claim successful proof completion", async () => {
    const { h, tasks } = await fixture();
    h.setReply((action, payload) => action === "getCapabilities" ? capabilities() : payload?.id
      ? { task: task("done", { result: {} }) } : { tasks: [task()] });
    await tasks.resumeManagedTasks(); await flush();
    assert.equal(h.get("activityBar").classes.has("success"), false);
    assert.match(h.get("capabilityNotice").textContent, /任务结果尚未完整确认/);
    assertReadOnly(h);
  });

  for (const phase of ["failed", "interrupted", "cancelled"]) {
    test(`${phase} probe completion refreshes actual proof but never claims success`, async () => {
      const { h, tasks, state } = await fixture([task("unknown")]);
      const snapshot = capabilities({ status: "partial" });
      h.setReply((action, payload) => action === "getCapabilities" ? snapshot : payload?.id
        ? { task: task(phase, { error: "synthetic terminal outcome", result: { ok: false } }) }
        : { tasks: [task(phase)] });
      await tasks.resumeManagedTasks(); await flush();
      assert.equal(tasks.managedTaskIsBlocked("agent_tools"), false);
      assert.equal(state.uiState.capabilitySnapshot, snapshot);
      assert.equal(state.uiState.capabilitiesLoaded, true);
      assert.equal(h.get("activityBar").classes.has("success"), false);
      assert.doesNotMatch(h.get("capabilityNotice").textContent, /能力读取失败/);
      assertReadOnly(h);
    });
  }

  const invalidProofs = [
    ["partial", proof => { proof.status = "partial"; }],
    ["pending", proof => { proof.status = "pending"; }],
    ["QA", proof => { proof.provenance = "qa"; }],
    ["old provenance", proof => { delete proof.provenance; }],
    ["expired", proof => { proof.slots[0].expiresAt = 1; }],
    ["unknown model", proof => { proof.slots[0].model = ""; }],
    ["illegal model", proof => { proof.slots[0].model = "https://synthetic.invalid/model"; }],
    ["missing slot", proof => { proof.slots.pop(); }],
  ];
  for (const [name, invalidate] of invalidProofs) {
    test(`${name} proof cannot become successful resumed-task feedback`, async () => {
      const { h, tasks, state } = await fixture();
      const snapshot = capabilities(); invalidate(snapshot.agentTools.compatibility);
      h.setReply((action, payload) => action === "getCapabilities" ? snapshot : payload?.id
        ? { task: task() } : { tasks: [task()] });
      await tasks.resumeManagedTasks(); await flush();
      assert.equal(state.uiState.capabilitySnapshot, snapshot);
      assert.equal(h.get("activityBar").classes.has("success"), false);
      assert.match(h.get("capabilityNotice").textContent, /证据尚未完整确认/);
      assert.equal(h.get("capabilityPanel").attributes["aria-busy"], "false");
      assertReadOnly(h);
    });
  }

  test("capability GET denial reports read failure without inventing probe success or retrying POST", async () => {
    const { h, tasks, state } = await fixture();
    h.setReply((action, payload) => {
      if (action === "getCapabilities") throw failure(403);
      return payload?.id ? { task: task() } : { tasks: [task()] };
    });
    await tasks.resumeManagedTasks(); await flush();
    assert.equal(state.uiState.capabilitiesLoaded, false);
    assert.match(h.get("capabilityNotice").textContent, /无权读取/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
    assertReadOnly(h);
  });

  test("proof pending alone is never projected as an actual task or live process", async () => {
    const { h, tasks, state } = await fixture();
    state.uiState.capabilitySnapshot = capabilities({ status: "pending" });
    h.setReply(() => ({ tasks: [] }));
    await tasks.resumeManagedTasks(); await flush();
    assert.match(h.get("managedTaskRows").textContent, /暂无后台任务/);
    assert.doesNotMatch(tasks.taskPhaseLabel("pending"), /正在|仍在运行/);
    assertReadOnly(h);
  });

  test("stickers and replay retain their labels, recovery GETs and existing scope resolution", async () => {
    const saved = [task("unknown", { id: ID, module: "stickers", action: "sync" }),
      task("unknown", { id: OLD_ID, module: "replay", action: "generate" })];
    const { h, tasks } = await fixture(saved);
    h.setReply((action, payload) => action === "getStickers" ? uiFixtureData().stickers : payload?.id
      ? { task: saved.find(item => item.id === payload.id) && { ...saved.find(item => item.id === payload.id), phase: "done" } }
      : { tasks: saved.map(item => ({ ...item, phase: "running" })) });
    await tasks.resumeManagedTasks(); await flush();
    assert.match(h.get("managedTaskRows").textContent, /表情/);
    assert.match(h.get("managedTaskRows").textContent, /对话回放/);
    assert.equal(tasks.managedTaskIsBlocked("stickers"), false);
    assert.equal(tasks.managedTaskIsBlocked("replay"), false);
    assert.equal(h.calls.some(call => call.action === "getCapabilities"), false);
    assert.equal(h.calls.filter(call => call.action === "getStickers").length, 1);
    assertReadOnly(h);
  });

  test("terminal failure has taskTerminal while submission/query uncertainty has only taskStateUnknown", async () => {
    const { h, tasks } = await fixture();
    h.setReply(action => action === "startTask" ? { jobId: ID } : { task: task("failed", { result: { ok: false } }) });
    await assert.rejects(tasks.callManagedAction("probeAgentTools", { action: "probe" }), error => error.taskTerminal === true && !error.taskStateUnknown);
    h.setReply(() => { throw Object.assign(new Error("synthetic timeout"), { transportFailure: true }); });
    await assert.rejects(tasks.callManagedAction("probeAgentTools", { action: "probe" }), error => error.taskStateUnknown === true && !error.taskTerminal);
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 2);
  });

  test("individual query uncertainty has taskStateUnknown, never taskTerminal, and retains the scope", async () => {
    const { h, tasks } = await fixture();
    h.setReply(action => {
      if (action === "startTask") return { jobId: ID };
      throw failure(503);
    });
    await assert.rejects(tasks.callManagedAction("probeAgentTools", { action: "probe" }), error => error.taskStateUnknown === true && !error.taskTerminal);
    assert.equal(tasks.managedTaskIsBlocked("agent_tools"), true);
    assert.equal(h.calls.filter(call => call.action === "startTask").length, 1);
    assert.equal(h.calls.filter(call => call.action === "getTasks").length, 4);
    assert.deepEqual(JSON.parse(h.session.get(IDS)), [ID]);
  });
}
