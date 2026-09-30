import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { installMockConsole, UI_WIDTHS } from "./p5-ui-fixtures.mjs";

const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE;
const optional = { skip: !modulePath, timeout: 45000 };
let browser; let output;
test.before(async () => {
  if (!modulePath) return;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const channel = process.env.QQFRIEND_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  output = process.env.QQFRIEND_UI_QA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-p5-ui-"));
  await fs.mkdir(output, { recursive: true });
});
test.after(async () => { await browser?.close(); });

async function setup(t, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, colorScheme: "light", reducedMotion: "reduce", locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
  const page = await context.newPage(); const mock = await installMockConsole(page);
  t.after(async () => { mock.dispose(); await context.close(); });
  await mock.open();
  return { page, mock };
}
async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector: query, text: expected }) => globalThis.document.querySelector(query)?.textContent.includes(expected), { selector, text }, { timeout: 5000 });
}
async function view(page, name) { await page.locator(`.view-tab[data-view="${name}"]`).click(); }
async function screen(t, page, name) {
  const original = page.viewportSize();
  for (const width of name.startsWith("ready-") ? [original.width] : UI_WIDTHS) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await assertFits(page, width);
    const filename = name.startsWith("ready-") ? name : name.replace(/-\d+$/, "") + "-" + width;
    await page.screenshot({ path: path.join(output, `${filename}.png`), fullPage: true, animations: "disabled" });
    t.diagnostic(`Screenshot: ${path.join(output, filename + ".png")}`);
  }
  await page.setViewportSize(original);
}
async function assertFits(page, width) {
  const problems = await page.evaluate(() => {
    const doc = globalThis.document; const viewport = globalThis.window.innerWidth;
    const results = [];
    const controls = [];
    if (doc.documentElement.scrollWidth > viewport + 1) results.push("document-horizontal-overflow");
    for (const node of doc.querySelectorAll('.view.active input:not([type="hidden"]),.view.active select,.view.active textarea,.view.active button,.view.active label,.view.active [role="status"]')) {
      if (!node.getClientRects().length || node.closest(".trace-table-wrap,.api-usage-table-wrap")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewport + 1 || rect.width < 1) results.push(node.id || node.getAttribute("data-action") || node.tagName);
      const owner = node.closest(".surface,.memory-workspace")?.getBoundingClientRect();
      if (owner && (rect.left < owner.left - 1 || rect.right > owner.right + 1)) results.push("outside-panel:" + (node.id || node.textContent));
      if (node.tagName === "BUTTON" && node.scrollWidth > node.clientWidth + 1) results.push("button-text:" + (node.id || node.textContent));
      if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)) controls.push({ node, rect });
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]; const b = controls[j];
      if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
      if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 2 &&
          Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 2) results.push(`overlap:${a.node.id || a.node.tagName}/${b.node.id || b.node.tagName}`);
    }
    return results;
  });
  assert.deepEqual(problems, [], `${width}px active-view overflow`);
}
function assertClean(mock) { assert.deepEqual(mock.errors, [], "rendered JS errors"); assert.deepEqual(mock.unexpected, [], "all network traffic must remain mocked"); }

for (const width of UI_WIDTHS) {
  test(`P5 rendered ${width}px ready/empty full-console layout`, optional, async t => {
    const { page, mock } = await setup(t, width);
    for (const [name, selector, ready] of [
      ["capabilities", "#capabilityNotice", "已刷新"], ["configuration", "#configStatus", "已载入"],
      ["api-center", "#apiUsageNotice", "分组"], ["diagnostics", "#traceNotice", "当前显示"],
      ["summaries", "#summaryProgress", "已刷新"], ["logs", "#logsOutput", "synthetic"],
    ]) {
      await view(page, name); await waitText(page, selector, ready); await assertFits(page, width); await screen(t, page, `ready-${name}-${width}`);
    }
    await view(page, "memory");
    await page.locator("#memoryGroup").fill("2000000001"); await page.locator("#memoryUser").fill("1000000002"); await page.locator("#memoryLoad").click();
    await waitText(page, "#memoryNotice", "已刷新"); await assertFits(page, width); await screen(t, page, `ready-memory-${width}`);
    assert.equal(await page.locator('[data-api-task="group_chat"] [data-route-fallback]').inputValue(), "deepseek");
    assert.equal(await page.locator('[data-api-task="group_chat"] [data-route-fallback]').isDisabled(), true);
    assert.equal(mock.calls.some(call => call.method === "POST"), false, "layout QA is read-only even in the fixture");
    assertClean(mock);
  });
}

