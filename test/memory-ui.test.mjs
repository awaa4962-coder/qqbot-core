import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { initializeMemory } from "../launcher/QQFriendLauncher/Web/memory.js";

const webRoot = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const item = (id = "one", overrides = {}) => ({ id, title: "Test title", text: "Test memory", kind: "user_statement",
  source: { kind: "user_command", messageId: "message-1", at: 1700000000000 }, revision: 1,
  createdAt: 1700000000000, updatedAt: 1700000000000, expiresAt: 1700086400000, state: "active", ...overrides });
const snapshot = (overrides = {}) => ({ ok: true, groupId: "101", userId: "202", revision: "snapshot-1", items: [item()],
  preferences: { displayName: "Test name", styleText: "Short replies" }, inferences: [],
  limits: { maxItems: 32, maxTextChars: 300, maxTitleChars: 32, ttlDays: 90 }, legacyInferenceIgnored: true, ...overrides });

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName; this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
    this.dataset = {}; this.attributes = {}; this.disabled = false; this.hidden = false;
  }
  set innerHTML(_value) { throw new Error("Memory records must never use innerHTML"); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type, event = {}) {
    const e = { preventDefault() { this.prevented = true; }, ...event };
    for (const callback of this.listeners[type] || []) await callback(e);
    return e;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]); }
  focus() { this.focused = true; }
}

