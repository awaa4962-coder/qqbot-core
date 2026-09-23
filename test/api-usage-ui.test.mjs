import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL, URLSearchParams } from "node:url";
import vm from "node:vm";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const FILTERS = ["Model", "Task", "Provider", "Position", "PromptVersion", "EffectiveMode"];

function element(tag = "div") {
  let text = "";
  return {
    tagName: tag.toUpperCase(), children: [], listeners: {}, attributes: {}, dataset: {}, hidden: true, disabled: false, value: "",
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("usage metadata must not be parsed as HTML"); },
    insertAdjacentHTML() { assert.fail("usage metadata must not be parsed as HTML"); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    insertRow() { const child = element("tr"); this.append(child); return child; },
    insertCell() { const child = element("td"); this.append(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelectorAll() { return []; },
    querySelector() { return element("button"); },
    classList: { toggle() {} },
  };
}

function leaf(extra = {}) {
  return {
    calls: 10, successfulCalls: 9, failedCalls: 1, transportAttempts: 12,
    usageReportedCalls: 10, promptReportedCalls: 10, completionReportedCalls: 10,
    reasoningReportedCalls: 10, totalReportedCalls: 10, cacheReportedCalls: 5,
    promptTokens: 3000, measuredPromptTokens: 1000, cachedTokens: 200, missTokens: 800,
    completionTokens: 100, reasoningTokens: 0, totalTokens: 3100, durationMs: 20000,
    hitCalls: 2, hitRate: 0.99, avgDurationMs: 2000, ...extra,
  };
}

function row(extra = {}) {
  return { provider: "synthetic-provider", model: "synthetic-model", task: "group_chat", position: "primary",
    promptVersion: "v2", promptFingerprint: "abcd1234", configuredMode: "deep", effectiveMode: "provider_default",
    reasoningControl: "none", reasoningApplied: "no", ...leaf(), ...extra };
}

function payload(extra = {}) {
  return { schema: 2, since: "2026-09-16T00:00:00Z", now: "2026-09-23T00:00:00Z", days: 7,
    summary: leaf(), rows: [row()],
    facets: { models: ["synthetic-model"], providers: ["synthetic-provider"], tasks: ["group_chat"], positions: ["primary"],
      promptVersions: ["v2"], configuredModes: ["deep"], effectiveModes: ["provider_default", "not_supported", "unknown"] },
    coverage: { complete: true, truncated: false, invalidRecords: 0, unreadableFiles: 0, filesRead: 7, rowsOmitted: 0 },
    localCaches: { imageDescription: { enabled: true, entries: 2, hits: 3, misses: 5, persistent: false } }, ...extra };
}

function harness({ mode = "browser", visible = false } = {}) {
  const nodes = new Map(); const calls = []; const observers = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  get("view").hidden = !visible;
  get("apiUsageDays").value = "7";
  get("apiModel").value = "unsaved-model";
  get("apiKey").value = "unsaved-key";
  get("apiRouteOutput").textContent = "unsaved-route";
  const document = { getElementById: get, querySelector: () => get("view"), createElement: element };
  const window = { QQFriendHost: { mode, call(action, query) {
    return new Promise((resolve, reject) => calls.push({ action, query, resolve, reject }));
  } } };
  vm.runInNewContext(read("api-usage.js"), { window, document,
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
  });
  return { get, calls, observers,
    show(yes = true) { get("view").hidden = !yes; observers.forEach(callback => callback()); },
    change(id, value) { get(id).value = value; get(id).listeners.change(); },
    refresh() { get("apiUsageRefresh").listeners.click(); },
    async answer(index, data = payload()) { calls[index].resolve(data); await setImmediate(); },
    async fail(index, error = new Error("synthetic failure")) { calls[index].reject(error); await setImmediate(); },
    cells(index = 0) { return get("apiUsageRows").children[index].children; },
    metric(label) { return get("apiUsageSummary").children.find(item => item.children[0].textContent === label)?.children[1].textContent; },
  };
}

test("usage lazily reads only when API view is visible; desktop remains hidden", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.show();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "getApiUsage");
  assert.equal(h.calls[0].query.days, 7);
  assert.equal(h.get("apiUsageNotice").dataset.state, "loading");
  assert.equal(h.get("apiUsagePanel").attributes["aria-busy"], "true");
  await h.answer(0);
  h.show(false); h.show();
  assert.equal(h.calls.length, 1);
  h.refresh();
  await h.answer(1);
  assert.equal(h.get("apiModel").value, "unsaved-model");
  assert.equal(h.get("apiKey").value, "unsaved-key");
  assert.equal(h.get("apiRouteOutput").textContent, "unsaved-route");
  assert.equal(harness({ visible: true }).calls.length, 1);
  const desktop = harness({ mode: "desktop", visible: true });
  assert.equal(desktop.calls.length, 0);
  assert.equal(desktop.get("apiUsagePanel").hidden, true);
  assert.equal(desktop.observers.length, 0);
});