test("P5 rendered capabilities loading/denied/stale/empty/recovery", optional, async t => {
  const { page, mock } = await setup(t); const release = mock.hold("GET", "/admin/capabilities");
  await view(page, "capabilities"); await waitText(page, "#capabilityNotice", "正在读取");
  assert.equal(await page.locator("#capabilityPanel").getAttribute("aria-busy"), "true"); await screen(t, page, "capabilities-loading-390");
  release(); await waitText(page, "#capabilityNotice", "已刷新");
  mock.setFault("GET", "/admin/capabilities", { status: 503 }); await page.locator('[data-action="refreshCapabilities"]').click();
  await waitText(page, "#capabilityNotice", "上次快照"); assert.equal(await page.locator("#capabilityNotice").getAttribute("data-state"), "error");
  mock.setFault("GET", "/admin/capabilities", { status: 403 }); await page.locator('[data-action="refreshCapabilities"]').click();
  await waitText(page, "#capabilityNotice", "无权"); assert.equal(await page.locator("#capabilityList").textContent(), ""); await screen(t, page, "capabilities-denied-390");
  mock.setFault("GET", "/admin/capabilities", null); mock.data.capabilities = { categories: [], capabilities: [] };
  await page.locator('[data-action="refreshCapabilities"]').click(); await waitText(page, "#capabilityNotice", "暂无");
  assert.equal(await page.locator("#capabilityNotice").getAttribute("data-state"), "empty"); await assertFits(page, 390); assertClean(mock);
});

test("P5 rendered config cancellation/conflict/unknown/reload and partial snapshot", optional, async t => {
  const { page, mock } = await setup(t); await view(page, "configuration");
  const input = page.locator('[data-list-editor-for="cfgBotNames"] input'); await input.fill("合成新增名称"); await input.press("Enter");
  await waitText(page, "#configDirtyState", "未保存");
  mock.setConfirm(false); await page.locator('[data-action="saveConfig"]').click();
  assert.equal(mock.calls.some(call => call.method === "POST"), false); mock.setConfirm(true);
  mock.setFault("POST", "/admin/config", { status: 409 }); await page.locator('[data-action="saveConfig"]').click();
  await waitText(page, "#configStatus", "别处更新"); assert.match(await page.locator("#cfgBotNames").inputValue(), /合成新增/);
  assert.equal(await page.locator('[data-action="saveConfig"]').isDisabled(), true); await screen(t, page, "config-conflict-390");
  mock.setFault("POST", "/admin/config", null); await page.locator('[data-action="refreshConfig"]').first().click(); await waitText(page, "#configStatus", "已载入");
  await input.fill("合成网络草稿"); await input.press("Enter"); mock.setFault("POST", "/admin/config", { abort: true });
  await page.locator('[data-action="saveConfig"]').click(); await waitText(page, "#configStatus", "结果未确认");
  assert.equal(await page.locator('[data-action="saveConfig"]').isDisabled(), true); assert.match(await page.locator("#cfgBotNames").inputValue(), /网络草稿/);
  mock.setFault("POST", "/admin/config", null); await page.locator('[data-action="refreshConfig"]').first().click(); await waitText(page, "#configStatus", "已载入");
  mock.setFault("GET", "/admin/config", { status: 503 }); mock.setFault("GET", "/admin/logs", { status: 503 });
  await page.locator('.topbar [data-action="refresh"]').click(); await waitText(page, "#configStatus", "读取失败");
  assert.match(await page.locator("#lastUpdated").textContent(), /刚刚刷新/); assert.match(await page.locator("#logsOutput").textContent(), /读取失败/);
  assert.equal(await page.locator("#activityBar").evaluate(node => node.classList.contains("success")), false); assertClean(mock);
});

