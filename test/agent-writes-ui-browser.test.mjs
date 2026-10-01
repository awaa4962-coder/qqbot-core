import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL, URL } from "node:url";
import { installMockConsole, UI_ORIGIN, UI_WIDTHS } from "./p5-ui-fixtures.mjs";

const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE;
const optional = { skip: !modulePath, timeout: 45000 };
const allowPending = process.env.QQFRIEND_AGENT_WRITES_PENDING === "1";
const AT = Date.parse("2026-10-01T00:00:00Z");
const PRIVATE = "A3_PRIVATE_BODY_SENTINEL";
const USER = "918273645001";
const GROUP = "918273645002";
const HASH = "A3_PRIVATE_INTERNAL_HASH";
const PANEL = "#agentWritesPanel";
const REFRESH = PANEL + ' [data-action="refreshAgentWrites"]';
const CONFIG_IDS = ["cfgAgentWriteGroups", "cfgAgentReminderGroups"];
const CONFIRMATION_PHASES = ["pending", "executing", "applied", "not_applied", "unknown", "revoked", "expired", "invalidated"];
const REMINDER_PHASES = ["armed", "sending", "sent", "failed", "cancelled", "partial", "interrupted", "unknown", "expired"];
const ACTIONS = ["set_name", "set_style", "memory_create", "memory_update", "memory_remove", "create", "cancel"];
const ROWS = CONFIRMATION_PHASES.length + REMINDER_PHASES.length;
const ref = (kind, index) => (kind === "cf" ? "cf_" + "a".repeat(30) : "rem_" + "b".repeat(30)) + index.toString(16).padStart(2, "0");
let browser, output;

function snapshot() {
  return { status: "ready", enabled: false,
    confirmations: { status: "ready", items: CONFIRMATION_PHASES.map((phase, index) => ({
      ref: ref("cf", index), action: ACTIONS[index % ACTIONS.length], phase, createdAt: AT, expiresAt: AT + 300000,
    })) },
    reminders: { status: "ready", items: REMINDER_PHASES.map((phase, index) => ({
      ref: ref("rem", index), phase, createdAt: AT, dueAt: AT + 3600000,
    })) } };
}

test.before(async () => {
  if (!modulePath) return;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  browser = await chromium.launch({ headless: true, channel: process.env.QQFRIEND_BROWSER_CHANNEL || "msedge" });
  output = process.env.QQFRIEND_UI_QA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-agent-writes-ui-"));
  await fs.mkdir(output, { recursive: true });
});
test.after(async () => { await browser?.close(); });

async function capture(page, name) {
  await page.evaluate(async () => {
    globalThis.window.scrollTo(0, 0);
    await new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true, animations: "disabled" });
}

async function setup(t, width, suffix = "metadata") {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 900 },
    locale: "zh-CN", timezoneId: "America/New_York", reducedMotion: "reduce", serviceWorkers: "block" });
  t.after(async () => { await context.close(); });
  const page = await context.newPage();
  const mock = await installMockConsole(page);
  const state = { snapshot: snapshot(), status: 200 };
  const calls = []; const violations = []; const nonReads = [];
  mock.data.capabilities.agentWrites = state.snapshot;
  page.on("request", request => {
    if (request.method() !== "GET") nonReads.push({ method: request.method(), url: request.url() });
  });
  // Override only the new read endpoint. Mutating methods have no successful mock response.
  await page.route("**/admin/agent-actions*", async route => {
    const request = route.request(); const url = new URL(request.url());
    const call = { method: request.method(), path: url.pathname, query: url.search };
    calls.push(call);
    if (url.origin !== UI_ORIGIN || call.method !== "GET" || call.path !== "/admin/agent-actions" || call.query !== "") {
      violations.push(call); await route.abort("blockedbyclient"); return;
    }
    const response = { status: state.status, snapshot: globalThis.structuredClone(state.snapshot) };
    if (state.gate) await state.gate;
    await route.fulfill({ status: response.status, json: response.status === 200 ? response.snapshot : { error: PRIVATE } });
  });
  const clean = () => {
    assert.deepEqual(mock.errors, [], "browser errors");
    assert.deepEqual(mock.unexpected, [], "nonfixture or unknown requests");
    assert.deepEqual(mock.dialogs, [], "readonly inspection must not prompt for confirmation");
    assert.deepEqual(violations, [], "agent-actions permits only its exact GET endpoint");
    assert.deepEqual(nonReads, [], "no POST or other mutating requests anywhere in this inspection");
  };
  t.after(() => { mock.dispose(); clean(); });
  await mock.open();
  await page.locator('.view-tab[data-view="capabilities"]').click();
  await page.waitForFunction(() => globalThis.document.getElementById("capabilityNotice")?.dataset.state === "ready");
  const missing = [];
  for (const id of ["agentWritesPanel", ...CONFIG_IDS]) if (await page.locator("#" + id).count() !== 1) missing.push(id);
  if (missing.length) {
    await capture(page, `agent-writes-pending-${suffix}-${width}`);
    clean();
    const reason = "parent integration pending: missing " + missing.join(", ");
    if (allowPending) { t.skip(reason); return undefined; }
    assert.fail(reason + "; QQFRIEND_AGENT_WRITES_PENDING=1 permits a diagnostic pending run only");
  }
  assert.equal(await page.locator(REFRESH).count(), 1, "parent must mount the readonly renderer");
  if (await page.locator(PANEL + " tbody tr").count() !== ROWS) {
    await page.locator(REFRESH).click();
  }
  await page.waitForFunction(count => globalThis.document.querySelectorAll("#agentWritesPanel tbody tr").length === count, ROWS);
  const setSnapshot = value => { state.snapshot = value; mock.data.capabilities.agentWrites = value; };
  const hold = () => {
    let release; state.gate = new Promise(resolve => { release = resolve; });
    return () => { state.gate = undefined; release(); };
  };
  return { page, mock, calls, state, clean, setSnapshot, hold };
}

