import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));

function node(tagName = "div") {
  let text = "";
  const queries = new Map();
  return {
    tagName: tagName.toUpperCase(), value: "", hidden: true, disabled: false, dataset: {}, children: [], listeners: {}, attributes: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("diagnostics must not parse HTML"); },
    insertAdjacentHTML() { assert.fail("diagnostics must not insert HTML"); },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelectorAll() { return []; },
    querySelector(selector) { if (!queries.has(selector)) queries.set(selector, node("button")); return queries.get(selector); },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    append(...children) { this.children.push(...children); },
    insertRow() { const child = node("tr"); this.append(child); return child; },
    insertCell() { const child = node("td"); this.append(child); return child; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

async function harness(stages) {
  const nodes = new Map();
  const listeners = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const record = { id: "synthetic", at: "2026-09-23T00:00:00Z", messageId: "1", userId: "2", groupId: "3",
    scope: "group", route: "group_at", status: "sent", durationMs: 100, stages };
  const host = { mode: "browser", async call(action) {
    assert.equal(action, "getMessageTraces");
    return { items: [record], total: 1, capacity: 300, retentionHours: 24 };
  } };
  const document = {
    getElementById: element, createElement: tag => node(tag), querySelector: element,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  };
  const context = vm.createContext({ window: { QQFriendHost: host, addEventListener() {} }, document,
    MutationObserver: class { observe() {} } });
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  }
  const entry = load(path.join(ROOT, "diagnostics.js"));
  await entry.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await entry.evaluate();
  for (const listener of listeners.get("click") || []) {
    listener({ target: { closest: selector => selector === "[data-diagnostic-action]" ? { dataset: { diagnosticAction: "traces" } } : null } });
  }
  await setImmediate();
  assert.equal(element("traceNotice").dataset.error, "false", element("traceNotice").textContent);
  const steps = element("traceDetail").children.find(child => child.tagName === "OL").children;
  return { steps, text: element("traceDetail").textContent };
}

const context = (extra = {}, elapsedMs = 1) => ({ stage: "context", status: "ok", elapsedMs, ...extra });

if (!vm.SourceTextModule) {
  test("context group diagnostics render in isolated VM modules", () => {
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  test("initial groups, attachment coverage, history pruning and actual wire selection stay distinct", async () => {
    const h = await harness([
      context({ contextGroups: 9, selectedGroups: 5, prunedGroups: 4, selectedSourceCount: 27,
        rejectedSourceGroups: 2, rejectedDependencyGroups: 1, filesTotal: 3, filesIncluded: 1,
        filesUnreadable: 1, filesOmitted: 1, sources: [{ kind: "group", reason: "recent", messageId: "17", clipped: true }] }),
      context({ reason: "context_history_pruned", continuationPrunedGroups: 2, inputTextChars: 1234 }, 2),
      context({ reason: "context_wire_selected", selectedSourceCount: 1, continuationPrunedGroups: 2,
        sources: [{ kind: "file", reason: "attachment", fileIndex: 2 }] }, 3),
    ]);
    assert.match(h.steps[0].children[0].textContent, /候选组 9 · 入选组 5 · 舍弃组 4 · 初选来源 27/);
    assert.match(h.steps[0].children[0].textContent, /来源上限拒绝组 2 · 依赖不满足组 1/);
    assert.match(h.steps[0].children[0].textContent, /附件 3 \/ 已提供 1 \/ 读取失败或不支持 1 \/ 未提供 1/);
    assert.match(h.steps[0].children[1].textContent, /初选来源：群聊 17.*原话摘录或旧记录裁剪/);
    assert.match(h.steps[1].textContent, /续接时舍弃完整旧历史组.*续接累计舍弃组 2/);
    assert.match(h.steps[2].textContent, /发送前实际上下文.*发送前来源 1.*续接累计舍弃组 2/);
    assert.equal(h.steps[2].children[1].textContent, "发送前来源：第 2 份附件");
    assert.doesNotMatch(h.steps[0].textContent, /发送前实际上下文|完整原文/);
  });

  test("source display limit is disclosed without claiming wire sources were removed", async () => {
    const sources = Array.from({ length: 24 }, (_, index) => ({ kind: "thread", reason: "continuation", messageId: String(index + 1) }));
    const h = await harness([context({ reason: "context_wire_selected", selectedSourceCount: 30, sources, sourceDisplayOmitted: 6 })]);
    assert.equal(h.steps[0].children[1].textContent.match(/对话线程/g).length, 24);
    assert.match(h.steps[0].children[0].textContent, /发送前来源 30/);
    assert.match(h.steps[0].children[1].textContent, /另 6 条来源未展示/);
    assert.doesNotMatch(h.text, /已删除|已舍弃|全部来源/);
    const empty = await harness([context({ sources: [], sourceDisplayOmitted: 2 })]);
    assert.equal(empty.steps[0].children[1].textContent, "初选来源：另 2 条来源未展示");
  });

  test("file sources show only bounded ordinal and never metadata that identifies the file", async () => {
    const privateValue = "SECRET-https://example.invalid/private/report.txt";
    const h = await harness([context({ sources: [
      { kind: "file", reason: "attachment", fileIndex: 1, filename: privateValue, body: privateValue, path: privateValue, url: privateValue, messageId: privateValue },
      { kind: "file", reason: "attachment", fileIndex: 9, filename: privateValue },
    ] })]);
    assert.equal(h.steps[0].children[1].textContent, "初选来源：第 1 份附件；附件");
    assert.doesNotMatch(h.text, /SECRET|https:|report\.txt|第 9 份附件/);
  });

  test("archive completeness is explicit, never inferred from legacy or clipped sources", async () => {
    const secret = "PRIVATE-SOURCE-TEXT";
    const h = await harness([context({ sources: [
      { kind: "thread", reason: "continuation", messageId: "1", completeness: "complete", clipped: true, textChars: 999, body: secret },
      { kind: "group", reason: "recent", messageId: "2", completeness: "truncated", textChars: 777, body: secret },
      { kind: "memory", reason: "keywords", messageId: "3", completeness: "unknown", textChars: 555, body: secret },
      { kind: "quote", reason: "reply_chain", messageId: "4", clipped: true, textChars: 333, body: secret },
      { kind: "file", reason: "attachment", fileIndex: 1, completeness: "unknown", filename: secret, path: secret, textChars: 222 },
      { kind: "note", reason: "explicit_note", noteId: "abcdef123456", completeness: "future", textChars: 111 },
    ] })]);
    const labels = h.steps[0].children[1].textContent.split("；");
    assert.match(labels[0], /对话线程 1.*原话摘录或旧记录裁剪 · 存档文字完整/);
    assert.match(labels[1], /群聊 2.*存档文字已截短/);
    assert.match(labels[2], /个人历史 3.*存档完整性未知/);
    assert.match(labels[3], /引用 4.*原话摘录或旧记录裁剪/);
    assert.doesNotMatch(labels[3], /存档文字完整|存档文字已截短|存档完整性未知/);
    assert.equal(labels[4], "第 1 份附件 · 存档完整性未知");
    assert.doesNotMatch(labels[5], /存档文字完整|存档文字已截短|存档完整性未知|future/);
    assert.doesNotMatch(h.text, /PRIVATE-SOURCE-TEXT|999|777|555|333|222|111/);
  });

  test("legacy and malformed counts are not invented; existing and unknown source labels survive", async () => {
    const h = await harness([
      context({ messages: 2, sources: [{ kind: "note", reason: "explicit_note", noteId: "abcdef123456", revision: 2 }] }),
      context({ contextGroups: 0, selectedGroups: "0", prunedGroups: -1, selectedSourceCount: Infinity,
        rejectedSourceGroups: 0, filesTotal: null, filesOmitted: 1.5,
        sources: [{ kind: "future", reason: "future", messageId: "5" }] }, 2),
    ]);
    assert.equal(h.steps[0].children[0].textContent, "2 层上下文");
    assert.match(h.steps[0].children[1].textContent, /明确记忆.*本人记忆命令.*条目 abcdef123456 · 修订 2/);
    assert.equal(h.steps[1].children[0].textContent, "候选组 0 · 来源上限拒绝组 0");
    assert.equal(h.steps[1].children[1].textContent, "初选来源：上下文 5 · 相关");
  });

  test("real diagnostics layout contains context labels at desktop and narrow widths", async t => {
    const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
    if (!fs.existsSync(modulePath)) return t.skip("external Playwright runtime is not installed");
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const stages = [context({ reason: "context_wire_selected", selectedSourceCount: 30, continuationPrunedGroups: 2,
      sources: Array.from({ length: 24 }, (_, index) => ({ kind: "thread", reason: "continuation", messageId: String(index + 1), completeness: "unknown" })),
      sourceDisplayOmitted: 6, filesTotal: 3, filesIncluded: 1, filesUnreadable: 1, filesOmitted: 1 })];
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      const name = url.pathname === "/console/" ? "index.html" : url.pathname.slice("/console/".length);
      if (["index.html", "app.css", "diagnostics.css"].includes(name)) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, name)),
        contentType: name.endsWith("css") ? "text/css" : "text/html" });
      if (name === "host-client.js") return route.fulfill({ body: "window.QQFriendHost={mode:'browser',call:async action=>action==='getMessageTraces'?{items:[window.syntheticTrace],total:1,capacity:300,retentionHours:24}:action==='getReplay'?{cases:[],todayRuns:0,dailyLimit:1}:{items:[],health:'ready',total:0,stored:0,capacity:0,retentionHours:0}};",
        contentType: "text/javascript" });
      if (["diagnostics.js", "deliveries.js", "ui/tasks.js"].includes(name)) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, name)), contentType: "text/javascript" });
      if (name.startsWith("ui/") && name.endsWith(".js")) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, name)), contentType: "text/javascript" });
      if (name.endsWith(".js")) return route.fulfill({ body: "", contentType: "text/javascript" });
      return route.fulfill({ body: "", status: 404 });
    });
    await page.addInitScript(trace => { globalThis.syntheticTrace = trace; }, { id: "synthetic", at: "2026-09-23T00:00:00Z", messageId: "1", userId: "2",
      groupId: "3", scope: "group", route: "group_at", status: "sent", durationMs: 100, stages });
    await page.goto("http://context.test/console/");
    await page.evaluate(() => { globalThis.document.querySelector('[data-view-panel="diagnostics"]').hidden = false; });
    await page.waitForFunction(() => globalThis.document.getElementById("traceDetail").textContent.includes("另 6 条来源未展示"));
    for (const width of [1400, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const size = await page.evaluate(() => {
        const detail = globalThis.document.getElementById("traceDetail");
        const panel = globalThis.document.querySelector('[data-view-panel="diagnostics"]');
        return { detailWidth: detail.clientWidth, detailScroll: detail.scrollWidth, panelWidth: panel.clientWidth,
          panelScroll: panel.scrollWidth, right: panel.getBoundingClientRect().right };
      });
      assert.ok(size.detailWidth > 0, JSON.stringify(size));
      assert.ok(size.detailScroll <= size.detailWidth + 1, JSON.stringify(size));
      assert.ok(size.panelScroll <= size.panelWidth + 1, JSON.stringify(size));
      assert.ok(size.right <= width + 1, JSON.stringify(size));
    }
    assert.deepEqual(errors, []);
  });
}
