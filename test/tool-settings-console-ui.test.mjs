import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";
import { TOOL_LIMIT_PROFILES, resolveToolLimits } from "../bridge/chat-tools/limits.mjs";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const REVISION = "a".repeat(64), NEW_REVISION = "b".repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
function snapshot(settings = {}, revision = REVISION, extra = {}) {
  const value = { autonomyEnabled: true, profile: "standard", interjectionProfile: "light", overrides: {}, ...settings };
  return { revision, settings: value, source: "saved", effective: { chat: resolveToolLimits(value.profile, value.overrides),
    interjection: TOOL_LIMIT_PROFILES.light }, profiles: Object.entries(TOOL_LIMIT_PROFILES).map(([name, limits]) => ({ name, limits })), ...extra };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function domNode(document, tag = "div", id = "") {
  let text = ""; const classes = new Set();
  const node = { tagName: tag.toUpperCase(), ownerDocument: document, id, children: [], dataset: {}, attributes: {}, listeners: {},
    disabled: false, checked: false, value: "", className: "",
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("HTML parsing forbidden"); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { text = ""; this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
  };
  return node;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function environment(mode = "browser") {
  const nodes = new Map(), calls = [], confirmations = []; let document, confirm = false;
  const fail = () => assert.fail("real network, storage or timers forbidden");
  const fixed = id => { if (!nodes.has(id)) nodes.set(id, domNode(document, "div", id)); return nodes.get(id); };
  document = { createElement: tag => domNode(document, tag), getElementById: id => {
    for (const root of nodes.values()) { const found = descendants(root).find(node => node.id === id); if (found) return found; }
    return null;
  } };
  for (const id of ["toolSettingsPanel", "activityBar", "activityTitle", "activityDetail", "toast", "body"]) fixed(id);
  document.body = fixed("body");
  let reply = () => assert.fail("unexpected host call");
  const host = { mode, call: async (action, body) => { calls.push({ action, body: clone(body) }); return reply(action, body); } };
  const window = { QQFriendHost: host, setTimeout: () => 1, clearTimeout() {}, confirm: message => { confirmations.push(message); return confirm; } };
  const context = vm.createContext({ document, window, fetch: fail, XMLHttpRequest: fail, WebSocket: fail, setTimeout: fail, setInterval: fail });
  const modules = new Map();
  const load = file => {
    assert.ok(file.startsWith(ROOT));
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  };
  const module = load(path.join(ROOT, "ui/tool-settings-actions.js"));
  await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier))); await module.evaluate();
  const page = modules.get(path.join(ROOT, "pages/tool-settings.js")).namespace;
  const actions = module.namespace;
  const panel = () => fixed("toolSettingsPanel");
  const byId = id => document.getElementById(id);
  const edit = (id, value) => { const node = byId(id); if (typeof value === "boolean") node.checked = value; else node.value = String(value); node.listeners.input?.({ target: node }); };
  return { host, page, actions, calls, confirmations, panel, byId, edit, render: value => page.renderToolSettings(value),
    run: (action, options) => actions.runToolSettingsAction(action, null, options), setReply: value => { reply = value; },
    setConfirm: value => { confirm = value; }, reload: () => descendants(panel()).find(node => node.textContent === "重新载入配置").listeners.click(),
    save: () => descendants(panel()).find(node => node.dataset.action === "saveToolSettings"),
    refresh: () => descendants(panel()).find(node => node.dataset.action === "refreshToolSettings"),
    notice: () => byId("toolSettingsActionStatus").textContent,
    remount: () => nodes.set("toolSettingsPanel", domNode(document, "div", "toolSettingsPanel")) };
}
function acknowledged(settings) { return snapshot(clone(settings), NEW_REVISION, { status: "ok" }); }
function feedback(h, tone) {
  const title = h.byId("activityTitle").textContent;
  assert.equal(h.byId("activityDetail").textContent, title);
  assert.equal(h.byId("activityBar").classList.contains(tone), true); return title;
}