async function refresh(h) {
  const before = h.calls.length;
  const response = h.page.waitForResponse(value => {
    const url = new URL(value.url());
    return url.origin === UI_ORIGIN && url.pathname === "/admin/agent-actions" && value.request().method() === "GET";
  });
  await h.page.locator(REFRESH).click();
  await response;
  assert.equal(h.calls.length, before + 1, "one manual refresh makes exactly one metadata GET");
}

async function assertReadonly(page) {
  const panel = page.locator(PANEL);
  const commands = await panel.locator("button").evaluateAll(buttons => buttons.map(button => ({
    action: button.dataset.action, type: button.type, label: button.getAttribute("aria-label"), title: button.title,
  })));
  assert.deepEqual(commands, [{ action: "refreshAgentWrites", type: "button", label: "刷新状态", title: "刷新状态" }]);
  assert.equal(await panel.locator("input,textarea,select,a,form,pre,img,script,[contenteditable=true],[role=button]").count(), 0);
  assert.equal(await panel.locator('[data-action*="confirm" i],[data-action*="execute" i],[data-action*="revoke" i],[data-action*="cancel" i]').count(), 0);
  const html = await panel.evaluate(element => element.outerHTML);
  assert.doesNotMatch(html, /A3_PRIVATE_BODY_SENTINEL|918273645001|918273645002|A3_PRIVATE_INTERNAL_HASH/);
  assert.doesNotMatch(html, /1000000001|1000000002|2000000001|synthetic-message|memory-v1/);
  assert.doesNotMatch(html, /\b(?:parameters|params|userId|groupId|internalhash|bindingHash|operationHash|preview|reasoning_content)\b/);
  assert.doesNotMatch(await page.locator("body").innerText(), /A3_PRIVATE_BODY_SENTINEL|918273645001|918273645002|A3_PRIVATE_INTERNAL_HASH/);
}

async function assertLayout(page) {
  const problems = await page.evaluate(() => {
    const issues = []; const viewport = globalThis.window.innerWidth;
    if (globalThis.document.documentElement.scrollWidth > viewport + 1) issues.push("page-overflow");
    const panel = globalThis.document.getElementById("agentWritesPanel");
    for (const node of panel.querySelectorAll("table,th,td,button,h3,h4")) {
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.left < -1 || box.right > viewport + 1) issues.push("outside-" + node.tagName);
      if (node.scrollWidth > node.clientWidth + 1) issues.push("text-overflow-" + node.tagName);
    }
    for (const node of panel.querySelectorAll("td")) {
      if (globalThis.window.getComputedStyle(node).overflowWrap !== "anywhere") issues.push("cell-not-wrapping");
    }
    const title = panel.querySelector("h3").getBoundingClientRect();
    const refresh = panel.querySelector("button").getBoundingClientRect();
    if (title.right > refresh.left && title.bottom > refresh.top && refresh.bottom > title.top) issues.push("heading-overlap");
    const region = panel.querySelector(".agent-writes");
    const style = globalThis.window.getComputedStyle(region);
    if (style.boxShadow !== "none" || style.borderRadius !== "0px") issues.push("framed-panel");
    for (const node of panel.querySelectorAll("h3,h4")) {
      if (parseFloat(globalThis.window.getComputedStyle(node).fontSize) > 16) issues.push("oversized-heading");
    }
    return issues;
  });
  assert.deepEqual(problems, []);
}