function setup(reply = () => snapshot()) {
  const ids = ["Panel", "Scope", "Group", "User", "GroupField", "Load", "Refresh", "New", "Title", "Text", "Ttl", "RecordType", "Status", "EventAt", "EventAtField", "Transition", "Save", "Delete",
    "List", "Dirty", "Chars", "Notice", "Source", "EditorTitle", "Target", "Count", "DisplayName", "StyleText", "Inferences", "Legacy", "Query", "Editor"];
  const nodes = new Map(ids.map(id => ["memory" + id, new Element()]));
  const $ = id => { assert.ok(nodes.has("memory" + id), id); return nodes.get("memory" + id); };
  $("Scope").value = "group"; $("Ttl").value = "30";
  const calls = []; const confirmations = []; const answers = [];
  const win = new Element();
  win.confirm = question => { confirmations.push(question); return answers.shift() ?? true; };
  const host = { call: async (action, payload) => { calls.push({ action, payload }); return reply(action, payload); } };
  const controller = initializeMemory(host, { document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) }, window: win });
  return { $, calls, confirmations, answers, win, controller,
    setReply(fn) { reply = fn; },
    async load(groupId = "101", userId = "202") {
      $("Scope").value = groupId === "private" ? "private" : "group";
      $("Group").value = groupId === "private" ? "" : groupId; $("User").value = userId;
      await $("Query").fire("submit");
    },
    async edit(text = "Operator correction") { $("Text").value = text; await $("Text").fire("input"); },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function allText(node) { return [node.textContent, ...node.children.map(allText)].join(" "); }

test("memory starts without fetching; both identifiers required, including private QQ", async () => {
  const f = setup();
  assert.equal(f.calls.length, 0); assert.equal(f.$("Save").disabled, true);
  await f.load("", "202"); await f.load("101", ""); await f.load("private", ""); await f.load("101&x=1", "202");
  assert.equal(f.calls.length, 0);
  f.setReply(() => snapshot({ groupId: "private" }));
  await f.load("private");
  assert.deepEqual(f.calls, [{ action: "getMemory", payload: { groupId: "private", userId: "202" } }]);
  assert.equal(f.$("GroupField").hidden, true);
});

test("memory renders source, expired state and read-only preferences as text, never HTML", async () => {
  const xss = '<img src=x onerror="window.injected=true">';
  const f = setup(() => snapshot({ items: [item("one", { title: xss, text: xss, state: "expired", source: { kind: "operator", messageId: xss, at: 1 } })],
    preferences: { displayName: xss, styleText: xss }, inferences: [{ label: xss, sourceCount: 2, latestAt: 1 }] }));
  await f.load();
  assert.equal(f.$("Text").value, xss); assert.equal(f.$("DisplayName").textContent, xss);
  assert.match(allText(f.$("Source")), /管理员操作/); assert.match(allText(f.$("Source")), /已过期/);
  assert.ok(allText(f.$("List")).includes(xss)); assert.ok(allText(f.$("Inferences")).includes(xss));
  assert.match(f.$("Legacy").textContent, /忽略/);
  assert.equal(f.$("Save").disabled, true); assert.equal(f.$("Delete").disabled, false);
});

test("create and update use distinct actions and snapshot tokens, never spoof user provenance", async () => {
  const f = setup(); await f.load(); await f.edit();
  f.setReply((_action, payload) => snapshot({ revision: "snapshot-2", items: [item("one", { text: payload.text, kind: "operator_note" })] }));
  await f.$("Editor").fire("submit");
  assert.deepEqual(f.calls[1], { action: "saveMemory", payload: { action: "update", groupId: "101", userId: "202", id: "one", revision: "snapshot-1", title: "Test title", text: "Operator correction", ttlDays: 30, recordType: "unclassified", status: "recorded", eventAt: null } });
  assert.match(f.confirmations[0], /不代表用户自述/); assert.equal(f.$("Dirty").textContent, "");
  await f.$("New").fire("click"); assert.equal(f.$("Title").value, ""); assert.equal(f.$("Delete").disabled, true);
  f.$("Title").value = "New title";
  await f.edit("New note");
  f.setReply((_action, payload) => snapshot({ revision: "snapshot-3", items: [item(), item("two", { text: payload.text, kind: "operator_note" })] }));
  await f.$("Editor").fire("submit");
  assert.equal(f.calls[2].payload.action, "create"); assert.equal(f.calls[2].payload.revision, "snapshot-2");
  assert.equal("id" in f.calls[2].payload, false); assert.equal("kind" in f.calls[2].payload, false); assert.equal("source" in f.calls[2].payload, false);
  assert.equal(f.$("Text").value, "New note"); assert.equal(f.$("Save").textContent, "保存修改");
});

test("save/delete cancellation and deletion confirmation preserve scope and latest snapshot", async () => {
  const f = setup(); await f.load(); await f.edit();
  f.answers.push(false, false);
  await f.$("Editor").fire("submit"); await f.$("Delete").fire("click"); assert.equal(f.calls.length, 1);
  f.setReply(() => snapshot({ revision: "after-delete", items: [] }));
  await f.$("Delete").fire("click");
  assert.deepEqual(f.calls[1].payload, { action: "remove", groupId: "101", userId: "202", revision: "snapshot-1", id: "one" });
  assert.match(f.confirmations.at(-1), /不可撤销.*未保存/);
  assert.equal(f.$("Text").value, ""); assert.match(allText(f.$("List")), /暂无/); assert.equal(f.$("Save").disabled, true);
});

test("dirty guards cover selection, new, query refresh, navigation and beforeunload", async () => {
  const f = setup(() => snapshot({ items: [item(), item("two")] })); await f.load(); await f.edit();
  const unload = await f.win.fire("beforeunload"); assert.equal(unload.prevented, true);
  f.answers.push(false, false, false, false);
  await f.$("List").children[1].fire("click"); await f.$("New").fire("click"); await f.$("Refresh").fire("click");
  assert.equal(f.controller.canLeave(), false); assert.equal(f.calls.length, 1); assert.equal(f.$("Text").value, "Operator correction");
  assert.equal(f.controller.canLeave(), true); assert.equal(f.$("Text").value, "Test memory");
  assert.equal((await f.win.fire("beforeunload")).prevented, undefined);
});

test("out-of-order reads, edited query fields and navigation invalidate late responses", async () => {
  const old = deferred(), fresh = deferred();
  const f = setup(() => old.promise);
  const first = f.load(); assert.equal(f.$("Panel").attributes["aria-busy"], "true");
  f.setReply(() => fresh.promise); const second = f.load("101", "303");
  fresh.resolve(snapshot({ userId: "303", items: [item("two", { text: "Current user" })] })); await second;
  old.resolve(snapshot()); await first; assert.equal(f.$("Text").value, "Current user");
  const changed = deferred(); f.setReply(() => changed.promise); const third = f.$("Refresh").fire("click");
  f.$("User").value = "404"; await f.$("User").fire("input"); changed.resolve(snapshot({ userId: "303" })); await third;
  assert.equal(f.$("Text").value, "Current user"); assert.equal(f.$("New").disabled, true);
  const leaving = deferred(); f.setReply(() => leaving.promise); const fourth = f.load();
  assert.equal(f.controller.canLeave(), true); leaving.resolve(snapshot()); await fourth;
  assert.equal(f.$("Text").value, "Current user"); assert.match(f.$("Notice").textContent, /取消/);
});

test("409 keeps the draft but disables stale writes until an explicit confirmed refresh", async () => {
  const f = setup(); await f.load(); await f.edit();
  f.setReply(() => { throw Object.assign(new Error("conflict"), { status: 409 }); });
  await f.$("Editor").fire("submit");
  assert.match(f.$("Notice").textContent, /草稿已保留/); assert.equal(f.$("Text").value, "Operator correction");
  assert.equal(f.$("Save").disabled, true); assert.equal(f.$("Delete").disabled, true);
  await f.$("Editor").fire("submit"); assert.equal(f.calls.length, 2);
  f.answers.push(false); await f.$("Refresh").fire("click"); assert.equal(f.calls.length, 2);
  f.setReply(() => snapshot({ revision: "fresh", items: [item("one", { text: "Other editor" })] }));
  await f.$("Refresh").fire("click"); assert.equal(f.$("Text").value, "Other editor");
  assert.equal(f.$("Delete").disabled, false);
});

test("400 allows correction; 503 and unknown write outcomes require refresh without automatic retries", async () => {
  for (const error of [Object.assign(new Error("invalid input"), { status: 400 }), Object.assign(new Error("unavailable"), { status: 503 }), Object.assign(new Error("offline"), { transportFailure: true })]) {
    const f = setup(); await f.load(); await f.edit(); f.setReply(() => { throw error; });
    await f.$("Editor").fire("submit");
    assert.equal(f.calls.length, 2); assert.equal(f.$("Text").value, "Operator correction");
    assert.equal(f.$("Save").disabled, error.status !== 400); assert.equal(f.$("Notice").dataset.error, "true");
  }
});

test("failed/mismatched refresh keeps old draft and disables writes, successful retry recovers", async () => {
  const f = setup(); await f.load(); await f.edit();
  f.setReply(() => snapshot({ userId: "999" })); await f.$("Refresh").fire("click");
  assert.equal(f.$("Text").value, "Operator correction"); assert.equal(f.$("Save").disabled, true);
  assert.match(f.$("Notice").textContent, /不符/);
  f.setReply(() => { throw Object.assign(new Error("service unavailable"), { status: 503 }); });
  await f.$("Refresh").fire("click"); assert.match(f.$("Notice").textContent, /service unavailable/);
  f.setReply(() => snapshot()); await f.$("Refresh").fire("click"); assert.equal(f.$("Delete").disabled, false);
});

test("limits enforce nonempty text, title/text bounds, integer TTL 1..90 and capacity", async () => {
  const f = setup(); await f.load();
  for (const [title, text, ttl] of [["", "", "30"], ["x".repeat(33), "x", "30"], ["", "x".repeat(301), "30"], ["", "x", "0"], ["", "x", "91"], ["", "x", "1.5"]]) {
    f.$("Title").value = title; f.$("Text").value = text; f.$("Ttl").value = ttl;
    await f.$("Editor").fire("submit");
  }
  assert.equal(f.calls.length, 1);
  const full = setup(() => snapshot({ items: Array.from({ length: 32 }, (_, i) => item(String(i))) })); await full.load();
  assert.equal(full.$("New").disabled, true); await full.$("New").fire("click"); assert.equal(full.$("EditorTitle").textContent, "编辑记录");
  for (const ttl of [1, 90]) {
    const boundary = setup(); await boundary.load(); await boundary.edit(); boundary.$("Ttl").value = String(ttl);
    await boundary.$("Editor").fire("submit"); assert.equal(boundary.calls[1].payload.ttlDays, ttl);
  }
});

test("mutation loading blocks duplicate submission, queries, navigation and tab close", async () => {
  const f = setup(); await f.load(); await f.edit(); const pending = deferred(); f.setReply(() => pending.promise);
  const write = f.$("Editor").fire("submit");
  assert.equal(f.$("Panel").attributes["aria-busy"], "true"); assert.equal(f.$("User").disabled, true);
  assert.equal(f.controller.canLeave(), false); assert.equal((await f.win.fire("beforeunload")).prevented, true);
  await f.$("Editor").fire("submit"); await f.$("Query").fire("submit"); assert.equal(f.calls.length, 2);
  pending.resolve(snapshot({ revision: "saved" })); await write; assert.equal(f.$("Panel").attributes["aria-busy"], "false");
});

test("browser host maps get/saveMemory precisely and preserves safe JSON status errors", async () => {
  const calls = []; let status = 200;
  const win = { fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, text: async () => JSON.stringify(status === 200 ? snapshot() : { error: "Safe error" }) }; },
    sessionStorage: { getItem: () => "", removeItem() {} } };
  vm.runInNewContext(await fs.readFile(path.join(webRoot, "host-client.js"), "utf8"), { window: win });
  for (const payload of [{}, { groupId: "private" }, { userId: "202" }, { groupId: "101&all=1", userId: "202" }]) {
    await assert.rejects(win.QQFriendHost.call("getMemory", payload));
  }
  assert.equal(calls.length, 0);
  await win.QQFriendHost.call("getMemory", { groupId: "private", userId: "202", ignored: "anything" });
  assert.equal(calls[0].url, "/admin/memory?groupId=private&userId=202"); assert.equal(calls[0].options.method, "GET");
  const payload = { action: "create", groupId: "101", userId: "202", revision: "opaque-token", text: "Note", ttlDays: 30 };
  await win.QQFriendHost.call("saveMemory", payload);
  assert.equal(calls[1].url, "/admin/memory"); assert.equal(calls[1].options.method, "POST"); assert.deepEqual(JSON.parse(calls[1].options.body), payload);
  for (status of [400, 409, 503]) await assert.rejects(win.QQFriendHost.call("saveMemory", payload), error => error.status === status && error.message === "Safe error");
});

