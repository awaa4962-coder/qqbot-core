import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { initializeMemory } from "../launcher/QQFriendLauncher/Web/memory.js";

const webRoot = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const semantics = { recordTypes: [
  { id: "unclassified", label: "未分类", statuses: [{ id: "recorded", label: "已记录" }] },
  { id: "fact", label: "事实", statuses: [{ id: "recorded", label: "已记录" }] },
  { id: "event", label: "事件", statuses: [{ id: "recorded", label: "已记录" }] },
  { id: "todo", label: "待办", statuses: [{ id: "pending", label: "待处理" }, { id: "in_progress", label: "进行中" }, { id: "done", label: "已完成" }, { id: "cancelled", label: "已取消" }] },
  { id: "current_state", label: "当前状态", statuses: [{ id: "current", label: "当前" }, { id: "ended", label: "已结束" }] },
] };
const item = (overrides = {}) => ({ id: "one", title: "Title", text: "Body", kind: "user_statement", recordType: "todo", status: "pending", eventAt: null,
  state: "active", source: { kind: "user_command", at: 1700000000000 }, revision: 1, expiresAt: 1900000000000, ...overrides });
const snapshot = (overrides = {}) => ({ ok: true, groupId: "101", userId: "202", revision: "rev-1", items: [item()],
  preferences: {}, inferences: [], semantics, ...overrides });

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName; this.value = ""; this.textContent = ""; this.children = []; this.listeners = {};
    this.dataset = {}; this.attributes = {}; this.disabled = false; this.hidden = false;
  }
  set innerHTML(_value) { throw new Error("Untrusted memory data must not become HTML"); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({ preventDefault() {} }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  focus() {}
}

function setup(first = snapshot()) {
  const ids = ["Panel", "Scope", "Group", "User", "GroupField", "Load", "Refresh", "New", "Title", "Text", "Ttl", "RecordType", "Status", "EventAt", "EventAtField", "Transition", "Save", "Delete",
    "List", "Dirty", "Chars", "Notice", "Source", "EditorTitle", "Target", "Count", "DisplayName", "StyleText", "Inferences", "Legacy", "Query", "Editor"];
  const nodes = new Map(ids.map(id => [`memory${id}`, new Element()]));
  const $ = id => nodes.get(`memory${id}`);
  $("Scope").value = "group"; $("Group").value = "101"; $("User").value = "202";
  const calls = []; const questions = []; let reply = () => first;
  const win = new Element(); win.confirm = question => { questions.push(question); return true; };
  const controller = initializeMemory({ call: async (method, payload) => { calls.push({ method, payload }); return reply(method, payload); } },
    { document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) }, window: win });
  return { $, calls, questions, controller, setReply(fn) { reply = fn; }, load: () => $("Query").fire("submit") };
}
const textOf = node => [node.textContent, ...node.children.map(textOf)].join(" ");

test("metadata drives type/status options and preserves existing type on full update", async () => {
  const f = setup(); await f.load();
  assert.deepEqual(f.$("RecordType").children.map(option => option.value), semantics.recordTypes.map(type => type.id));
  assert.equal(f.$("RecordType").value, "todo"); assert.equal(f.$("Status").value, "pending");
  assert.deepEqual(f.$("Status").children.map(option => option.value), ["pending", "in_progress", "done", "cancelled"]);
  assert.match(textOf(f.$("List")), /用户自述.*待办.*待处理.*有效/);
  assert.match(textOf(f.$("Source")), /来源类型.*内容类型.*内容状态.*记录有效性/);
  f.$("Text").value = "Corrected"; await f.$("Text").fire("input");
  assert.equal(f.$("Transition").disabled, true);
  f.setReply(() => snapshot({ revision: "rev-2", items: [item({ text: "Corrected", kind: "operator_note" })] }));
  await f.$("Editor").fire("submit");
  assert.deepEqual(f.calls[1].payload, { groupId: "101", userId: "202", action: "update", revision: "rev-1", id: "one",
    title: "Title", text: "Corrected", ttlDays: 30, recordType: "todo", status: "pending", eventAt: null });
  assert.match(f.questions[0], /有效期从保存时起/);
});