test("P5 rendered API failed connection/conflict/unknown/CAS recovery preserves independent drafts", optional, async t => {
  const { page, mock } = await setup(t); await view(page, "api-center"); await waitText(page, "#apiNotice", "已读取");
  mock.setFault("POST", "/admin/api-providers", { body: { ok: false, error: "synthetic connection failure" } });
  await page.locator('[data-action="testApiProvider"]').click(); await waitText(page, "#apiNotice", "失败");
  assert.match(await page.locator("#apiTestOutput").textContent(), /失败/);
  assert.equal(await page.locator("#apiNotice").getAttribute("data-state"), "error");
  assert.equal(await page.locator("#activityBar").evaluate(node => node.classList.contains("success")), false); await screen(t, page, "api-test-failed-390");
  await page.locator("#apiModel").fill("synthetic-draft-model"); await page.locator('[data-api-task="group_chat"] [data-route-reasoning]').selectOption("economy");
  mock.setFault("POST", "/admin/api-providers", { status: 409, body: { error: "synthetic version conflict" } });
  await page.locator('[data-action="saveApiRoutes"]').click(); await waitText(page, "#apiNotice", "未更新");
  assert.equal(await page.locator("#apiModel").inputValue(), "synthetic-draft-model"); assert.equal(await page.locator('[data-action="saveApiRoutes"]').isDisabled(), true);
  const post = mock.calls.filter(call => call.method === "POST" && call.path === "/admin/api-providers").at(-1);
  assert.equal(post.payload.configurationRevision, "a".repeat(64));
  mock.setFault("POST", "/admin/api-providers", null); mock.data.api.configurationRevision = "b".repeat(64);
  await page.locator('[data-action="refreshApiProviders"]').click(); await waitText(page, "#apiNotice", "已读取");
  await page.locator("#apiModel").fill("provider-draft-survives-route-save");
  await page.locator('[data-api-task="group_chat"] [data-route-reasoning]').selectOption("economy");
  await page.locator('[data-action="saveApiRoutes"]').click(); await waitText(page, "#apiNotice", "已保存");
  assert.equal(await page.locator("#apiModel").inputValue(), "provider-draft-survives-route-save");
  mock.setFault("POST", "/admin/api-providers", { abort: true }); await page.locator('[data-action="saveApiProvider"]').click();
  await waitText(page, "#apiNotice", "未更新"); assert.equal(await page.locator('[data-action="saveApiProvider"]').isDisabled(), true);
  assert.equal(await page.locator("#apiModel").inputValue(), "provider-draft-survives-route-save"); assertClean(mock);
});

test("P5 rendered memory no permission/empty/validation/conflict/unknown/cancelled read", optional, async t => {
  const { page, mock } = await setup(t); await view(page, "memory");
  await page.locator("#memoryGroup").fill("2000000001"); await page.locator("#memoryUser").fill("1000000002");
  mock.setFault("GET", "/admin/memory", { status: 403 }); await page.locator("#memoryLoad").click(); await waitText(page, "#memoryNotice", "重新查询");
  assert.equal(await page.locator("#memorySave").isDisabled(), true); mock.setFault("GET", "/admin/memory", null);
  const release = mock.hold("GET", "/admin/memory"); await page.locator("#memoryLoad").click(); await waitText(page, "#memoryNotice", "正在读取");
  await view(page, "logs"); release(); await view(page, "memory"); await waitText(page, "#memoryNotice", "读取已取消");
  assert.equal(await page.locator("#memoryText").inputValue(), "");
  await page.locator("#memoryLoad").click(); await waitText(page, "#memoryNotice", "已刷新");
  await page.locator("#memoryText").fill("synthetic memory draft"); mock.setConfirm(false); await page.locator("#memorySave").click();
  assert.equal(mock.calls.some(call => call.method === "POST" && call.path === "/admin/memory"), false); mock.setConfirm(true);
  mock.setFault("POST", "/admin/memory", { status: 409 }); await page.locator("#memorySave").click(); await waitText(page, "#memoryNotice", "草稿已保留");
  assert.equal(await page.locator("#memoryText").inputValue(), "synthetic memory draft"); assert.equal(await page.locator("#memorySave").isDisabled(), true);
  await screen(t, page, "memory-conflict-390"); mock.setFault("POST", "/admin/memory", null);
  await page.locator("#memoryRefresh").click(); await waitText(page, "#memoryNotice", "已刷新"); await page.locator("#memoryText").fill("synthetic unknown draft");
  mock.setFault("POST", "/admin/memory", { abort: true }); await page.locator("#memorySave").click(); await waitText(page, "#memoryNotice", "未能确认");
  assert.equal(await page.locator("#memoryText").inputValue(), "synthetic unknown draft"); mock.setFault("POST", "/admin/memory", null);
  mock.data.memory.items = []; await page.locator("#memoryRefresh").click(); await waitText(page, "#memoryNotice", "暂无记忆");
  assert.equal(await page.locator("#memoryText").inputValue(), ""); await assertFits(page, 390); assertClean(mock);
});