test("memory wiring is lazy, browser-only and explicitly allowlisted", async () => {
  const app = await fs.readFile(path.join(webRoot, "app.js"), "utf8");
  const html = await fs.readFile(path.join(webRoot, "index.html"), "utf8");
  assert.match(app, /import\("\.\/memory\.js"\)/); assert.match(app, /host\.mode === "browser".*memoryNav/);
  assert.match(app, /memoryController\.canLeave\(\)/);
  for (const id of ["memoryGroup", "memoryUser"]) assert.match(html, new RegExp(`id="${id}"[^>]*autocomplete="off"`));
  const { handleWebConsoleRequest } = await import("../bridge/web-console.mjs");
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await handleWebConsoleRequest({ method: "GET", socket: { remoteAddress: "127.0.0.1" } }, response, { enabled: true, pathname: "/console/memory.js" });
  assert.equal(response.status, 200); assert.match(response.headers["Content-Type"], /javascript/);
  assert.match(response.body.toString(), /initializeMemory/);
});

// Optional real-browser verification uses an existing local Playwright installation, never downloads dependencies.
test("memory browser interactions and 1440/390 layout (mocked HTTP only)", { skip: !process.env.QQFRIEND_PLAYWRIGHT_MODULE }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.QQFRIEND_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ channel: process.env.QQFRIEND_BROWSER_CHANNEL || "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; const memoryCalls = []; const assets = [];
  page.on("pageerror", error => errors.push(error.message));
  let data = snapshot({ items: [item("one", { title: '<img src=x onerror=alert(1)>', state: "expired" })] });
  let conflict = false;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/console/")) {
      const file = url.pathname.slice("/console/".length) || "index.html"; assets.push(file);
      assert.ok(!file.includes(".."));
      await route.fulfill({ body: await fs.readFile(path.join(webRoot, file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
    } else if (url.pathname === "/admin/memory") {
      const payload = route.request().postDataJSON(); memoryCalls.push({ method: route.request().method(), payload, query: url.search });
      if (conflict && payload) { await route.fulfill({ status: 409, json: { error: "Conflict" } }); return; }
      if (payload) data = snapshot({ revision: "next", items: payload.action === "remove" ? [] : [item("one", { ...payload, kind: "operator_note" })] });
      await route.fulfill({ json: data });
    } else if (url.pathname === "/admin/status") await route.fulfill({ json: { status: "ok", config: {}, process: {} } });
    else if (url.pathname === "/admin/tasks") await route.fulfill({ json: { tasks: [] } });
    else await route.fulfill({ json: {} });
  });
  await page.goto("http://memory.test/console/");
  assert.equal(assets.includes("memory.js"), false);
  await page.locator("#memoryNav").click(); await page.waitForFunction(() => globalThis.document.getElementById("memoryScope").disabled === false);
  assert.equal(memoryCalls.length, 0);
  await page.locator("#memoryGroup").fill("101"); await page.locator("#memoryUser").fill("202"); await page.locator("#memoryLoad").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryText").value === "Test memory");
  assert.equal(await page.locator("#memoryList img").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.window.injected), undefined);
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-memory-ui-"));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.screenshot({ path: path.join(output, `memory-${width}.png`), fullPage: true, animations: "disabled" });
    const overflow = await page.locator("#memoryPanel").evaluate(panel => [...panel.querySelectorAll("input,select,textarea,button,label,dl,dd")].filter(node => {
      if (!node.getClientRects().length) return false;
      const box = node.getBoundingClientRect(); return box.right > globalThis.window.innerWidth + 1 || box.left < 0 || box.width < 1;
    }).map(node => node.id || node.tagName));
    assert.deepEqual(overflow, [], `${width}px overflow`);
    assert.equal(await page.locator("#memoryPanel").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  }
  await page.locator("#memoryText").fill("Unsaved browser draft");
  page.once("dialog", dialog => dialog.dismiss()); await page.locator('.view-tab[data-view="logs"]').click();
  assert.equal(await page.locator('[data-view-panel="memory"]').isVisible(), true);
  conflict = true; page.once("dialog", dialog => dialog.accept()); await page.locator("#memorySave").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryNotice").textContent.includes("草稿已保留"));
  assert.equal(await page.locator("#memoryText").inputValue(), "Unsaved browser draft"); assert.equal(await page.locator("#memorySave").isDisabled(), true);
  conflict = false; page.once("dialog", dialog => dialog.accept()); await page.locator("#memoryRefresh").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryText").value === "Test memory");
  await page.locator("#memoryNew").click(); await page.locator("#memoryTitle").fill("Browser title"); await page.locator("#memoryText").fill("Browser created note");
  page.once("dialog", dialog => dialog.accept()); await page.locator("#memorySave").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryNotice").textContent === "已保存为管理员备注。");
  assert.equal(memoryCalls.at(-1).payload.action, "create");
  page.once("dialog", dialog => dialog.accept()); await page.locator("#memoryDelete").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryNotice").textContent === "记录已删除。");
  assert.match(await page.locator("#memoryList").textContent(), /暂无/);
  assert.deepEqual(errors, []);
  t.diagnostic(`Screenshots: ${output}`);
});
