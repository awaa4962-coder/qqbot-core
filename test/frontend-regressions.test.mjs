import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const flush = () => setImmediate();

function node(id = "") {
  const classes = new Set();
  return {
    id, value: "", textContent: "", innerHTML: "", dataset: {}, tagName: "INPUT", disabled: false, children: [], listeners: {},
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), toggle(name, yes) { if (yes) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    setAttribute() {}, removeAttribute() {}, focus() {}, insertAdjacentHTML() {},
    querySelectorAll() { return []; },
    replaceChildren() { this.children = []; this.value = ""; },
    append(child) { this.children.push(child); if (!this.value) this.value = child.value || ""; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

function harness() {
  const nodes = new Map(); const session = new Map(); const editors = [];
  const element = id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); };
  const listeners = new Map(); const events = [];
  const windowListeners = new Map();
  const document = {
    visibilityState: "visible", body: node(), documentElement: node(),
    getElementById: element, createElement: () => node(),
    querySelectorAll: selector => selector === "[data-list-editor-for]" ? editors : [],
    querySelector: selector => element(selector),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  };
  const host = { mode: "browser", call: async () => { throw new Error("unexpected host call"); } };
  const created = []; const revoked = [];
  const window = {
    QQFriendHost: host, confirm: () => true, prompt: () => "",
    addEventListener(type, callback) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(callback); },
    setTimeout(callback) { Promise.resolve().then(callback); return 1; }, clearTimeout() {},
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    URL: { createObjectURL(blob) { const url = "blob:synthetic-" + created.length; created.push({ url, blob }); return url; }, revokeObjectURL: url => revoked.push(url) },
    dispatchEvent(event) { events.push(event); for (const callback of windowListeners.get(event.type) || []) callback(event); },
  };
  const context = vm.createContext({ window, document, MutationObserver: class { observe() {} }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } });
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  }
  async function imports(names) {
    const source = names.map((name, i) => `import * as m${i} from ${JSON.stringify("./" + name)}; export {m${i}};`).join("\n");
    const entry = new vm.SourceTextModule(source, { identifier: path.join(ROOT, "in-memory-test.js"), context });
    await entry.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
    await entry.evaluate();
    return names.map((_, i) => entry.namespace["m" + i]);
  }
  function clickSummary(action) {
    for (const listener of listeners.get("click") || []) listener({ target: { closest: selector => selector === "[data-summary-action]" ? { dataset: { summaryAction: action } } : null } });
  }
  return { host, window, context, element, editors, session, events, created, revoked, imports, clickSummary };
}