test("P5 rendered usage malformed/no permission/empty/partial recovery does not touch API drafts", optional, async t => {
  const { page, mock } = await setup(t); await view(page, "api-center"); await waitText(page, "#apiUsageNotice", "分组");
  await page.locator("#apiModel").fill("synthetic-api-draft");
  mock.setFault("GET", "/admin/api-usage", { status: 403 }); await page.locator("#apiUsageRefresh").click(); await waitText(page, "#apiUsageNotice", "读取失败");
  assert.equal(await page.locator("#apiUsageResults").isVisible(), false); assert.equal(await page.locator("#apiModel").inputValue(), "synthetic-api-draft");
  mock.setFault("GET", "/admin/api-usage", { raw: "<html>synthetic proxy</html>" }); await page.locator("#apiUsageRefresh").click(); await waitText(page, "#apiUsageNotice", "JSON");
  mock.setFault("GET", "/admin/api-usage", null); mock.data.usage.rows = []; await page.locator("#apiUsageRefresh").click(); await waitText(page, "#apiUsageNotice", "无记录");
  await screen(t, page, "usage-empty-390");
  mock.data.usage.coverage.complete = false; mock.data.usage.coverage.unreadableFiles = 1; await page.locator("#apiUsageRefresh").click(); await waitText(page, "#apiUsageNotice", "未完整读取");
  assert.match(await page.locator("#apiUsageCoverage").textContent(), /部分覆盖/); assert.equal(await page.locator("#apiModel").inputValue(), "synthetic-api-draft"); assertClean(mock);
  await screen(t, page, "usage-partial-390");
});

test("P5 rendered diagnostics failed/empty/recovery and delivery write failure never claim saved", optional, async t => {
  const { page, mock } = await setup(t); mock.setFault("GET", "/admin/diagnose/traces", { status: 403 });
  await view(page, "diagnostics"); await page.waitForFunction(() => globalThis.document.getElementById("traceNotice").dataset.error === "true");
  mock.setFault("GET", "/admin/diagnose/traces", null); await view(page, "logs"); await view(page, "diagnostics"); await waitText(page, "#traceNotice", "当前显示 1");
  assert.match(await page.locator("#traceDetail").textContent(), /发送结果未知/);
  mock.setFault("GET", "/admin/diagnose/traces", { raw: "<html>synthetic proxy</html>" }); await page.locator('[data-diagnostic-action="traces"]').click(); await waitText(page, "#traceRows", "记录未读取");
  mock.setFault("GET", "/admin/diagnose/traces", null); mock.data.traces.items = []; mock.data.traces.total = 0;
  await page.locator('[data-diagnostic-action="traces"]').click(); await waitText(page, "#traceRows", "暂无");
  mock.data.replay.cases = []; await page.locator('[data-diagnostic-action="replay"]').click(); await waitText(page, "#replayNotice", "暂无");
  assert.equal(await page.locator("#replayCandidate").textContent(), "尚未生成候选"); assert.equal(await page.locator('[data-diagnostic-action="generate"]').isDisabled(), true);
  mock.setFault("POST", "/admin/diagnose/deliveries", { status: 400 }); await page.locator("#deliveryRows button").first().click(); await waitText(page, "#deliveryNotice", "synthetic failure");
  assert.doesNotMatch(await page.locator("#deliveryNotice").textContent(), /已记录/);
  mock.setFault("POST", "/admin/diagnose/deliveries", null); await page.locator("#refreshDeliveries").click(); await waitText(page, "#deliveryNotice", "符合条件");
  await page.locator("#deliveryRows button").first().click(); await waitText(page, "#deliveryNotice", "已记录");
  await page.locator('[data-action="diagnose"]').click(); await waitText(page, "#diagnoseOutput", "不会触发回复");
  assert.equal(mock.calls.some(call => call.path.includes("send") || call.path.includes("onebot")), false); assertClean(mock);
});