test("reported zeros differ from unknown; cache ratio uses only measured cache input", async () => {
  const h = harness({ visible: true });
  const unknown = row({ promptReportedCalls: 0, completionReportedCalls: 0, reasoningReportedCalls: 0, totalReportedCalls: 0, cacheReportedCalls: 0,
    promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 });
  const zero = row({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cachedTokens: 0 });
  await h.answer(0, payload({ summary: zero, rows: [unknown, zero, row(), row({ measuredPromptTokens: 0, cachedTokens: 0 })] }));
  assert.equal(h.metric("输入 Token"), "0");
  assert.equal(h.metric("总计 Token"), "0");
  for (const index of [5, 6, 7, 8]) assert.equal(h.cells(0)[index].children[0].textContent, "未知");
  for (const index of [5, 6, 7]) assert.equal(h.cells(1)[index].children[0].textContent, "0");
  assert.equal(h.cells(1)[8].children[0].textContent, "0.0%");
  assert.equal(h.cells(2)[8].children[0].textContent, "20.0%");
  assert.match(h.cells(2)[8].textContent, /实测输入 1,000 Token.*已上报 5 \/ 10 次/);
  assert.equal(h.cells(3)[8].children[0].textContent, "未知");
  assert.match(h.cells(3)[8].textContent, /命中 0 \/ 实测输入 0 Token/);
  assert.equal(h.cells(2)[8].dataset.partial, "true");
  assert.match(h.get("apiUsageLocalCache").textContent, /本地图片描述缓存.*命中 3.*不持久化/);
});

test("malformed measured values stay unknown and actual modes never infer configuration", async () => {
  const h = harness({ visible: true });
  const values = [undefined, null, "0", -1, NaN, Infinity];
  await h.answer(0, payload({ rows: values.map(value => row({ promptTokens: value, completionTokens: value, reasoningTokens: value,
    cachedTokens: value, avgDurationMs: value, effectiveMode: undefined, reasoningApplied: undefined })) }));
  for (let index = 0; index < values.length; index++) {
    for (const column of [5, 6, 7, 8, 9]) assert.equal(h.cells(index)[column].children[0].textContent, "未知");
    assert.match(h.cells(index)[3].textContent, /深度 → 未知/);
  }
  h.refresh();
  await h.answer(1, payload({ rows: [row(), row({ effectiveMode: "not_supported" }), row({ effectiveMode: "unknown" })] }));
  assert.match(h.cells(0)[3].textContent, /深度 → 供应商默认.*未应用/);
  assert.match(h.cells(1)[3].textContent, /深度 → 不支持/);
  assert.match(h.cells(2)[3].textContent, /深度 → 未知/);
});

test("metadata, facets and errors remain text-only under XSS payloads", async () => {
  const attack = '<img src=x onerror="globalThis.pwned=true">';
  const h = harness({ visible: true });
  const fields = ["model", "provider", "task", "position", "promptVersion", "promptFingerprint", "configuredMode", "effectiveMode", "reasoningControl"];
  const facets = Object.fromEntries(["models", "tasks", "providers", "positions", "promptVersions", "effectiveModes"].map(key => [key, [attack]]));
  await h.answer(0, payload({ rows: [row(Object.fromEntries(fields.map(key => [key, attack])))], facets }));
  assert.ok(h.get("apiUsageRows").textContent.includes(attack));
  for (const key of FILTERS) assert.equal(h.get("apiUsage" + key).children[1].textContent, attack);
  const tags = node => [node.tagName, ...node.children.flatMap(tags)];
  assert.ok(tags(h.get("apiUsageRows")).every(tag => ["DIV", "TR", "TD", "STRONG", "SMALL"].includes(tag)));
  h.refresh(); await h.fail(1, new Error(attack));
  assert.equal(h.get("apiUsageNotice").textContent, "读取失败：" + attack);
});