if (!vm.SourceTextModule) {
  test("browser regressions in isolated VM modules", () => {
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  test("browser host aliases logs and fetches previews same-origin with header auth only", async () => {
    const h = harness(); const requests = []; const blob = { image: "synthetic" };
    h.session.set("qqfriend-admin-token", "synthetic-admin-token");
    h.window.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => "{}", blob: async () => blob }; };
    vm.runInContext(fs.readFileSync(path.join(ROOT, "host-client.js"), "utf8"), h.context);
    await h.window.QQFriendHost.call("refreshLogs");
    assert.equal(requests[0].url, "/admin/logs?tail=120");
    assert.equal(await h.window.QQFriendHost.call("getStickerPreview", { id: "a&b", version: 4 }), blob);
    assert.equal(requests[1].url, "/admin/stickers/image?id=a%26b&v=4");
    assert.equal(requests[1].options.headers["X-QQFriend-Admin-Token"], "synthetic-admin-token");
    assert.doesNotMatch(requests[1].url, /token|127\.0\.0\.1|http:/);
    h.window.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' });
    await assert.rejects(h.window.QQFriendHost.call("getStickerPreview", { id: "a" }), error => error.status === 403);
  });

  test("refreshLogs UI action sends the supported getLogs host contract", async () => {
    const h = harness(); const calls = [];
    h.host.call = async action => { calls.push(action); return { current: { lines: ["synthetic log"] } }; };
    const [actions] = await h.imports(["ui/actions.js"]);
    await actions.runAction("refreshLogs", null, { silent: true });
    assert.deepEqual(calls, ["getLogs"]);
    assert.equal(h.element("logsOutput").textContent, "synthetic log");
  });

  test("preview request deadline covers the body and respects disposal aborts", async () => {
    for (const trigger of ["deadline", "dispose"]) {
      const h = harness(); let deadline; let cleared = false;
      h.window.AbortController = globalThis.AbortController;
      h.window.setTimeout = callback => { deadline = callback; return 1; };
      h.window.clearTimeout = () => { cleared = true; };
      h.window.fetch = async (_url, options) => ({ ok: true, status: 200, blob: () => new Promise((_resolve, reject) => {
        assert.equal(options.redirect, "error");
        options.signal.addEventListener("abort", () => reject(new Error("aborted body")));
      }) });
      vm.runInContext(fs.readFileSync(path.join(ROOT, "host-client.js"), "utf8"), h.context);
      const controller = new globalThis.AbortController();
      const pending = h.window.QQFriendHost.call("getStickerPreview", { id: "test", signal: controller.signal });
      await flush(); assert.equal(cleared, false);
      if (trigger === "deadline") deadline(); else controller.abort();
      await assert.rejects(pending, error => error.transportFailure === true);
      assert.equal(cleared, true);
    }
  });

  test("a late denied preview cannot erase a newly supplied admin token", async () => {
    const h = harness(); let finish;
    h.session.set("qqfriend-admin-token", "old-test-token");
    h.window.fetch = () => new Promise(resolve => { finish = resolve; });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "host-client.js"), "utf8"), h.context);
    const pending = h.window.QQFriendHost.call("getStickerPreview", { id: "test" });
    h.session.set("qqfriend-admin-token", "new-test-token");
    finish({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' });
    await assert.rejects(pending);
    assert.equal(h.session.get("qqfriend-admin-token"), "new-test-token");
  });

  for (const changed of ["selection", "dirty"]) test("meme research preserves edits after " + changed + " changes", async () => {
    const h = harness(); let finish;
    const id = "00000000-0000-0000-0000-000000000001";
    h.host.call = async action => action === "startTask" ? { jobId: id } : new Promise(resolve => { finish = resolve; });
    const [actions, memes] = await h.imports(["ui/actions.js", "pages/memes.js"]);
    memes.fillMemeForm({ name: "A", meaning: "saved-A" });
    const pending = actions.runAction("researchMemeWeb", null, { silent: true }); await flush();
    if (changed === "selection") memes.fillMemeForm({ name: "B", meaning: "saved-B" });
    h.element("memeMeaning").value = "my-unsaved-edit"; memes.updateMemeDirty();
    finish({ task: { id, phase: "done", resultAvailable: true, result: { ok: true, query: "A", entry: { name: "A", meaning: "late-result" } } } });
    await pending;
    assert.equal(h.element("memeMeaning").value, "my-unsaved-edit");
    assert.equal(memes.memeFormPayload().entry.originalName, changed === "selection" ? "B" : "A");
    assert.match(h.element("memeStatus").textContent, /未覆盖/);
    assert.deepEqual(JSON.parse(h.session.get("qqfriend-pending-tasks-v1")), [id]);
  });

  test("unchanged meme editor still receives successful research", async () => {
    const h = harness();
    h.host.call = async action => action === "startTask" ? { jobId: "00000000-0000-0000-0000-000000000001" }
      : { task: { phase: "done", resultAvailable: true, result: { ok: true, query: "A", entry: { name: "A", meaning: "verified" } } } };
    const [actions, memes] = await h.imports(["ui/actions.js", "pages/memes.js"]);
    memes.fillMemeForm({ name: "A", meaning: "before" });
    await actions.runAction("researchMemeWeb", null, { silent: true });
    assert.equal(h.element("memeMeaning").value, "verified");
  });

  test("resumed meme research protects selection changes while refreshing its result", async () => {
    const h = harness(); let finish;
    h.host.call = () => new Promise(resolve => { finish = resolve; });
    const [feedback, memes] = await h.imports(["ui/background-feedback.js", "pages/memes.js"]);
    feedback.installTaskFeedback();
    memes.fillMemeForm({ name: "A", meaning: "saved-A" });
    const task = { id: "00000000-0000-0000-0000-000000000003", module: "memes", action: "research-web", phase: "running" };
    const notify = (type, value) => h.window.dispatchEvent({ type: "qqfriend:task", detail: { type, task: value } });
    notify("started", task);
    notify("complete", { ...task, phase: "done", resultAvailable: true, result: { ok: true, query: "A", entry: { name: "A", meaning: "late" } } });
    memes.fillMemeForm({ name: "B", meaning: "saved-B" });
    finish({ entries: [{ name: "A" }, { name: "B" }] }); await flush();
    assert.equal(h.element("memeName").value, "B"); assert.equal(h.element("memeMeaning").value, "saved-B");
    assert.match(h.element("memeStatus").textContent, /未覆盖/);
  });

  test("daily dirty refresh retains the editing head used for conflict checks", async () => {
    const h = harness(); const calls = [];
    const first = { id: "R1", summary: "first", createdAt: 1, evidence: [], document: null };
    let revisions = [first];
    h.host.call = async (action, payload) => {
      if (action === "summaryAction") { calls.push(payload); throw new Error("conflict"); }
      return { groupId: "synthetic-group", dateText: "2026-09-16", groups: ["synthetic-group"], revisions, jobs: [], delivery: { status: "not_sent" } };
    };
    await h.imports(["summaries.js"]);
    h.clickSummary("refresh"); await flush();
    h.element("summaryBody").value = "my-edit"; h.element("summaryBody").listeners.input();
    revisions = [first, { ...first, id: "R2", summary: "another-admin-edit" }];
    h.clickSummary("refresh"); await flush();
    assert.equal(h.element("summaryBody").value, "my-edit");
    h.clickSummary("save"); await flush();
    assert.equal(calls[0].revisionId, "R1");
    assert.equal(calls[0].expectedRevisionId, "R1");
    assert.equal(h.element("summaryBody").value, "my-edit");
  });

  test("task reads retry boundedly and recover without submitting new work", async () => {
    const h = harness(); const [tasks] = await h.imports(["ui/tasks.js"]);
    const pauses = []; let reads = 0;
    const done = await tasks.waitForTask(async () => {
      if (++reads < 3) throw Object.assign(new Error("temporary"), { transportFailure: true });
      return { phase: "done" };
    }, { sleep: async ms => pauses.push(ms) });
    assert.equal(done.phase, "done"); assert.equal(reads, 3); assert.deepEqual(pauses, [1000, 2000]);
  });

  test("daily background completion preserves dirty text and its original conflict baseline", async () => {
    const h = harness(); const saves = [];
    const first = { id: "R1", summary: "first", createdAt: 1, evidence: [], document: null };
    const base = { groupId: "synthetic-group", dateText: "2026-09-16", groups: ["synthetic-group"], revisions: [first], jobs: [], delivery: { status: "not_sent" } };
    h.host.call = async () => base;
    await h.imports(["summaries.js"]); h.clickSummary("refresh"); await flush();
    h.element("summaryBody").value = "my-dirty-text"; h.element("summaryBody").listeners.input();
    let reads = 0;
    h.host.call = async (action, payload) => {
      if (action === "summaryAction") { saves.push(payload); throw new Error("conflict"); }
      const done = ++reads > 1;
      return { ...base, revisions: done ? [first, { ...first, id: "R2", summary: "new" }] : [first], jobs: [{ id: "job", phase: done ? "done" : "running", revisionId: done ? "R2" : "" }] };
    };
    h.clickSummary("refresh"); await flush();
    assert.equal(h.element("summaryBody").value, "my-dirty-text");
    h.clickSummary("save"); await flush();
    assert.equal(saves[0].expectedRevisionId, "R1");
    assert.equal(saves[0].revisionId, "R1");
  });

  test("daily polling failure keeps the existing job and manual refresh resumes it", async () => {
    const h = harness(); let starts = 0; let reads = 0; let recovered = false;
    const base = { groupId: "synthetic-group", dateText: "2026-09-16", groups: ["synthetic-group"], revisions: [], jobs: [], delivery: { status: "not_sent" } };
    h.host.call = async action => {
      if (action === "summaryAction") { starts++; return { jobId: "job" }; }
      reads++;
      if (!starts) return base;
      if (!recovered) throw Object.assign(new Error("network"), { transportFailure: true });
      return { ...base, jobs: [{ id: "job", phase: "done" }] };
    };
    await h.imports(["summaries.js"]); h.clickSummary("refresh"); await flush();
    h.clickSummary("generate"); await flush();
    assert.equal(starts, 1); assert.equal(reads, 5);
    assert.match(h.element("summaryProgress").textContent, /尚未确认/);
    assert.equal(h.element('[data-summary-action="generate"]').disabled, true);
    recovered = true; h.clickSummary("refresh"); await flush();
    assert.equal(starts, 1);
    assert.equal(h.element('[data-summary-action="generate"]').disabled, false);
  });

  test("an explicit terminal failure is not confused with a transport uncertainty", async () => {
    const h = harness();
    h.host.call = async action => action === "startTask" ? { jobId: "00000000-0000-0000-0000-000000000004" }
      : { task: { phase: "failed", error: "explicit business failure" } };
    const [tasks] = await h.imports(["ui/tasks.js"]);
    await assert.rejects(tasks.callManagedAction("manageStickers", { action: "sync" }), error => {
      assert.equal(error.taskStateUnknown, undefined);
      return error.message === "explicit business failure";
    });
  });

  test("exhausted polling retains task ID and reports unknown, not business failure", async () => {
    const h = harness(); let starts = 0; let reads = 0;
    const id = "00000000-0000-0000-0000-000000000002";
    h.host.call = async action => {
      if (action === "startTask") { starts++; return { jobId: id }; }
      reads++; throw Object.assign(new Error("network"), { transportFailure: true });
    };
    const [actions, tasks] = await h.imports(["ui/actions.js", "ui/tasks.js"]);
    await actions.runAction("syncStickers");
    assert.equal(starts, 1); assert.equal(reads, 4);
    assert.deepEqual(JSON.parse(h.session.get("qqfriend-pending-tasks-v1")), [id]);
    assert.match(h.element("activityTitle").textContent, /尚未确认/);
    assert.doesNotMatch(h.element("activityDetail").textContent, /没有完成这次操作/);
    h.host.call = async (_action, payload) => payload?.id ? { task: { id, phase: "done" } } : { tasks: [{ id, module: "stickers", action: "sync", phase: "done" }] };
    await tasks.resumeManagedTasks(); await flush();
    assert.deepEqual(JSON.parse(h.session.get("qqfriend-pending-tasks-v1")), []);
    assert.ok(h.events.some(event => event.detail.type === "complete"));
    assert.equal(starts, 1);
  });

  test("preview fetches are bounded and revoked; late responses cannot revive disposed images", async () => {
    const h = harness(); const finish = []; const signals = [];
    h.window.AbortController = globalThis.AbortController;
    h.host.call = async (action, payload) => { assert.equal(action, "getStickerPreview"); assert.ok(payload.id); signals.push(payload.signal); return new Promise(resolve => finish.push(resolve)); };
    const [stickers] = await h.imports(["pages/stickers.js"]);
    assert.equal(stickers.stickerPreviewUrl({ id: "x" }), "/admin/stickers/image?id=x&v=0");
    const images = Array.from({ length: 7 }, (_, i) => Object.assign(node(), { dataset: { previewId: "id-" + i, previewVersion: "0" }, nextElementSibling: node() }));
    const root = { querySelectorAll: () => images };
    stickers.bindStickerImageFallbacks(root);
    assert.equal(finish.length, 4);
    finish[0]({ image: true }); await flush();
    assert.equal(finish.length, 5); assert.equal(images[0].src, "blob:synthetic-0");
    stickers.disposeStickerPreviews();
    assert.deepEqual(h.revoked, ["blob:synthetic-0"]);
    assert.ok(signals.every(signal => signal.aborted));
    finish.slice(1).forEach(resolve => resolve({ image: true })); await flush();
    assert.equal(h.created.length, 1); assert.equal(finish.length, 5);
  });

  test("config uses saved values, excludes environment-owned fields and displays pending restart", async () => {
    const h = harness();
    const editor = node(); const input = node(); const add = node(); const chips = node();
    editor.dataset.listEditorFor = "cfgGroupWhitelist";
    editor.querySelector = selector => selector === ".list-editor-chips" ? chips : input;
    editor.querySelectorAll = () => [input, add]; h.editors.push(editor);
    const [config] = await h.imports(["pages/configuration.js"]);
    config.renderConfigEditor({ editable: { botNames: ["saved-name"], groupWhitelist: ["123456"] }, effective: { botNames: ["old-name"] }, pendingRestart: true, files: { groupWhitelist: { writable: false, envName: "QQBOT_GROUPS" } } });
    assert.equal(h.element("cfgBotNames").value, "saved-name");
    assert.equal(input.disabled, true); assert.equal(add.disabled, true);
    assert.equal(config.configPayload().editable.groupWhitelist, undefined);
    assert.equal(config.configPayload().editable.botNames[0], "saved-name");
    assert.match(h.element("configDirtyState").textContent, /待重启/);
    assert.match(h.element("configStatus").textContent, /当前运行配置不同/);
    input.value = "999999"; config.commitListEditor(editor);
    assert.equal(h.element("cfgGroupWhitelist").value, "123456");
  });
}