test("P5 rendered long job survives reload; overdue/unknown/cancelled are never fake completion", optional, async t => {
  const { page, mock } = await setup(t); mock.setJobMode("overdue"); await view(page, "stickers");
  await page.locator('[data-action="analyzeStickers"]').click(); await waitText(page, "#stickerStatus", "尚未确认停止");
  const start = mock.calls.find(call => call.method === "POST" && call.path === "/admin/tasks"); assert.ok(start);
  await page.reload(); await waitText(page, "#stickerStatus", "尚未确认停止"); await view(page, "diagnostics"); await waitText(page, "#managedTaskRows", "尚未确认停止");
  await screen(t, page, "task-overdue-restored-390");
  const id = "00000000-0000-0000-0000-000000000001";
  mock.setJobPhase(id, "done", { resultAvailable: true, result: { ok: true, result: { cancelled: true } } });
  await waitText(page, "#stickerStatus", "取消"); assert.equal(await page.locator("#activityBar").evaluate(node => node.classList.contains("success")), false);
  assert.equal(mock.calls.filter(call => call.method === "POST" && call.path === "/admin/tasks").length, 1);
  mock.setJobMode("done"); await view(page, "stickers"); mock.setFault("GET", "/admin/tasks", { status: 403 });
  await page.locator('[data-action="analyzeStickers"]').click(); await waitText(page, "#stickerStatus", "尚未确认");
  await page.locator('[data-action="analyzeStickers"]').click(); assert.equal(mock.calls.filter(call => call.method === "POST" && call.path === "/admin/tasks").length, 2);
  mock.setFault("GET", "/admin/tasks", null); await view(page, "diagnostics"); await page.locator("#refreshManagedTasks").click();
  await waitText(page, "#stickerStatus", "确认完成"); assert.equal(mock.calls.filter(call => call.method === "POST" && call.path === "/admin/tasks").length, 2); assertClean(mock);
});

test("P5 rendered daily save conflict/unknown/empty and confirmed cancelled job", optional, async t => {
  const { page, mock } = await setup(t); await view(page, "summaries"); await waitText(page, "#summaryProgress", "已刷新");
  await page.locator("#summaryBody").fill("合成日报草稿"); mock.setFault("POST", "/admin/summaries", { status: 409 });
  await page.locator('[data-summary-action="save"]').click(); await waitText(page, "#summaryProgress", "草稿已保留");
  assert.equal(await page.locator("#summaryBody").inputValue(), "合成日报草稿"); assert.equal(await page.locator('[data-summary-action="save"]').isDisabled(), true);
  mock.setFault("POST", "/admin/summaries", null); await page.locator('[data-summary-action="refresh"]').click(); await waitText(page, "#summaryProgress", "已刷新");
  assert.equal(await page.locator("#summaryBody").inputValue(), "合成日报草稿", "dirty refresh retains original editing head");
  mock.setFault("POST", "/admin/summaries", { abort: true }); await page.locator('[data-summary-action="save"]').click(); await waitText(page, "#summaryProgress", "结果未确认");
  assert.equal(await page.locator("#summaryBody").inputValue(), "合成日报草稿"); mock.setFault("POST", "/admin/summaries", null);
  await page.locator('[data-summary-action="refresh"]').click(); await waitText(page, "#summaryProgress", "已刷新");
  mock.setJobMode("cancelled"); await page.locator('[data-summary-action="generate"]').click(); await waitText(page, "#summaryProgress", "取消");
  assert.equal(await page.locator("#summaryProgress").getAttribute("data-error"), "true");
  await screen(t, page, "summary-cancelled-390");
  mock.data.summaries = { groups: [], revisions: [], jobs: [], coverage: null }; await page.locator('[data-summary-action="refresh"]').click(); await waitText(page, "#summaryProgress", "尚未配置");
  assert.equal(await page.locator("#summaryBody").inputValue(), ""); assert.equal(await page.locator('[data-summary-action="send"]').isDisabled(), true); assertClean(mock);
});