test("additive reporting counts keep legacy transport and duration unknown", async () => {
  const h = harness({ visible: true });
  const legacy = row({ model: "unknown", promptVersion: "unknown", transportAttempts: 0, transportReportedCalls: 0,
    avgDurationMs: null, durationMs: 0, durationReportedCalls: 0 });
  await h.answer(0, payload({ summary: legacy, rows: [legacy] }));
  assert.equal(h.metric("平均耗时"), "未知");
  assert.match(h.get("apiUsageSummary").textContent, /传输尝试 未知/);
  assert.match(h.get("apiUsageSummary").textContent, /累计 未知/);
  assert.match(h.cells()[4].textContent, /传输 未知/);
  assert.equal(h.cells()[0].children[0].textContent, "未知");
  assert.equal(h.cells()[2].children[0].textContent, "未知");
});

test("all filters and 1/7/30-day ranges send queries without clearing selected facets", async () => {
  const h = harness({ visible: true });
  await h.answer(0);
  for (const [index, key] of FILTERS.entries()) {
    h.change("apiUsage" + key, "value & +/" + index);
    await h.answer(index + 1, payload({ facets: {} }));
    assert.equal(h.get("apiUsage" + key).value, "value & +/" + index);
    assert.ok(h.get("apiUsage" + key).children.some(option => option.value === "value & +/" + index));
  }
  for (const days of [1, 7, 30]) {
    h.change("apiUsageDays", String(days));
    const current = h.calls.length - 1;
    assert.equal(h.calls[current].query.days, days);
    for (const [index, key] of FILTERS.entries()) assert.equal(h.calls[current].query[key[0].toLowerCase() + key.slice(1)], "value & +/" + index);
    await h.answer(current);
  }
  h.change("apiUsageModel", "");
  assert.ok(!Object.hasOwn(h.calls.at(-1).query, "model"));
});

test("late success, late errors and hidden-view requests cannot replace the current query", async () => {
  const h = harness({ visible: true });
  h.change("apiUsageDays", "1");
  await h.answer(1, payload({ rows: [row({ model: "current" })] }));
  await h.answer(0, payload({ rows: [row({ model: "stale" })] }));
  assert.equal(h.cells()[0].children[0].textContent, "current");
  h.change("apiUsageDays", "30"); h.change("apiUsageDays", "7");
  await h.fail(2);
  assert.equal(h.get("apiUsageNotice").dataset.state, "loading");
  assert.equal(h.get("apiUsageRefresh").disabled, true);
  h.show(false); h.show();
  await h.answer(4, payload({ rows: [row({ model: "reopened" })] }));
  await h.answer(3);
  assert.equal(h.cells()[0].children[0].textContent, "reopened");
  assert.equal(h.get("apiUsagePanel").attributes["aria-busy"], "false");
});

test("failure, malformed schema, retry, empty results and partial file coverage are explicit", async () => {
  const h = harness({ visible: true });
  await h.fail(0);
  assert.equal(h.get("apiUsageResults").hidden, true);
  assert.equal(h.get("apiUsageRefresh").disabled, false);
  h.refresh(); await h.answer(1, { schema: 1 });
  assert.match(h.get("apiUsageNotice").textContent, /schema 2/);
  h.refresh(); await h.answer(2, payload({ summary: leaf({ calls: 0, failedCalls: 0 }), rows: [] }));
  assert.equal(h.get("apiUsageNotice").dataset.state, "empty");
  assert.equal(h.get("apiUsageRows").children[0].children[0].colSpan, 10);
  h.refresh();
  await h.answer(3, payload({ coverage: { complete: false, truncated: true, invalidRecords: 2, unreadableFiles: 3, filesRead: 4, rowsOmitted: 5 } }));
  assert.match(h.get("apiUsageCoverage").textContent, /部分覆盖.*已截断.*已读文件 4.*无效记录 2.*不可读文件 3.*省略分组 5/);
  assert.equal(h.get("apiUsageCoverage").dataset.partial, "true");
  assert.equal(h.get("apiUsageResults").hidden, false);
  h.refresh(); await h.fail(4);
  assert.equal(h.get("apiUsageResults").hidden, true, "failed refresh must not present stale data as current");
});