if (!vm.SourceTextModule) {
  test("tool settings console runs the real isolated VM cases", t => { t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 20, timeout: 45000 }))); });
} else {
  test("new modules are passive, expose required interfaces and reject unknown actions", async () => {
    const h = await environment(); assert.equal(h.calls.length, 0); assert.equal(h.panel().children.length, 0);
    for (const name of ["renderToolSettings", "invalidateToolSettingsView", "toolSettingsHasDrafts", "canDiscardToolSettingsDrafts"]) assert.equal(typeof h.page[name], "function");
    assert.equal(h.actions.isToolSettingsAction("saveToolSettings"), true); assert.equal(h.actions.isToolSettingsAction("refreshToolSettings"), true);
    assert.equal(await h.run("unknown"), false); assert.equal(h.calls.length, 0);
  });
  test("ready snapshot uses native controls and read-only fixed interjection light limits", async () => {
    const h = await environment(); assert.equal(h.render(snapshot()), true);
    assert.equal(h.byId("toolAutonomyEnabled").type, "checkbox"); assert.equal(h.byId("toolAutonomyEnabled").checked, true);
    assert.equal(h.byId("toolSettingsProfile").value, "standard");
    assert.deepEqual(h.byId("toolSettingsProfile").children.map(option => option.value), ["standard", "extended", "light"]);
    const readonly = descendants(h.panel()).find(node => node.tagName === "DL");
    assert.equal(readonly.children.filter(node => node.tagName === "DD").map(node => node.textContent).join(","), "3,2,30000");
    assert.equal(h.save().disabled, true); assert.equal(h.page.toolSettingsHasDrafts(), false);
  });
  for (const mode of ["windows", "native"]) test(mode + " is disabled and makes zero host calls", async () => {
    const h = await environment(mode); assert.equal(h.render(snapshot()), false);
    assert.equal(h.save().disabled, true); assert.equal(h.refresh().disabled, true);
    assert.equal(await h.run("refreshToolSettings"), false); assert.equal(await h.run("saveToolSettings"), false);
    assert.equal(h.calls.length, 0); assert.match(h.notice(), /Linux 浏览器/);
  });
  test("refresh uses getToolSettings only and activity feedback confirms a validated response", async () => {
    const h = await environment(); h.setReply(() => snapshot()); assert.equal(await h.run("refreshToolSettings"), true);
    assert.deepEqual(h.calls, [{ action: "getToolSettings", body: {} }]); assert.match(feedback(h, "success"), /已读取/);
  });
  test("save posts exact CAS body once and accepts only matching validated acknowledgement", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    h.setReply((_action, body) => acknowledged(body.settings)); assert.equal(await h.run("saveToolSettings"), true);
    assert.deepEqual(h.calls, [{ action: "saveToolSettings", body: { action: "save", expectedRevision: REVISION,
      settings: { autonomyEnabled: false, profile: "standard", interjectionProfile: "light", overrides: {} } } }]);
    assert.equal(h.page.toolSettingsHasDrafts(), false); assert.match(feedback(h, "success"), /已保存/);
    await h.run("saveToolSettings"); assert.equal(h.calls.length, 1);
  });
  for (const profile of ["standard", "extended", "light"]) test(profile + " preset uses its own numbers without forcing numeric overrides", async () => {
    const h = await environment(); h.render(snapshot({ profile: profile === "standard" ? "extended" : "standard" }));
    h.edit("toolSettingsProfile", profile);
    for (const key of ["modelRounds", "toolCalls", "durationMs"]) assert.equal(h.byId("toolSettingsLimit-" + key).value, String(TOOL_LIMIT_PROFILES[profile][key]));
    h.setReply((_action, body) => acknowledged(body.settings)); assert.equal(await h.run("saveToolSettings"), true);
    assert.equal(h.calls[0].body.settings.profile, profile); assert.deepEqual(h.calls[0].body.settings.overrides, {});
  });
  test("optional numeric overrides preserve hidden existing limits and are never coerced to unsafe numbers", async () => {
    const h = await environment(); h.render(snapshot({ profile: "extended", overrides: { requestChars: 32000 } }));
    for (const [key, value] of [["modelRounds", 6], ["toolCalls", 8], ["durationMs", 120000]]) {
      h.edit("toolSettingsOverride-" + key, true); h.edit("toolSettingsLimit-" + key, value);
    }
    h.setReply((_action, body) => acknowledged(body.settings)); assert.equal(await h.run("saveToolSettings"), true);
    assert.deepEqual(h.calls[0].body.settings.overrides, { requestChars: 32000, modelRounds: 6, toolCalls: 8, durationMs: 120000 });
  });
  test("unchecked numeric override is deleted without dropping unrelated settings", async () => {
    const h = await environment(); h.render(snapshot({ profile: "extended", overrides: { modelRounds: 6, requestChars: 32000 } }));
    h.edit("toolSettingsOverride-modelRounds", false); h.setReply((_action, body) => acknowledged(body.settings));
    assert.equal(await h.run("saveToolSettings"), true); assert.deepEqual(h.calls[0].body.settings.overrides, { requestChars: 32000 });
  });
  test("invalid ranges, non-integers and incompatible model/transport limits make no write", async () => {
    const h = await environment(); h.render(snapshot());
    for (const [key, values] of [["modelRounds", ["1", "17", "9"]], ["toolCalls", ["0", "25", "1.5"]],
      ["durationMs", ["4999", "180001", "Infinity", "NaN", "5e3", ""]]]) {
      h.edit("toolSettingsOverride-" + key, true);
      for (const value of values) { h.edit("toolSettingsLimit-" + key, value); assert.equal(await h.run("saveToolSettings"), false); }
      h.edit("toolSettingsOverride-" + key, false);
    }
    assert.equal(h.calls.length, 0); assert.match(feedback(h, "error"), /无效/);
  });
  test("draft discard requires explicit consent and ordinary refresh never erases unsaved edits", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    assert.equal(h.page.canDiscardToolSettingsDrafts(), false); h.setConfirm(true); assert.equal(h.page.canDiscardToolSettingsDrafts(), true);
    assert.equal(h.page.toolSettingsHasDrafts(), true); h.setReply(() => snapshot()); await h.run("refreshToolSettings");
    assert.equal(h.byId("toolAutonomyEnabled").checked, false); assert.equal(h.page.toolSettingsHasDrafts(), true);
  });
  test("409 preserves draft and old CAS revision, requires explicit reload, and never retries writes", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    h.setReply(() => { throw Object.assign(new Error("PRIVATE_SECRET"), { status: 409 }); });
    assert.equal(await h.run("saveToolSettings"), false); assert.match(feedback(h, "error"), /冲突/);
    await h.run("saveToolSettings"); assert.equal(h.calls.length, 1);
    h.setReply(() => snapshot({ profile: "extended" }, NEW_REVISION)); await h.run("refreshToolSettings");
    assert.equal(h.byId("toolSettingsProfile").value, "standard"); assert.equal(h.byId("toolAutonomyEnabled").checked, false);
    assert.equal(h.save().disabled, true); h.reload(); assert.equal(h.page.toolSettingsHasDrafts(), true);
    h.setConfirm(true); h.reload(); assert.equal(h.byId("toolSettingsProfile").value, "extended"); assert.equal(h.page.toolSettingsHasDrafts(), false);
    h.edit("toolAutonomyEnabled", false); assert.equal(h.page.toolSettingsPayload().expectedRevision, NEW_REVISION);
    assert.doesNotMatch(h.panel().textContent, /PRIVATE_SECRET/);
  });
  for (const status of [401, 403]) test(status + " rejects writes, keeps draft and permits no retry before a validated read", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    h.setReply(() => { throw Object.assign(new Error("Authorization: Bearer PRIVATE_SECRET"), { status }); });
    assert.equal(await h.run("saveToolSettings"), false); assert.equal(h.page.toolSettingsHasDrafts(), true);
    assert.match(feedback(h, "error"), /未获授权/); await h.run("saveToolSettings"); assert.equal(h.calls.length, 1);
    h.setReply(() => snapshot()); await h.run("refreshToolSettings"); assert.equal(h.save().disabled, false);
    assert.doesNotMatch(h.panel().textContent + feedback(h, "success"), /PRIVATE_SECRET|Bearer/);
  });
  test("cross-VM ordinary JSON object prototypes are accepted without null-prototype conversion", async () => {
    const h = await environment(), input = clone(snapshot());
    assert.equal(Object.getPrototypeOf(input), Object.prototype); assert.equal(Object.getPrototypeOf(input.settings), Object.prototype);
    assert.equal(Object.getPrototypeOf(input.settings.overrides), Object.prototype);
    assert.equal(h.render(input), true); assert.equal(h.byId("toolSettingsProfile").disabled, false);
  });
  test("401/403 clears effective cache and old reload/render cannot unlock or send a second save", async () => {
    for (const status of [401, 403]) {
      const h = await environment(), old = snapshot(); h.render(old); h.edit("toolAutonomyEnabled", false);
      h.setReply(() => { throw Object.assign(new Error("auth_expired"), { statusCode: status }); });
      assert.equal(await h.run("saveToolSettings"), false);
      const readonly = descendants(h.panel()).find(node => node.tagName === "DL");
      assert.equal(readonly.children.filter(node => node.tagName === "DD").map(node => node.textContent).join(","), "未确认,未确认,未确认");
      assert.equal(h.page.toolSettingsHasDrafts(), true); assert.equal(h.save().disabled, true);
      h.setConfirm(true); h.reload(); assert.equal(h.render(old), false);
      await h.run("saveToolSettings"); assert.equal(h.calls.length, 1); assert.equal(h.byId("toolAutonomyEnabled").checked, false);
      h.setReply(() => snapshot()); assert.equal(await h.run("refreshToolSettings"), true);
      assert.deepEqual(h.calls.map(call => call.action), ["saveToolSettings", "getToolSettings"]);
      assert.equal(h.page.toolSettingsHasDrafts(), true); assert.equal(h.save().disabled, false);
    }
  });
  test("POST auth DTOs cannot recover through reload, cached render, or a malformed fresh GET", async () => {
    for (const status of [401, 403]) for (const key of ["status", "statusCode"]) {
      const h = await environment(), old = clone(snapshot()); h.render(old); h.edit("toolAutonomyEnabled", false);
      h.setReply(() => ({ [key]: status, error: "unauthorized", detail: "PRIVATE_SECRET" }));
      assert.equal(await h.run("saveToolSettings"), false);
      const lightValues = () => descendants(h.panel()).find(node => node.tagName === "DL").children
        .filter(node => node.tagName === "DD").map(node => node.textContent);
      assert.deepEqual(lightValues(), ["未确认", "未确认", "未确认"]);
      h.setConfirm(true); h.reload(); assert.equal(h.render(old), false);
      assert.throws(() => h.page.toolSettingsPayload(), /tool_settings_view_locked/);
      h.setReply(() => ({ revision: REVISION, status: "ok" }));
      assert.equal(await h.run("refreshToolSettings"), false); h.reload();
      assert.equal(h.render(old), false); assert.equal(h.save().disabled, true);
      assert.deepEqual(lightValues(), ["未确认", "未确认", "未确认"]);
      assert.equal(h.page.toolSettingsHasDrafts(), true); assert.equal(h.byId("toolAutonomyEnabled").checked, false);
      assert.equal(await h.run("saveToolSettings"), false);
      assert.deepEqual(h.calls.map(call => call.action), ["saveToolSettings", "getToolSettings"]);
      h.setReply(() => clone(snapshot())); assert.equal(await h.run("refreshToolSettings"), true);
      assert.equal(h.save().disabled, false); assert.equal(h.page.toolSettingsHasDrafts(), true);
      assert.deepEqual(lightValues(), ["3", "2", "30000"]);
      assert.doesNotMatch(h.panel().textContent, /PRIVATE_SECRET/);
    }
  });
  test("ambiguous or lost save acknowledgement locks replay even after refresh and preserves draft", async () => {
    for (const reply of [() => ({}), () => ({ status: "success" }), () => { throw new Error("Bearer PRIVATE_SECRET"); },
      () => acknowledged({ autonomyEnabled: true, profile: "standard", interjectionProfile: "light", overrides: {} })]) {
      const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false); h.setReply(reply);
      assert.equal(await h.run("saveToolSettings"), false); assert.match(feedback(h, "error"), /未知/);
      await h.run("saveToolSettings"); assert.equal(h.calls.length, 1);
      h.setReply(() => snapshot({}, NEW_REVISION)); await h.run("refreshToolSettings"); await h.run("saveToolSettings");
      assert.equal(h.calls.length, 2); assert.equal(h.page.toolSettingsHasDrafts(), true); assert.equal(h.save().disabled, true);
      assert.doesNotMatch(h.panel().textContent, /PRIVATE_SECRET/);
    }
  });
  test("HTTP-style rejection DTOs get bounded feedback without echoing raw error fields", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    h.setReply(() => ({ error: "tool_settings_conflict", detail: "secret=PRIVATE_SECRET" }));
    assert.equal(await h.run("saveToolSettings"), false); assert.match(feedback(h, "error"), /冲突/);
    assert.doesNotMatch(h.panel().textContent, /PRIVATE_SECRET/);
  });
  test("failed read retains draft, disables saving, and never claims settings were refreshed", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    h.setReply(() => { throw Object.assign(new Error("PRIVATE_SECRET"), { status: 403 }); });
    assert.equal(await h.run("refreshToolSettings"), false); assert.match(feedback(h, "error"), /无权读取/);
    assert.equal(h.byId("toolAutonomyEnabled").checked, false); assert.equal(h.save().disabled, true);
  });
  test("malformed snapshots, inherited fields and accessors cannot revive writable state or invoke getters", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false); let reads = 0;
    const getter = snapshot(); Object.defineProperty(getter, "settings", { enumerable: true, get() { reads++; return snapshot().settings; } });
    const badEffective = clone(snapshot()); badEffective.effective.interjection.modelRounds = 4;
    const unknownLimit = clone(snapshot()); unknownLimit.settings.overrides.secret = "PRIVATE_SECRET";
    for (const value of [null, {}, Object.create(snapshot()), getter, snapshot({}, "Bearer PRIVATE_SECRET"),
      snapshot({}, REVISION, { status: "unknown" }), badEffective, unknownLimit]) {
      assert.equal(h.render(value), false); assert.equal(h.save().disabled, true); assert.equal(h.page.toolSettingsHasDrafts(), true);
    }
    assert.equal(reads, 0); assert.doesNotMatch(h.panel().textContent, /PRIVATE_SECRET/);
  });
  test("save and refresh share one busy lock, controls cannot be discarded during an in-flight write", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    const wait = deferred(); h.setReply(() => wait.promise); const write = h.run("saveToolSettings");
    assert.equal(h.save().disabled, true); assert.equal(h.refresh().disabled, true);
    assert.equal(h.page.canDiscardToolSettingsDrafts(), false); assert.equal(h.confirmations.length, 0);
    await h.run("saveToolSettings"); await h.run("refreshToolSettings"); assert.equal(h.calls.length, 1);
    wait.resolve(acknowledged(h.calls[0].body.settings)); assert.equal(await write, true);
  });
  test("edits after submission survive a matching acknowledgement and bind the next write to its new revision", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    const wait = deferred(); h.setReply(() => wait.promise); const write = h.run("saveToolSettings");
    h.byId("toolSettingsProfile").value = "extended";
    wait.resolve(acknowledged(h.calls[0].body.settings)); assert.equal(await write, true);
    assert.equal(h.byId("toolSettingsProfile").value, "extended"); assert.equal(h.page.toolSettingsHasDrafts(), true);
    assert.equal(h.page.toolSettingsPayload().expectedRevision, NEW_REVISION); assert.match(feedback(h, "success"), /仍有未保存/);
  });
  test("late reads cannot overwrite a newer rendered snapshot", async () => {
    const h = await environment(); h.render(snapshot()); const wait = deferred(); h.setReply(() => wait.promise);
    const read = h.run("refreshToolSettings"); h.render(snapshot({ profile: "extended" }, NEW_REVISION)); wait.resolve(snapshot());
    assert.equal(await read, false); assert.equal(h.byId("toolSettingsProfile").value, "extended");
    assert.equal(h.byId("body").attributes["aria-busy"], "false");
  });
  test("late save acknowledgement after invalidation cannot replace draft or unlock replay", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false);
    const wait = deferred(); h.setReply(() => wait.promise); const write = h.run("saveToolSettings");
    h.page.invalidateToolSettingsView(); h.render(snapshot({ profile: "extended" }, NEW_REVISION));
    wait.resolve(acknowledged(h.calls[0].body.settings)); assert.equal(await write, false);
    assert.equal(h.byId("toolAutonomyEnabled").checked, false); assert.equal(h.save().disabled, true); assert.match(feedback(h, "error"), /待核对/);
  });
  test("remount retains an unsaved editor rather than implicitly accepting a fresh baseline", async () => {
    const h = await environment(); h.render(snapshot()); h.edit("toolAutonomyEnabled", false); h.remount(); h.render(snapshot());
    assert.equal(h.byId("toolAutonomyEnabled").checked, false); assert.equal(h.page.toolSettingsHasDrafts(), true);
  });
}

