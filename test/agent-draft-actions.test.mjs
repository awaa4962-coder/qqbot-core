import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const ID = "c96cf9b3-51be-4fd8-9c22-47763f884144";
const OTHER_ID = "21d770d8-295e-40bc-823c-5edb0d435192";
const START = Date.parse("2026-10-01T00:00:00Z");

function node(document, tag = "div", id = "") {
  let text = ""; let html = "";
  const classes = new Set();
  return {
    ownerDocument: document, tagName: tag.toUpperCase(), id, children: [], dataset: {}, attributes: {}, style: {},
    className: "", value: "", disabled: false, scrollTop: 0, scrollLeft: 0,
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); this.children = []; },
    insertAdjacentHTML() { assert.fail("draft markup insertion forbidden"); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    classList: {
      add(...names) { for (const name of names) { assert.doesNotMatch(name, /\s/); classes.add(name); } },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      return descendants(this).slice(1).filter(item => selector.startsWith(".")
        ? item.className.split(" ").includes(selector.slice(1)) : item.tagName === selector.toUpperCase());
    },
    addEventListener() { assert.fail("controller must not install hidden handlers"); },
  };
}

const descendants = element => [element, ...element.children.flatMap(descendants)];
const find = (element, tag) => descendants(element).filter(item => item.tagName === tag.toUpperCase());
const job = (extra = {}) => ({ id: ID, action: "daily", phase: "queued", startedAt: START, resultAvailable: false, ...extra });
const result = (extra = {}) => ({ text: "A cleaned draft.", coverage: { captured: 3, complete: false }, sent: false, persisted: false, ...extra });
function completed(extra = {}) {
  const task = job({ phase: "done", finishedAt: START + 1000, resultAvailable: true });
  return { status: "ready", enabled: true, tasks: [task], task: { ...task, result: result() }, ...extra };
}
const metadata = (tasks = completed().tasks, enabled = true) => ({ status: "ready", enabled, tasks });
const selected = task => ({ status: "ready", enabled: true, tasks: [task], task: { ...task } });
const ack = (cancelRequested = true, phase = "cancelling") => ({ ok: true, task: { jobId: ID, cancelRequested, phase } });
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function environment({ allowStickerPagehide = false } = {}) {
  const nodes = new Map(); const calls = []; const pagehideListeners = [];
  let document; let reply = () => assert.fail("unexpected host request");
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, node(document, "div", id));
    return nodes.get(id);
  };
  document = { createElement: tag => node(document, tag), getElementById: element,
    querySelectorAll: () => [], addEventListener: () => assert.fail("global listener forbidden") };
  document.body = element("body");
  const forbidden = () => assert.fail("network, storage, real timers and backend I/O forbidden");
  const host = { mode: "browser", async call(action, payload) { calls.push({ action, payload }); return reply(action, payload); } };
  const window = { QQFriendHost: host, setTimeout: () => 1, clearTimeout() {}, addEventListener(type, listener) {
    if (!allowStickerPagehide) forbidden();
    assert.equal(type, "pagehide"); assert.equal(listener.name, "disposeStickerPreviews");
    pagehideListeners.push(listener);
  } };
  Object.defineProperty(window, "localStorage", { get: forbidden });
  Object.defineProperty(window, "sessionStorage", { get: forbidden });
  const context = vm.createContext({ document, window, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    setTimeout: forbidden, setInterval: forbidden, MutationObserver: forbidden, localStorage: new Proxy({}, { get: forbidden }) });
  const modules = new Map();
  const load = file => {
    assert.ok(file.startsWith(ROOT), "only browser modules may load");
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  };
  const entry = async name => {
    const module = load(path.join(ROOT, name));
    await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
    await module.evaluate(); return module.namespace;
  };
  const actions = await entry("ui/agent-draft-actions.js");
  const capabilities = await entry("pages/capabilities.js");
  const renderer = modules.get(path.join(ROOT, "agent-drafts.js")).namespace;
  const state = modules.get(path.join(ROOT, "ui/state.js")).namespace.uiState;
  const button = (id = ID) => { const value = node(document, "button"); value.dataset.taskId = id; value.textContent = "合成操作"; return value; };
  const run = (action, id = ID) => actions.runAgentDraftAction(action, button(id));
  const panel = () => element("agentDraftsPanel");
  const pre = () => find(panel(), "pre")[0];
  const cap = drafts => capabilities.renderCapabilities({ categories: [], capabilities: [], agentDrafts: drafts });
  return { actions, capabilities, renderer, state, host, calls, element, run, panel, pre, cap, entry, pagehideListeners, setReply: fn => { reply = fn; } };
}