test("host usage read preserves existing auth and encodes only allowed query fields", async () => {
  const requests = []; let token = "old-token"; let prompts = 0;
  const window = { URLSearchParams,
    sessionStorage: { getItem: () => token, setItem(_key, value) { token = value; } },
    prompt() { prompts++; return "new-token"; },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: requests.length > 1, status: requests.length > 1 ? 200 : 403, text: async () => JSON.stringify(payload()) };
    },
  };
  vm.runInNewContext(read("host-client.js"), { window });
  const value = "a & b/+?中文";
  await window.QQFriendHost.call("getApiUsage", { days: 30, model: value, task: value, provider: value, position: value, promptVersion: value, effectiveMode: "unknown", ignored: "secret" });
  assert.equal(prompts, 1);
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    const parsed = new URL(url, "http://usage.test");
    assert.equal(parsed.pathname, "/admin/api-usage");
    assert.equal(parsed.searchParams.get("model"), value);
    assert.equal(parsed.searchParams.get("promptVersion"), value);
    assert.equal(parsed.searchParams.get("days"), "30");
    assert.equal(parsed.searchParams.has("ignored"), false);
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin");
  }
  assert.equal(requests[0].options.headers["X-QQFriend-Admin-Token"], "old-token");
  assert.equal(requests[1].options.headers["X-QQFriend-Admin-Token"], "new-token");
});

test("usage band and allowlisted assets are wired below routes and before the guide", () => {
  const html = read("index.html");
  assert.ok(html.indexOf('id="apiUsagePanel"') > html.indexOf('id="apiRouteOutput"'));
  assert.ok(html.indexOf('id="apiUsagePanel"') < html.indexOf('class="surface api-guide"'));
  assert.match(html, /id="apiUsagePanel"[^>]*hidden/);
  assert.match(html, /src="\.\/api-usage\.js/);
  assert.match(html, /href="\.\/api-usage\.css/);
  const server = fs.readFileSync(new URL("../bridge/web-console.mjs", import.meta.url), "utf8");
  assert.match(server, /\["\/console\/api-usage\.js", \["api-usage\.js", "text\/javascript; charset=utf-8"\]\]/);
  assert.match(server, /\["\/console\/api-usage\.css", \["api-usage\.css", "text\/css; charset=utf-8"\]\]/);
});

test("diagnostic usage flags distinguish legacy unknowns, known zeros and actual mode", async () => {
  if (!vm.SourceTextModule) {
    const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", "--test-name-pattern=diagnostic usage flags", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const nodes = new Map(); const listeners = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const stages = [
    { promptTokens: 50, cachedTokens: 0 },
    { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
      promptReported: true, cacheReported: true, completionReported: true, reasoningReported: true, totalReported: true },
    { promptTokens: 10, promptReported: true, cachedTokens: 0, cacheReported: false,
      configuredMode: "deep", effectiveMode: "not_supported", reasoningControl: "none", reasoningApplied: "no" },
    { completionTokens: 0, completionReported: false, reasoningTokens: 0, reasoningReported: false, totalTokens: 0, totalReported: false },
  ].map((step, index) => ({ stage: "model", status: "ok", elapsedMs: index, ...step }));
  const context = vm.createContext({
    window: { QQFriendHost: { mode: "browser", async call(action) {
      assert.equal(action, "getMessageTraces");
      return { items: [{ id: "t", at: "2026-09-23T00:00:00Z", stages, durationMs: 10 }], total: 1 };
    } }, addEventListener() {} },
    document: { getElementById: get, querySelector: get, createElement: element, addEventListener(type, listener) { if (type === "click") listeners.push(listener); } },
    MutationObserver: class { observe() {} },
  });
  const modules = new Map();
  const load = file => {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { context, identifier: file }));
    return modules.get(file);
  };
  const entry = load(path.join(ROOT, "diagnostics.js"));
  await entry.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await entry.evaluate();
  listeners.forEach(listener => listener({ target: { closest: selector => selector === "[data-diagnostic-action]" ? { dataset: { diagnosticAction: "traces" } } : null } }));
  await setImmediate();
  const steps = get("traceDetail").children.find(node => node.tagName === "OL").children;
  assert.match(steps[0].textContent, /输入 未知 \/ 缓存 未知 token/);
  assert.match(steps[1].textContent, /输入 0 \/ 缓存 0 token.*输出 0 token.*推理 0 token.*总计 0 token/);
  assert.match(steps[2].textContent, /输入 10 \/ 缓存 未知 token.*深度 → 不支持.*未应用/);
  assert.match(steps[3].textContent, /输出 未知 token.*推理 未知 token.*总计 未知 token/);
});