const playwrightModule = process.env.QQFRIEND_PLAYWRIGHT_MODULE;
test("mocked browser desktop/mobile layout and native editing stay inside the independent panel", { skip: !playwrightModule, timeout: 45000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await chromium.launch({ headless: true, channel: "msedge" }); t.after(() => browser.close());
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tool-settings-ui-"));
  t.diagnostic("isolated screenshots: " + output);
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, "https://tool-settings.test"); assert.equal(route.request().method(), "GET");
      if (url.pathname === "/") {
        await route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/tool-settings.css"><main style="padding:16px;max-width:1000px;margin:auto"><div id="toolSettingsPanel"></div></main><div id="activityBar"><b id="activityTitle"></b><span id="activityDetail"></span></div><div id="toast"></div><script>window.QQFriendHost={mode:"browser",call(){throw new Error("host_io_forbidden")}}</script>' });
      } else {
        const filename = path.resolve(ROOT, "." + url.pathname); assert.ok(filename.startsWith(ROOT));
        assert.ok(/\.(?:js|css)$/.test(filename));
        await route.fulfill({ contentType: filename.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(filename, "utf8") });
      }
    });
    await page.goto("https://tool-settings.test/");
    await page.evaluate(async value => {
      const state = globalThis.window; state.mockToolSettings = JSON.parse(JSON.stringify(value)); state.mockCalls = [];
      state.QQFriendHost.call = async (action, body) => {
        state.mockCalls.push({ action, body });
        if (action === "getToolSettings") return JSON.parse(JSON.stringify(state.mockToolSettings));
        if (action !== "saveToolSettings") throw new Error("host_action_forbidden");
        const settings = JSON.parse(JSON.stringify(body.settings));
        const limits = state.mockToolSettings.profiles.find(row => row.name === settings.profile).limits;
        state.mockToolSettings = { ...state.mockToolSettings, status: "ok", revision: "b".repeat(64), settings,
          effective: { ...state.mockToolSettings.effective, chat: { ...limits, ...settings.overrides } } };
        return JSON.parse(JSON.stringify(state.mockToolSettings));
      };
      state.toolSettings = await import("/pages/tool-settings.js"); state.toolSettingsActions = await import("/ui/tool-settings-actions.js");
      await state.toolSettingsActions.runToolSettingsAction("refreshToolSettings");
    }, snapshot());
    await page.waitForFunction(() => globalThis.document.querySelector("#toolSettingsProfile").disabled === false, null, { timeout: 5000 });
    await page.locator("#toolAutonomyEnabled").uncheck();
    await page.locator("#toolSettingsProfile").selectOption("extended");
    await page.locator("#toolSettingsOverride-durationMs").check();
    await page.locator("#toolSettingsLimit-durationMs").fill("120000");
    const body = await page.evaluate(() => globalThis.window.toolSettings.toolSettingsPayload());
    assert.equal(body.expectedRevision, REVISION); assert.equal(body.settings.profile, "extended"); assert.equal(body.settings.overrides.durationMs, 120000);
    assert.equal(await page.evaluate(() => globalThis.window.toolSettingsActions.runToolSettingsAction("saveToolSettings")), true);
    await page.waitForFunction(() => /工具调度设置已保存/.test(globalThis.document.querySelector("#toolSettingsActionStatus").textContent), null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => globalThis.window.mockCalls.map(call => call.action)), ["getToolSettings", "saveToolSettings"]);
    const overflow = await page.evaluate(() => {
      const panel = globalThis.document.getElementById("toolSettingsPanel"), outer = panel.getBoundingClientRect();
      return { horizontal: globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth,
        controls: [...panel.querySelectorAll("input,select,button")].filter(node => {
          const box = node.getBoundingClientRect(); return box.left < outer.left - 1 || box.right > outer.right + 1 || box.width < 16;
        }).length };
    });
    assert.deepEqual(overflow, { horizontal: false, controls: 0 }); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, "tool-settings-" + width + ".png"), fullPage: true }); await page.close();
  }
});