for (const width of UI_WIDTHS) test(`agent writes full page is metadata-only with wrapping and old-backend locks at ${width}px`, optional, async t => {
  const h = await setup(t, width); if (!h) return;
  const panel = h.page.locator(PANEL);
  assert.equal(await panel.locator("tbody tr").count(), ROWS);
  const text = await panel.textContent();
  for (const label of ["未开放", "修改称呼", "修改风格", "新增记忆", "修改记忆", "删除记忆", "创建提醒", "取消提醒",
    "待本人确认", "执行中", "已应用", "未应用", "结果未知", "已撤销", "已过期", "已失效", "待发送", "发送中", "已发送", "失败", "已取消", "部分完成", "已中断"])
    assert.ok(text.includes(label), "missing fixed metadata label: " + label);
  assert.match(text, /北京时间/); assert.match(text, /2026-10-01 08:00:00/);
  assert.match(text, /2026-10-01 08:05:00/); assert.match(text, /2026-10-01 09:00:00/);
  for (const item of [...snapshot().confirmations.items, ...snapshot().reminders.items]) assert.ok(text.includes(item.ref));
  await assertReadonly(h.page); await assertLayout(h.page);

  const changed = snapshot(); changed.confirmations.items[0].phase = "unknown"; h.setSnapshot(changed);
  await refresh(h);
  await h.page.waitForFunction(ref => [...globalThis.document.querySelectorAll("#agentWritesPanel tbody tr")]
    .some(row => row.textContent.includes(ref) && row.textContent.includes("结果未知")), ref("cf", 0));
  await assertReadonly(h.page); await assertLayout(h.page);
  await capture(h.page, `agent-writes-metadata-${width}`);

  await h.page.locator('.view-tab[data-view="configuration"]').click();
  await h.page.waitForFunction(() => globalThis.document.getElementById("configStatus")?.dataset.state === "ready");
  for (const id of CONFIG_IDS) {
    assert.equal(await h.page.locator("#" + id).isDisabled(), true, "missing backend field must lock its source: " + id);
    const editor = h.page.locator(`[data-list-editor-for="${id}"]`);
    assert.equal(await editor.count(), 1);
    assert.equal(await editor.locator('input:not([type="hidden"])').isDisabled(), true);
    assert.ok(await editor.locator("button").count() >= 1);
    for (const button of await editor.locator("button").all()) assert.equal(await button.isDisabled(), true);
  }
  await capture(h.page, `agent-writes-old-backend-config-${width}`);
  h.clean();
});

test("agent writes unavailable refresh clears stale rows without a fabricated empty or success state", optional, async t => {
  const h = await setup(t, 390, "unavailable"); if (!h) return;
  const value = snapshot(); value.status = "unavailable"; h.setSnapshot(value);
  await refresh(h);
  await h.page.waitForFunction(() => globalThis.document.querySelectorAll("#agentWritesPanel tbody tr").length === 0);
  const text = await h.page.locator(PANEL).textContent();
  assert.match(text, /无法读取|未知/); assert.doesNotMatch(text, /已应用|已发送|未列出|成功/);
  assert.doesNotMatch(text, /cf_[a-f0-9]{32}|rem_[a-f0-9]{32}/);
  await assertReadonly(h.page); await capture(h.page, "agent-writes-unavailable-390"); h.clean();
});

test("agent writes rejects malformed metadata without exposing attached private bodies IDs hashes or errors", optional, async t => {
  const h = await setup(t, 390, "malformed"); if (!h) return;
  const value = snapshot(); value.reminders.items = [];
  value.confirmations.items = [{ ...value.confirmations.items[0], phase: "constructor",
    parameters: { body: PRIVATE }, body: PRIVATE, preview: PRIVATE, userId: USER, groupId: GROUP, internalhash: HASH, error: PRIVATE }];
  h.setSnapshot(value); await refresh(h);
  await h.page.waitForFunction(() => globalThis.document.querySelectorAll("#agentWritesPanel tbody tr").length === 0);
  const text = await h.page.locator(PANEL).textContent();
  assert.match(text, /未知/); assert.doesNotMatch(text, /已应用|已发送|成功|constructor/);
  await assertReadonly(h.page); await capture(h.page, "agent-writes-malformed-390"); h.clean();
});

test("agent writes old-backend GET 404 invalidates cached metadata without exposing its raw error", optional, async t => {
  const h = await setup(t, 390, "missing-endpoint"); if (!h) return;
  h.state.status = 404; await refresh(h);
  await h.page.waitForFunction(() => globalThis.document.querySelectorAll("#agentWritesPanel tbody tr").length === 0);
  const text = await h.page.locator(PANEL).textContent();
  assert.match(text, /无法读取|未知/); assert.doesNotMatch(text, /已应用|已发送|成功|未列出/);
  await assertReadonly(h.page); await capture(h.page, "agent-writes-missing-endpoint-390"); h.clean();
});