test("type changes reset dependent status; event time is optional and local datetime becomes epoch", async () => {
  const f = setup(snapshot({ items: [item({ recordType: "event", status: "recorded", eventAt: 1700000000000 })] }));
  await f.load();
  assert.equal(f.$("EventAtField").hidden, false);
  assert.equal(f.$("EventAt").value, new Date(1700000000000).toLocaleString("sv-SE").replace(" ", "T").slice(0, 16));
  f.$("EventAt").value = "2026-09-23T12:34"; await f.$("EventAt").fire("input");
  f.setReply(() => snapshot()); await f.$("Editor").fire("submit");
  assert.equal(f.calls[1].payload.eventAt, new Date("2026-09-23T12:34").getTime());
  f.$("RecordType").value = "current_state"; await f.$("RecordType").fire("change");
  assert.equal(f.$("Status").value, "current"); assert.equal(f.$("EventAt").value, ""); assert.equal(f.$("EventAtField").hidden, true);
  await f.$("Editor").fire("submit");
  assert.equal(f.calls[2].payload.eventAt, null);
  f.$("RecordType").value = "event"; await f.$("RecordType").fire("change");
  await f.$("Editor").fire("submit");
  assert.equal(f.calls[3].payload.eventAt, null);
});

test("editing other fields preserves an event timestamp more precise than datetime-local", async () => {
  const eventAt = 1700000000123;
  const f = setup(snapshot({ items: [item({ recordType: "event", status: "recorded", eventAt })] }));
  await f.load(); f.$("Text").value = "Corrected event"; await f.$("Text").fire("input");
  await f.$("Editor").fire("submit");
  assert.equal(f.calls[1].payload.eventAt, eventAt);
});

test("transition sends status alone, changes source attribution, and blocks dirty body or expired records", async () => {
  const f = setup(); await f.load();
  f.$("Status").value = "done"; await f.$("Status").fire("change");
  assert.equal(f.$("Transition").disabled, false);
  f.setReply(() => snapshot({ revision: "rev-2", items: [item({ status: "done", kind: "operator_note", source: { kind: "operator", at: 1700000000000 } })] }));
  await f.$("Transition").fire("click");
  assert.deepEqual(f.calls[1].payload, { groupId: "101", userId: "202", action: "transition", revision: "rev-1", id: "one", status: "done" });
  assert.match(f.questions[0], /管理员备注.*不代表用户亲口声明.*不修改正文或有效期/);
  assert.match(f.$("Notice").textContent, /管理员备注.*不代表用户亲口声明.*有效期未改变/);
  assert.match(textOf(f.$("Source")), /来源类型 管理员备注/);
  assert.equal(f.$("Transition").disabled, true);
  f.$("Status").value = "pending"; await f.$("Status").fire("change");
  f.$("Text").value = "Unsaved"; await f.$("Text").fire("input");
  assert.equal(f.$("Transition").disabled, true);
  await f.$("Transition").fire("click"); assert.equal(f.calls.length, 2);
  assert.match(f.$("Notice").textContent, /先保存或放弃/);
  const expired = setup(snapshot({ items: [item({ state: "expired" })] })); await expired.load();
  expired.$("Status").value = "done"; await expired.$("Status").fire("change");
  assert.equal(expired.$("Transition").disabled, true);
});

test("unknown type/status remain visible but cannot be saved until corrected; draft stays intact", async () => {
  for (const [recordType, status] of [["future_type", "future_status"], ["todo", "future_status"]]) {
    const f = setup(snapshot({ items: [item({ recordType, status })] }));
    await f.load(); assert.equal(f.$("RecordType").value, recordType); assert.equal(f.$("Status").value, status);
    assert.match(textOf(f.$("List")), /未知状态/);
    f.$("Text").value = "Unsaved edit"; await f.$("Text").fire("input");
    await f.$("Editor").fire("submit");
    assert.equal(f.calls.length, 1); assert.equal(f.questions.length, 0);
    assert.match(f.$("Notice").textContent, /请选择有效的内容类型、状态/);
    assert.equal(f.$("Text").value, "Unsaved edit"); assert.equal(f.$("RecordType").value, recordType);
    assert.equal(f.$("Status").value, status); assert.equal(f.$("Dirty").textContent, "未保存");
  }
});

