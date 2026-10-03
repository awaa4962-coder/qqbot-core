import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildAgentToolSnapshot } from "../bridge/chat-tools/registry.mjs";
import { installMockConsole, UI_WIDTHS } from "./p5-ui-fixtures.mjs";

const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE;
const optional = { skip: !modulePath, timeout: 45000 };
let browser;
test.before(async () => {
  if (!modulePath) return;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  browser = await chromium.launch({ headless: true, channel: process.env.QQFRIEND_BROWSER_CHANNEL || "msedge" });
});
test.after(async () => { await browser?.close(); });

for (const width of UI_WIDTHS) test(`personal tool permissions and group rows fit at ${width}px without granting actions`, optional, async t => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "zh-CN",
    reducedMotion: "reduce", serviceWorkers: "block" });
  t.after(async () => { await context.close(); });
  const page = await context.newPage(), mock = await installMockConsole(page);
  t.after(() => { mock.dispose(); });
  const groups = ["2000000001"];
  mock.data.capabilities.agentTools = {
    ...buildAgentToolSnapshot({ agentGroupWhitelist: groups, agentMaterialGroupWhitelist: groups,
      agentDraftGroupWhitelist: groups, agentWriteGroupWhitelist: groups, agentReminderGroupWhitelist: groups }),
    limits: { modelRounds: 4, toolCalls: 4, durationMs: 90000, transportAttempts: 8 },
  };
  const writes = [];
  page.on("request", request => { if (request.method() !== "GET") writes.push(request.method()); });
  await mock.open();
  await page.locator('.view-tab[data-view="capabilities"]').click();
  const panel = page.locator("#agentToolsPanel");
  await panel.getByText("本人设置工具群", { exact: true }).waitFor();
  await panel.getByText("提醒工具群", { exact: true }).waitFor();
  for (const label of ["准备自己的资料变更", "准备有限提醒", "查看自己的确认与提醒"]) {
    const term = panel.locator("dt").filter({ hasText: label });
    assert.equal(await term.count(), 1);
    const detail = await term.evaluate(element => element.nextElementSibling.textContent);
    assert.match(detail, /本人当前群/);
    assert.doesNotMatch(detail, /权限范围未知|模式未知/);
  }
  assert.deepEqual(await page.evaluate(() => {
    const viewport = globalThis.window.innerWidth, issues = [];
    if (globalThis.document.documentElement.scrollWidth > viewport + 1) issues.push("page-overflow");
    for (const element of globalThis.document.querySelectorAll("#agentToolsPanel dt, #agentToolsPanel dd")) {
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewport + 1 || element.scrollWidth > element.clientWidth + 1) issues.push("tool-overflow");
    }
    return issues;
  }), []);
  assert.deepEqual(writes, []);
  assert.deepEqual(mock.errors, []);
  assert.deepEqual(mock.unexpected, []);
  if (process.env.QQFRIEND_UI_QA_DIR) {
    await fs.mkdir(process.env.QQFRIEND_UI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.QQFRIEND_UI_QA_DIR, `agent-personal-tools-${width}.png`),
      fullPage: true, animations: "disabled" });
  }
});