test("agent writes pending feedback and fixed-size refresh remain pending until the actual GET completes", optional, async t => {
  const h = await setup(t, 320, "pending-read"); if (!h) return;
  const release = h.hold(); const before = h.calls.length;
  try {
    const requested = h.page.waitForRequest(request => new URL(request.url()).pathname === "/admin/agent-actions");
    const completed = h.page.waitForResponse(response => new URL(response.url()).pathname === "/admin/agent-actions");
    await h.page.locator(REFRESH).click(); await requested;
    await h.page.waitForFunction(() => globalThis.document.getElementById("agentWriteActionStatus")?.dataset.state === "loading");
    assert.equal(h.calls.length, before + 1); assert.equal(await h.page.locator(REFRESH).isDisabled(), true);
    assert.match(await h.page.locator("#agentWriteActionStatus").textContent(), /正在读取.*尚未确认/);
    assert.equal(await h.page.locator(REFRESH).textContent(), "\u21bb");
    await assertReadonly(h.page); await assertLayout(h.page); await capture(h.page, "agent-writes-pending-read-320");
    release(); await completed;
    await h.page.waitForFunction(() => globalThis.document.getElementById("agentWriteActionStatus")?.dataset.state === "ready");
    assert.equal(await h.page.locator(REFRESH).isDisabled(), false); assert.equal(h.calls.length, before + 1);
    h.clean();
  } finally { release(); }
});

test("capabilities read failure invalidates agent writes and prevents an older held GET from restoring records", optional, async t => {
  const h = await setup(t, 390, "capability-failure"); if (!h) return;
  const release = h.hold();
  try {
    const requested = h.page.waitForRequest(request => new URL(request.url()).pathname === "/admin/agent-actions");
    const completed = h.page.waitForResponse(response => new URL(response.url()).pathname === "/admin/agent-actions");
    await h.page.locator(REFRESH).click(); await requested;
    h.mock.setFault("GET", "/admin/capabilities", { status: 503, body: { error: PRIVATE } });
    await h.page.locator('[data-action="refreshCapabilities"]').click();
    await h.page.waitForFunction(() => globalThis.document.getElementById("capabilityNotice")?.dataset.state === "error");
    assert.equal(await h.page.locator(PANEL + " code").count(), 0);
    release(); await completed;
    await h.page.waitForFunction(() => globalThis.document.getElementById("agentWritesPanel")?.getAttribute("aria-busy") === "false");
    assert.equal(await h.page.locator(PANEL + " code").count(), 0);
    assert.match(await h.page.locator("#agentWriteActionStatus").textContent(), /未确认.*清除/);
    await assertReadonly(h.page); await capture(h.page, "agent-writes-capabilities-failure-390"); h.clean();
  } finally { release(); }
});

for (const status of [401, 403]) test(`agent writes GET ${status} clears metadata without raw errors prompts or retry`, optional, async t => {
  const h = await setup(t, 390, "authorization-" + status); if (!h) return;
  h.state.status = status; await refresh(h);
  await h.page.waitForFunction(() => globalThis.document.getElementById("agentWriteActionStatus")?.dataset.state === "error");
  assert.equal(await h.page.locator(PANEL + " code").count(), 0);
  assert.match(await h.page.locator("#agentWriteActionStatus").textContent(), /无权读取.*清除/);
  await assertReadonly(h.page); await capture(h.page, `agent-writes-authorization-${status}-390`); h.clean();
});

test("supported backend enables the two mapped group editors without posting a configuration write", optional, async t => {
  const h = await setup(t, 390, "supported-config"); if (!h) return;
  for (const key of ["agentWriteGroupWhitelist", "agentReminderGroupWhitelist"]) {
    h.mock.data.config.editable[key] = [275101];
    h.mock.data.config.files[key] = { status: "editable", writable: true };
  }
  await h.page.locator('.view-tab[data-view="configuration"]').click();
  await h.page.locator('[data-view-panel="configuration"] .section-head [data-action="refreshConfig"]').click();
  await h.page.waitForFunction(ids => ids.every(id => globalThis.document.getElementById(id)?.value === "275101"), CONFIG_IDS);
  for (const id of CONFIG_IDS) {
    assert.equal(await h.page.locator("#" + id).inputValue(), "275101");
    assert.equal(await h.page.locator("#" + id).isDisabled(), false);
    assert.equal(await h.page.locator(`[data-list-editor-for="${id}"] input:not([type="hidden"])`).isDisabled(), false);
  }
  await capture(h.page, "agent-writes-supported-config-390"); h.clean();
});