function feedback(h, tone) {
  const message = h.element("agentDraftActionStatus").textContent;
  assert.equal(h.element("activityTitle").textContent, message);
  assert.equal(h.element("activityDetail").textContent, message);
  assert.equal(h.element("activityBar").classList.contains(tone), true);
  assert.equal(h.element("toast").classList.contains(tone), true);
  return message;
}

if (!vm.SourceTextModule) {
  test("agent draft controller executes actual isolated VM cases", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 32 })));
  });
} else {
  test("controller imports and shared validators remain passive and use the actual renderer", async () => {
    const h = await environment();
    assert.equal(h.calls.length, 0); assert.equal(h.panel().children.length, 0);
    for (const name of ["validateAgentDraftSnapshot", "isAgentDraftTaskId", "isAgentDraftTerminalPhase"]) assert.equal(typeof h.renderer[name], "function");
    assert.equal(typeof h.actions.renderAgentDraftSnapshot, "function"); assert.equal(typeof h.actions.invalidateAgentDraftView, "function");
    assert.equal(h.actions.isAgentDraftAction("cancelAgentDraft"), true);
    await h.actions.runAgentDraftAction("unknownAction"); assert.equal(h.calls.length, 0);
  });

  test("validator accepts only complete ready metadata without inventing empty tasks or enabled defaults", async () => {
    const h = await environment(); const validate = h.renderer.validateAgentDraftSnapshot;
    for (const enabled of [true, false]) assert.equal(validate(metadata([], enabled)), true);
    assert.equal(validate(completed()), true); assert.equal(validate(completed(), { id: ID, requireResult: true }), true);
    assert.equal(validate(metadata(), { requireResult: true }), false);
    assert.equal(validate(completed(), { id: OTHER_ID }), false);
  });

  test("validator rejects legacy missing malformed inherited and partial DTOs", async () => {
    const h = await environment();
    for (const value of [null, [], {}, completed({ status: "unavailable" }), completed({ status: "success" }),
      completed({ enabled: undefined }), completed({ enabled: "true" }), completed({ tasks: undefined }),
      metadata([{}]), metadata(new Array(1)), metadata([job({ resultAvailable: undefined })]), metadata([job({ resultAvailable: 1 })]),
      metadata([job({ phase: "running" })]), metadata([job({ action: "constructor" })]), metadata([job({ startedAt: "123" })]),
      metadata([job({ id: ID + "\n" })]), metadata([job(), job({ id: ID.toUpperCase() })]), Object.create(completed())]) {
      assert.equal(h.renderer.validateAgentDraftSnapshot(value), false);
    }
  });

  test("selected tasks must match list identity action start phase and Boolean availability", async () => {
    const h = await environment();
    for (const extra of [{ id: OTHER_ID }, { action: "conversation" }, { startedAt: START - 1 }, { phase: "failed" }, { resultAvailable: false }]) {
      const data = completed(); Object.assign(data.task, extra);
      assert.equal(h.renderer.validateAgentDraftSnapshot(data), false);
    }
    assert.equal(h.renderer.validateAgentDraftSnapshot(completed({ tasks: [] })), false);
  });

  test("result validation requires actual false flags safe text and structured coverage", async () => {
    const h = await environment();
    for (const extra of [{ sent: undefined }, { sent: 0 }, { sent: true }, { persisted: "false" }, { persisted: undefined },
      { coverage: undefined }, { coverage: [] }, { text: "Bearer SYNTHETIC-PRIVATE" }, { text: "a".repeat(32769) }, { text: {} }]) {
      const data = completed(); data.task.result = result(extra);
      assert.equal(h.renderer.validateAgentDraftSnapshot(data, { requireResult: true }), false);
    }
    const data = completed(); data.task.result = Object.create(result());
    assert.equal(h.renderer.validateAgentDraftSnapshot(data), false);
    const list = metadata(); Object.defineProperty(list.tasks[0], "result", { get: () => assert.fail("list body read") });
    assert.equal(h.renderer.validateAgentDraftSnapshot(list), true);
  });

  test("R2 canonicalized Basic Unicode credentials and paths fail validation and cannot report loaded success", async () => {
    const h = await environment(); const credential = "c3ludGhldGljOnNlY3JldA==";
    for (const text of ["Basic " + credential, "Digest response=\"SYNTHETIC_SECRET\"", "ａｐｉ＿ｋｅｙ=SYNTHETIC_SECRET",
      "Ａｕｔｈｏｒｉｚａｔｉｏｎ＝Ｂａｓｉｃ " + credential, "api_\u00adkey=SYNTHETIC_SECRET",
      "Ｂａ\u2063ｓｉｃ " + credential, "Ｃ：／srv／private／key", "local_path=／srv／private／key"]) {
      const data = completed(); data.task.result.text = text;
      assert.equal(h.renderer.validateAgentDraftSnapshot(data, { requireResult: true }), false);
      h.actions.renderAgentDraftSnapshot(completed()); h.setReply(() => data); await h.run("inspectAgentDraft");
      assert.equal(h.pre(), undefined); assert.match(feedback(h, "error"), /读取失败/);
      assert.doesNotMatch(h.panel().textContent, /SYNTHETIC_SECRET|c3ludGhldGlj|private|已载入/);
    }
  });

  test("draft_failed and interrupted map safely while missing backend resultAvailable stays invalid", async () => {
    const h = await environment();
    for (const [phase, error, label] of [["failed", "draft_failed", "草稿未完成"], ["interrupted", "interrupted", "任务已中断"]]) {
      const data = selected(job({ phase, error }));
      assert.equal(h.renderer.validateAgentDraftSnapshot(data), true);
      assert.equal(h.actions.renderAgentDraftSnapshot(data), true);
      assert.match(h.panel().textContent, new RegExp(label)); assert.doesNotMatch(h.panel().textContent, /错误未知|draft_failed|interrupted/);
    }
    const old = metadata([job({ phase: "interrupted", error: "interrupted", resultAvailable: undefined })]);
    assert.equal(h.actions.renderAgentDraftSnapshot(old), false); assert.match(h.panel().textContent, /状态无法读取/);
  });

  test("invalid task IDs cannot cause host reads or writes", async () => {
    const h = await environment();
    for (const id of [undefined, "123456789", ID + "\n", "../private", "00000000-0000-0000-0000-000000000000"]) {
      await h.run("inspectAgentDraft", id === undefined ? null : id);
      await h.run("cancelAgentDraft", id === undefined ? null : id);
    }
    assert.equal(h.calls.length, 0);
  });

  test("completed inspect renders an inert preview and calls activity with correct title state detail", async () => {
    const h = await environment(); const data = completed();
    data.task.result.text = '<img src=x onerror="alert(1)">';
    const before = JSON.stringify(data); h.setReply(() => data);
    await h.run("inspectAgentDraft");
    assert.equal(h.pre().textContent, data.task.result.text); assert.equal(h.pre().children.length, 0);
    assert.equal(find(h.panel(), "img").length, 0); assert.equal(JSON.stringify(data), before);
    assert.match(feedback(h, "success"), /草稿已载入/);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, "getAgentDrafts"); assert.equal(h.calls[0].payload.id, ID);
  });

  test("the actual actions router delegates draft inspection without using generic managed task submission", async () => {
    const h = await environment({ allowStickerPagehide: true }); const router = await h.entry("ui/actions.js");
    const button = h.element("syntheticRouteButton"); button.dataset.taskId = ID;
    h.setReply(action => { assert.equal(action, "getAgentDrafts"); return completed(); });
    await router.runAction("inspectAgentDraft", button);
    assert.equal(h.calls.length, 1); assert.equal(h.pre().textContent, "A cleaned draft.");
    assert.match(feedback(h, "success"), /已载入/);
    assert.equal(h.state.activeActions.size, 0);
    assert.equal(h.pagehideListeners.length, 1);
  });

  test("bad DTOs are rejected before any success feedback and clear an older loaded preview", async () => {
    const h = await environment();
    for (const value of [{ status: "ready", tasks: [], task: { id: ID } }, completed({ enabled: undefined }),
      completed({ task: { id: ID } }), completed({ tasks: [job({ phase: "unknown" })] }),
      completed({ task: { ...completed().task, result: result({ sent: true }) } })]) {
      h.actions.renderAgentDraftSnapshot(completed()); h.setReply(() => value);
      await h.run("inspectAgentDraft");
      assert.equal(h.pre(), undefined); assert.match(feedback(h, "error"), /读取失败/);
      assert.doesNotMatch(h.element("toast").textContent, /已载入|已读取|成功/);
    }
  });

  test("failed interrupted unavailable and unfinished results do not receive successful inspect feedback", async () => {
    const h = await environment();
    for (const phase of ["failed", "interrupted", "cancelled", "queued", "done"]) {
      h.setReply(() => selected(job({ phase })));
      await h.run("inspectAgentDraft"); assert.equal(h.pre(), undefined);
      assert.match(feedback(h, "error"), /未完成或不可读/);
    }
    const missing = completed(); delete missing.task.result; h.setReply(() => missing);
    await h.run("inspectAgentDraft"); assert.equal(h.pre(), undefined); assert.match(feedback(h, "error"), /不可读/);
  });

  test("enabled false cannot expose a selected body or produce inspect success", async () => {
    const h = await environment(); h.actions.renderAgentDraftSnapshot(completed());
    h.setReply(() => completed({ enabled: false })); await h.run("inspectAgentDraft");
    assert.equal(h.pre(), undefined); assert.match(h.panel().textContent, /未开放/);
    assert.match(feedback(h, "error"), /未开放/);
  });

  test("unknown contradictory or wrong-target cancellation acknowledgements cause exactly one write", async () => {
    const h = await environment();
    for (const value of [undefined, {}, { ok: false }, ack("true"), ack(true, "done"), ack(false, "collecting"),
      { ok: true, task: { jobId: OTHER_ID, phase: "cancelling", cancelRequested: true } }]) {
      const before = h.calls.length; h.setReply(() => value); await h.run("cancelAgentDraft");
      assert.equal(h.calls.length - before, 1); assert.equal(h.calls.at(-1).action, "cancelAgentDraft");
      assert.match(feedback(h, "error"), /未确认.*没有自动重发/); assert.equal(h.pre(), undefined);
    }
  });

  test("lost cancellation ACK never retries POST or infers cancellation success", async () => {
    const h = await environment(); h.setReply(() => { throw new Error("synthetic_transport_lost"); });
    await h.run("cancelAgentDraft"); assert.equal(h.calls.length, 1);
    assert.match(feedback(h, "error"), /取消结果未确认/); assert.doesNotMatch(h.panel().textContent, /已取消|已停止/);
  });

  test("cancelRequested false means ended without cancellation for every terminal phase", async () => {
    const h = await environment();
    for (const phase of ["done", "failed", "interrupted", "cancelled"]) {
      const before = h.calls.length; h.setReply(action => action === "cancelAgentDraft" ? ack(false, phase) : selected(job({ phase })));
      await h.run("cancelAgentDraft"); assert.equal(h.calls.length - before, 2);
      assert.match(feedback(h, "error"), /任务已结束，本次未取消/);
      assert.doesNotMatch(h.element("agentDraftActionStatus").textContent, /请求已确认|请求已记录|后台已确认/);
    }
  });

  test("acknowledged cancelling remains a request rather than already stopped", async () => {
    const h = await environment(); h.setReply(action => action === "cancelAgentDraft" ? ack() : selected(job({ phase: "cancelling" })));
    await h.run("cancelAgentDraft"); assert.match(feedback(h, "success"), /请求已确认.*尚未确认停止/);
    assert.doesNotMatch(h.panel().textContent, /已停止|已取消/);
    const cancel = find(h.panel(), "button").find(value => value.dataset.action === "cancelAgentDraft");
    assert.equal(cancel.disabled, true); assert.equal(cancel.textContent, "取消中");
  });

  test("only a fresh cancelled task confirms cancellation and other terminal results stay unconfirmed", async () => {
    const h = await environment();
    for (const phase of ["cancelled", "done", "failed", "interrupted"]) {
      h.setReply(action => action === "cancelAgentDraft" ? ack() : selected(job({ phase })));
      await h.run("cancelAgentDraft");
      if (phase === "cancelled") assert.match(feedback(h, "success"), /后台已确认任务取消/);
      else assert.match(feedback(h, "error"), /取消未获确认/);
    }
  });

  test("true cancellation ACK followed by read failure keeps ACK wording without a second POST", async () => {
    const h = await environment(); h.setReply(action => { if (action === "cancelAgentDraft") return ack(); throw new Error("synthetic_read_failure"); });
    await h.run("cancelAgentDraft");
    assert.equal(h.calls.filter(value => value.action === "cancelAgentDraft").length, 1);
    assert.match(feedback(h, "error"), /请求已确认.*状态未读到.*没有重新提交/);
  });

  test("false cancellation ACK followed by read failure never becomes an acknowledged request", async () => {
    const h = await environment(); h.setReply(action => { if (action === "cancelAgentDraft") return ack(false, "done"); throw new Error("synthetic_read_failure"); });
    await h.run("cancelAgentDraft"); assert.equal(h.calls.length, 2);
    assert.match(feedback(h, "error"), /本次未取消.*读取失败/);
    assert.doesNotMatch(h.element("agentDraftActionStatus").textContent, /取消请求已确认/);
  });

  test("403 capability failure invalidates an in-flight inspect so a late body cannot return", async () => {
    const h = await environment(); const gate = deferred(); h.setReply(() => gate.promise);
    const pending = h.run("inspectAgentDraft");
    h.capabilities.capabilityReadFailed(Object.assign(new Error("synthetic_denied"), { status: 403 }));
    const notice = h.element("agentDraftActionStatus").textContent;
    gate.resolve(completed()); await pending;
    assert.equal(h.pre(), undefined); assert.equal(h.element("agentDraftActionStatus").textContent, notice);
    assert.equal(h.state.capabilitiesLoaded, false); assert.doesNotMatch(h.panel().textContent, /A cleaned/);
  });

  test("503 clears an already loaded body and a delayed rejection cannot clear a newer view", async () => {
    const h = await environment(); h.actions.renderAgentDraftSnapshot(completed()); assert.ok(h.pre());
    const gate = deferred(); h.setReply(() => gate.promise); const pending = h.run("inspectAgentDraft");
    h.capabilities.capabilityReadFailed(Object.assign(new Error("synthetic_unavailable"), { status: 503 }));
    assert.equal(h.pre(), undefined);
    const fresh = completed(); fresh.task.result.text = "A newly loaded draft.";
    h.actions.renderAgentDraftSnapshot(fresh); gate.reject(new Error("synthetic_old_failure")); await pending;
    assert.equal(h.pre().textContent, "A newly loaded draft.");
  });

  test("R2 actual capability refresh routing uses safe labels in notice toast and activity without raw exceptions", async () => {
    const h = await environment({ allowStickerPagehide: true }); const router = await h.entry("ui/actions.js");
    const raw = "Bearer SYNTHETIC_ERROR_TOKEN /srv/private/key";
    for (const status of [undefined, 0, 401, 403, 404, 500, 503]) {
      h.actions.renderAgentDraftSnapshot(completed()); const error = Object.assign(new Error(raw), { status });
      h.setReply(action => { assert.equal(action, "getCapabilities"); throw error; });
      await router.runAction("refreshCapabilities"); assert.equal(h.pre(), undefined);
      for (const id of ["capabilityNotice", "toast", "activityTitle", "activityDetail", "agentDraftActionStatus"]) {
        assert.doesNotMatch(h.element(id).textContent, /Bearer|SYNTHETIC_ERROR_TOKEN|\/srv\/|private\/key/);
      }
      assert.doesNotMatch(error.message, /Bearer|SYNTHETIC_ERROR_TOKEN|\/srv\/|private\/key/);
      assert.match(h.element("capabilityNotice").textContent, [401, 403].includes(status) ? /无权读取/ : /能力读取失败/);
      assert.equal(h.state.capabilitiesLoaded, false);
    }
  });

  test("R2 immutable capability exceptions fail closed with a safe replacement error and no revived body", async () => {
    const h = await environment({ allowStickerPagehide: true }); const router = await h.entry("ui/actions.js");
    h.actions.renderAgentDraftSnapshot(completed());
    const error = Object.freeze(Object.assign(new Error("Bearer SYNTHETIC_ERROR_TOKEN /srv/private/key"), { status: 503 }));
    h.setReply(() => { throw error; });
    await assert.rejects(router.runAction("refreshCapabilities"), value => value.message === "能力读取失败：服务暂不可用。");
    assert.equal(h.pre(), undefined); assert.doesNotMatch(h.element("capabilityNotice").textContent, /Bearer|SYNTHETIC_ERROR_TOKEN|\/srv\/|private/);
    assert.equal(h.state.activeActions.size, 0);
  });

  test("a received disabled capability snapshot replaces the generation before late inspect delivery", async () => {
    const h = await environment(); const gate = deferred(); h.setReply(() => gate.promise);
    const pending = h.run("inspectAgentDraft"); h.cap(metadata(completed().tasks, false));
    gate.resolve(completed()); await pending;
    assert.equal(h.pre(), undefined); assert.match(h.panel().textContent, /未开放/);
    assert.match(h.element("agentDraftActionStatus").textContent, /未开放/);
  });

  test("fresh expired or forgotten availability overrides a pending older body", async () => {
    const h = await environment(); const gate = deferred(); h.setReply(() => gate.promise);
    const pending = h.run("inspectAgentDraft");
    h.cap(metadata([job({ phase: "done", resultAvailable: false })]));
    gate.resolve(completed()); await pending;
    assert.equal(h.pre(), undefined); assert.doesNotMatch(h.panel().textContent, /A cleaned/);
    const inspect = find(h.panel(), "button").find(value => value.dataset.action === "inspectAgentDraft");
    assert.equal(inspect.disabled, true);
  });

  test("fresh matching list retains a loaded preview and scroll position without changing incoming DTO", async () => {
    const h = await environment(); h.actions.renderAgentDraftSnapshot(completed());
    h.pre().scrollTop = 123; h.pre().scrollLeft = 17;
    const fresh = metadata(); const before = JSON.stringify(fresh); h.cap(fresh);
    assert.equal(h.pre().textContent, "A cleaned draft."); assert.equal(h.pre().scrollTop, 123); assert.equal(h.pre().scrollLeft, 17);
    assert.equal(JSON.stringify(fresh), before); assert.equal(Object.hasOwn(fresh, "task"), false);
    assert.equal(h.calls.length, 0);
  });

  test("retention clears on changed identity action start phase availability disappearance or bad metadata", async () => {
    const h = await environment();
    for (const data of [metadata([job({ id: OTHER_ID, phase: "done", resultAvailable: true })]),
      metadata([job({ action: "conversation", phase: "done", resultAvailable: true })]),
      metadata([job({ startedAt: START - 1, phase: "done", resultAvailable: true })]),
      metadata([job({ phase: "failed", resultAvailable: true })]), metadata([job({ phase: "done", resultAvailable: false })]),
      metadata([]), metadata(undefined, false), metadata([job({ resultAvailable: undefined })]), { status: "unavailable" }]) {
      h.actions.renderAgentDraftSnapshot(completed()); h.cap(data); assert.equal(h.pre(), undefined);
    }
  });

  test("explicit list refresh preserves only the still-confirmed selected preview", async () => {
    const h = await environment(); h.actions.renderAgentDraftSnapshot(completed()); h.setReply(() => metadata());
    await h.run("refreshAgentDrafts"); assert.equal(h.pre().textContent, "A cleaned draft.");
    assert.deepEqual(Object.keys(h.calls[0].payload), []); assert.match(feedback(h, "success"), /已刷新/);
    h.setReply(() => metadata([job({ phase: "done", resultAvailable: false })]));
    await h.run("refreshAgentDrafts"); assert.equal(h.pre(), undefined);
  });

  test("late cancel ACK after a newer capability snapshot cannot trigger a follow-up read or overwrite it", async () => {
    const h = await environment(); const gate = deferred(); h.setReply(() => gate.promise);
    const pending = h.run("cancelAgentDraft"); h.cap(metadata([], false));
    const notice = h.element("agentDraftActionStatus").textContent; gate.resolve(ack()); await pending;
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, "cancelAgentDraft");
    assert.equal(h.element("agentDraftActionStatus").textContent, notice); assert.match(h.panel().textContent, /未开放/);
  });

  test("malformed capability envelopes clear preview and invalidate a pending body before throwing", async () => {
    const h = await environment(); h.actions.renderAgentDraftSnapshot(completed());
    const gate = deferred(); h.setReply(() => gate.promise); const pending = h.run("inspectAgentDraft");
    assert.throws(() => h.capabilities.renderCapabilities({ categories: [], capabilities: [null] }), /响应不完整/);
    assert.equal(h.pre(), undefined); gate.resolve(completed()); await pending; assert.equal(h.pre(), undefined);
  });

  test("every capability read failure clears cached preview and prevents later metadata from reviving it", async () => {
    const h = await environment();
    for (const status of [undefined, 0, 401, 403, 409, 503]) {
      h.actions.renderAgentDraftSnapshot(completed()); assert.ok(h.pre());
      h.capabilities.capabilityReadFailed(Object.assign(new Error("synthetic_failure"), { status }));
      assert.equal(h.pre(), undefined); h.cap(metadata()); assert.equal(h.pre(), undefined);
    }
  });
}
