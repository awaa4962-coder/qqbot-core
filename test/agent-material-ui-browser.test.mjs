import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL, URL } from "node:url";
import { installMockConsole } from "./p5-ui-fixtures.mjs";

const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE;
const optional = { skip: !modulePath, timeout: 45000 };
let browser, output;
test.before(async () => {
  if (!modulePath) return;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  browser = await chromium.launch({ headless: true, channel: process.env.QQFRIEND_BROWSER_CHANNEL || "msedge" });
  output = process.env.QQFRIEND_UI_QA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-material-ui-"));
  await fs.mkdir(output, { recursive: true });
});
test.after(async () => { await browser?.close(); });
const ID = "b0415980-ccb3-4f96-b2b4-9789fc4b0a10";

async function setup(t, width) {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage();
  const mock = await installMockConsole(page);
  const job = { id: ID, action: "daily", phase: "done", startedAt: Date.now() - 2000, finishedAt: Date.now() - 1000, resultAvailable: true };
  const snapshot = { status: "ready", enabled: true, tasks: [job] };
  mock.data.capabilities.agentDrafts = snapshot;
  const toolSnapshot = mock.data.capabilities.agentTools;
  toolSnapshot.tools.push(
    { name: "read_current_attachment", label: "按需读取本轮附件", mode: "read", available: true, access: "agent_attachment" },
    { name: "draft_chat_summary", label: "生成聊天草稿", mode: "draft", available: true, access: "agent_draft" },
    { name: "read_draft_task", label: "查看或取消自己的草稿", mode: "task", available: true, access: "agent_draft" },
  );
  toolSnapshot.compatibilityCoverage = { scope: "core", materialAndDraftBusinessVerified: false };
  await page.route("**/admin/agent-drafts*", async route => {
    const url = new URL(route.request().url());
    let value = snapshot;
    if (route.request().method() === "POST") {
      value = { ok: true, task: { jobId: ID, phase: "done", cancelRequested: false } };
    } else if (url.searchParams.has("id")) {
      value = { ...snapshot, task: { ...job, result: { text: "合成草稿正文。\n" + "很长的合成段落。".repeat(60),
        sent: false, persisted: false, coverage: { captured: 20, partial: true } } } };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  t.after(async () => { mock.dispose(); await context.close(); });
  await mock.open();
  await page.locator('.view-tab[data-view="capabilities"]').click();
  await page.waitForFunction(() => globalThis.document.getElementById("agentDraftsPanel")?.textContent.includes("日报草稿"));
  return { page, mock };
}

for (const width of [320, 390, 1440]) test(`material draft full page has usable controls and wrapping at ${width}px`, optional, async t => {
  const { page, mock } = await setup(t, width);
  await page.locator('#agentDraftsPanel [data-action="inspectAgentDraft"]').click();
  await page.waitForFunction(() => globalThis.document.getElementById("agentDraftsPanel")?.textContent.includes("合成草稿正文"));
  for (const label of ["按需读取本轮附件", "生成聊天草稿", "查看或取消自己的草稿"]) {
    assert.ok((await page.locator("#agentToolsPanel").textContent()).includes(label));
  }
  const problems = await page.evaluate(() => {
    const viewport = globalThis.window.innerWidth;
    const issues = [];
    if (globalThis.document.documentElement.scrollWidth > viewport + 1) issues.push("page-overflow");
    for (const node of globalThis.document.querySelectorAll("#agentDraftsPanel button,#agentDraftActionStatus,#agentDraftsPanel pre")) {
      const box = node.getBoundingClientRect();
      if (box.width < 1 || box.left < -1 || box.right > viewport + 1) issues.push(node.dataset.action || node.tagName);
      if (node.tagName === "BUTTON" && node.scrollWidth > node.clientWidth + 1) issues.push("button-text");
    }
    return issues;
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(mock.errors, []);
  assert.deepEqual(mock.unexpected, []);
  await page.evaluate(async () => {
    globalThis.window.scrollTo(0, 0);
    await new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: path.join(output, `material-drafts-${width}.png`), fullPage: true, animations: "disabled" });
  await page.locator('.view-tab[data-view="configuration"]').click();
  assert.equal(await page.locator('#cfgAgentMaterialGroups').count(), 1);
  assert.equal(await page.locator('#cfgAgentDraftGroups').count(), 1);
  // An old/missing-field backend is not silently treated as permission to write those new lists.
  assert.equal(await page.locator('[data-list-editor-for="cfgAgentMaterialGroups"] input:not([type="hidden"])').isDisabled(), true);
  assert.equal(await page.locator('[data-list-editor-for="cfgAgentDraftGroups"] input:not([type="hidden"])').isDisabled(), true);
});