test("headless browser checks real DOM, auth GET, long labels and desktop/mobile overflow", async t => {
  // Optional local runtime; the dependency-free DOM tests above always run in CI.
  const modulePath = process.env.QQFRIEND_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  if (!fs.existsSync(modulePath)) return t.skip("external Playwright runtime is not installed");
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; const requests = [];
  page.on("pageerror", error => errors.push(error.message));
  const attack = '<img src=x onerror="window.pwned=true">';
  const sample = payload({ rows: [row({ model: "long-model/".repeat(18) + attack, promptVersion: "version-".repeat(12) }), row({ model: "unknown-usage", cacheReportedCalls: 0 })] });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/api-usage") {
      requests.push({ method: route.request().method(), headers: route.request().headers(), query: url.searchParams.toString() });
      return route.fulfill({ json: sample });
    }
    const name = url.pathname === "/console/" ? "index.html" : url.pathname.slice("/console/".length);
    if (["index.html", "app.css", "api-usage.css", "host-client.js", "api-usage.js", "diagnostics.css", "summaries.css"].includes(name)) {
      return route.fulfill({ body: read(name), contentType: name.endsWith("css") ? "text/css" : name.endsWith("js") ? "text/javascript" : "text/html" });
    }
    if (url.pathname.startsWith("/console/") && name.endsWith(".js")) return route.fulfill({ body: "", contentType: "text/javascript" });
    assert.fail("unmocked network request: " + url);
  });
  await page.addInitScript(() => globalThis.sessionStorage.setItem("qqfriend-admin-token", "test-token"));
  await page.goto("http://usage.test/console/");
  assert.equal(requests.length, 0);
  await page.evaluate(() => {
    globalThis.document.querySelectorAll("[data-view-panel]").forEach(node => { node.hidden = node.dataset.viewPanel !== "api-center"; });
    globalThis.document.getElementById("apiModel").value = "unsaved-model";
  });
  await page.waitForFunction(() => globalThis.document.getElementById("apiUsageNotice").dataset.state === "ready");
  assert.equal(await page.locator("#apiUsageRows img").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
  assert.match(await page.locator("#apiUsageRows").innerText(), /20\.0%/);
  await page.locator("#apiUsageDays").selectOption("30");
  await page.waitForFunction(() => globalThis.document.getElementById("apiUsagePanel").getAttribute("aria-busy") === "false");
  await page.locator("#apiUsageRefresh").click();
  await page.waitForFunction(() => globalThis.document.getElementById("apiUsagePanel").getAttribute("aria-busy") === "false");
  assert.equal(await page.locator("#apiModel").inputValue(), "unsaved-model");
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(request => request.method === "GET" && request.headers["x-qqfriend-admin-token"] === "test-token"));
  assert.equal(new URLSearchParams(requests.at(-1).query).get("days"), "30");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const dimensions = await page.evaluate(() => {
      const band = globalThis.document.getElementById("apiUsagePanel");
      const wrapper = band.querySelector(".api-usage-table-wrap");
      const badCells = [...band.querySelectorAll("td")].filter(cell => cell.scrollWidth > cell.clientWidth + 1).length;
      return { width: band.clientWidth, scrollWidth: band.scrollWidth, wrapperWidth: wrapper.clientWidth, tableWidth: wrapper.scrollWidth,
        right: band.getBoundingClientRect().right, badCells };
    });
    assert.ok(dimensions.width > 0);
    assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.right <= width + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.tableWidth >= dimensions.wrapperWidth);
    assert.equal(dimensions.badCells, 0, "cell text must not overlap neighboring columns");
    if (process.env.QQFRIEND_USAGE_SCREENSHOTS) {
      await page.locator("#apiUsagePanel").screenshot({ path: path.join(os.tmpdir(), `qqfriend-api-usage-${width}.png`), style: ".topbar { visibility: hidden; }" });
    }
  }
  assert.deepEqual(errors, []);
});