test("missing semantics defaults to unclassified", async () => {
  const legacy = setup(snapshot({ semantics: undefined, items: [item({ recordType: undefined, status: undefined })] }));
  await legacy.load(); assert.equal(legacy.$("RecordType").value, "unclassified"); assert.equal(legacy.$("Status").value, "recorded");
});

test("transition conflict and permission loss retain draft and require refreshed snapshot", async () => {
  for (const status of [409, 403]) {
    const f = setup(); await f.load();
    f.$("Status").value = "done"; await f.$("Status").fire("change");
    f.setReply(() => { throw Object.assign(new Error("Denied"), { status }); });
    await f.$("Transition").fire("click");
    assert.equal(f.$("Status").value, "done"); assert.equal(f.$("Transition").disabled, true);
    assert.match(f.$("Notice").textContent, /草稿已保留/);
  }
});

test("memory type/status browser mock and 1440/390/320 layouts", { skip: !process.env.QQFRIEND_PLAYWRIGHT_MODULE }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.QQFRIEND_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ channel: process.env.QQFRIEND_BROWSER_CHANNEL || "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); const calls = []; const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let data = snapshot({ items: [item({ recordType: "event", status: "recorded", eventAt: 1700000000000 })] });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/console/")) {
      const file = url.pathname.slice(9) || "index.html";
      assert.ok(!file.includes(".."));
      await route.fulfill({ body: await fs.readFile(path.join(webRoot, file)), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
    } else if (url.pathname === "/admin/memory") {
      const payload = route.request().postDataJSON();
      if (payload) { calls.push(payload); data = snapshot({ revision: `rev-${calls.length + 1}`, items: [item({ ...payload, kind: "operator_note", state: "active" })] }); }
      await route.fulfill({ json: data });
    } else if (url.pathname === "/admin/status") await route.fulfill({ json: { status: "ok", config: {}, process: {} } });
    else if (url.pathname === "/admin/tasks") await route.fulfill({ json: { tasks: [] } });
    else await route.fulfill({ json: {} });
  });
  await page.goto("http://memory.test/console/"); await page.locator("#memoryNav").click();
  await page.locator("#memoryGroup").fill("101"); await page.locator("#memoryUser").fill("202"); await page.locator("#memoryLoad").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryRecordType").value === "event");
  assert.equal(await page.locator("#memoryEventAtField").isVisible(), true);
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-memory-state-ui-"));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.screenshot({ path: path.join(output, `memory-state-${width}.png`), fullPage: true, animations: "disabled" });
    const overflow = await page.locator("#memoryPanel").evaluate(panel => [...panel.querySelectorAll("input,select,textarea,button,label,dl,dd")].filter(node => {
      if (!node.getClientRects().length) return false;
      const box = node.getBoundingClientRect(); return box.right > globalThis.window.innerWidth + 1 || box.left < 0 || box.width < 1;
    }).map(node => node.id || node.tagName));
    assert.deepEqual(overflow, [], `${width}px overflow`);
    assert.equal(await page.locator("#memoryPanel").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  }
  await page.locator("#memoryRecordType").selectOption("todo");
  assert.equal(await page.locator("#memoryEventAtField").isVisible(), false);
  await page.locator("#memoryStatus").selectOption("done");
  assert.equal(await page.locator("#memoryTransition").isDisabled(), true);
  page.once("dialog", dialog => dialog.accept()); await page.locator("#memorySave").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryNotice").textContent === "已保存为管理员备注。");
  assert.equal(calls[0].recordType, "todo"); assert.equal(calls[0].status, "done"); assert.equal(calls[0].eventAt, null);
  await page.locator("#memoryStatus").selectOption("pending");
  assert.equal(await page.locator("#memoryTransition").isDisabled(), false);
  page.once("dialog", dialog => dialog.accept()); await page.locator("#memoryTransition").click();
  await page.waitForFunction(() => globalThis.document.getElementById("memoryNotice").textContent.includes("状态已由管理员更新"));
  assert.match(await page.locator("#memoryNotice").textContent(), /管理员备注.*不代表用户亲口声明/);
  assert.deepEqual(Object.keys(calls[1]).sort(), ["action", "groupId", "id", "revision", "status", "userId"]);
  assert.deepEqual(errors, []);
  t.diagnostic(`Screenshots: ${output}`);
});
