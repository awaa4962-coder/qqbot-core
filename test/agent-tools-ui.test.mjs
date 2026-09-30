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

function node(document, tagName = "div") {
  let text = "";
  const queries = new Map();
  return {
    ownerDocument: document, tagName: tagName.toUpperCase(), className: "", value: "", hidden: true,
    disabled: false, dataset: {}, children: [], listeners: {}, attributes: {}, style: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("UI must not parse HTML"); },
    insertAdjacentHTML() { assert.fail("UI must not insert HTML"); },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (!queries.has(selector)) queries.set(selector, node(document, "button"));
      return queries.get(selector);
    },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    append(...children) { this.children.push(...children); },
    insertRow() { const child = node(document, "tr"); this.append(child); return child; },
    insertCell() { const child = node(document, "td"); this.append(child); return child; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

function environment(mode = "browser") {
  const nodes = new Map(); const listeners = new Map(); const calls = [];
  let document;
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, node(document));
    return nodes.get(id);
  };
  document = {
    getElementById: element, createElement: tag => node(document, tag), querySelector: element,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const forbidden = () => assert.fail("agent visibility must not perform I/O, poll or attach global handlers");
  const host = { mode, async call(action, payload) {
    calls.push({ action, payload });
    assert.equal(action, "getMessageTraces");
    return { items: host.items, total: host.items.length, capacity: 300, retentionHours: 24 };
  }, items: [] };
  const window = { QQFriendHost: host, addEventListener: forbidden };
  Object.defineProperty(window, "localStorage", { get: forbidden });
  Object.defineProperty(window, "sessionStorage", { get: forbidden });
  const context = vm.createContext({
    document, window, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    setInterval: forbidden, setTimeout: forbidden, MutationObserver: forbidden,
    localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
  });
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  }
  async function entry(name) {
    const module = load(path.join(ROOT, name));
    await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
    await module.evaluate();
    return module.namespace;
  }
  return { element, document, context, host, calls, listeners, entry };
}

function rows(panel) {
  const list = panel.children.find(child => child.tagName === "DL");
  assert.ok(list);
  assert.equal(list.children.length % 2, 0);
  return Array.from({ length: list.children.length / 2 }, (_, index) => {
    const term = list.children[index * 2]; const detail = list.children[index * 2 + 1];
    assert.equal(term.tagName, "DT"); assert.equal(detail.tagName, "DD");
    assert.ok(term.attributes.title); assert.ok(detail.attributes["aria-label"]);
    return { label: term.textContent, value: detail.textContent, term, detail };
  });
}

function snapshot(extra = {}) {
  return { tools: [{ name: "calculate", label: "有界计算", mode: "read", available: true, access: "agent_group" }],
    limits: { modelRounds: 4, toolCalls: 4, durationMs: 90000, transportAttempts: 8 },
    rollout: { groups: ["1105126214"], privateEnabled: false, mentionedOnly: true },
    compatibility: { status: "unknown" }, ...extra };
}

if (!vm.SourceTextModule) {
  test("agent visibility renders in isolated VM modules", () => {
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  test("read-only compact panel renders only server tools, whitelist, limits and compatibility", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const data = snapshot({ tools: [
      { name: "calculate", label: "有界计算", mode: "read", available: true, access: "agent_group" },
      { name: "read_public_page", label: "公开页面读取", mode: "read", available: false, access: "agent_public_source" },
      { name: "future_tool", label: "后续工具", mode: "unknown", available: null },
    ], config: { groupWhitelist: ["999999999"], toolsEnabled: true }, privateEnabled: true });
    const before = JSON.stringify(data);
    const container = h.element("agent");
    const panel = mountAgentTools(container, data);
    assert.equal(container.children.length, 1); assert.equal(container.children[0], panel);
    assert.equal(JSON.stringify(data), before);
    assert.equal(panel.attributes["aria-label"], "有限工具状态");
    assert.equal(panel.children[0].children[0].textContent, "有限工具");
    assert.equal(panel.children[1].attributes.role, "status");
    assert.match(panel.children[1].textContent, /非 API 调用验证/);
    assert.match(panel.children[1].attributes["aria-label"], /^有限工具状态：/);
    assert.deepEqual(rows(panel).map(({ label, value }) => [label, value]), [
      ["新增工具范围", "主动@ · 灰度群"], ["灰度群白名单", "1105126214"], ["原生工具兼容性", "尚未验证"],
      ["有界计算", "只读 · 服务端标记可用 · Agent 群白名单"],
      ["公开页面读取", "只读 · 不可用 · 本轮授权公开来源（Agent 群白名单）"], ["后续工具", "模式未知 · 未知 · 权限范围未知"],
      ["模型轮次上限", "4"], ["工具调用上限", "4"], ["任务时限", "90 秒"], ["传输尝试上限", "8"],
    ]);
    assert.equal(rows(panel)[3].term.attributes.title, "有界计算（calculate）");
    assert.doesNotMatch(panel.textContent, /999999999|全部群|API 可用|成功|记忆检索|公开搜索/);
    assert.equal(h.calls.length, 0);
    const tags = element => [element.tagName, ...element.children.flatMap(tags)];
    assert.ok(tags(panel).every(tag => ["SECTION", "DIV", "H3", "P", "DL", "DT", "DD"].includes(tag)));
    assert.ok(!tags(panel).includes("INPUT"));
    assert.ok(!panel.className.includes("surface"));
  });

  test("tool names, labels and attributes are literal text; extra limit keys never render", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const attack = '<img src=x onerror=alert(1)> & "<svg onload=alert(1)>"';
    const panel = mountAgentTools(h.element("agent"), snapshot({
      tools: [{ name: attack, label: attack, mode: "readonly", available: false }],
      limits: { [attack]: 0, constructor: 1, modelRounds: 0 },
    }));
    const rendered = rows(panel);
    assert.equal(rendered[3].label, attack);
    assert.equal(rendered[3].term.attributes.title, `${attack}（${attack}）`);
    assert.equal(rendered[3].detail.attributes["aria-label"], `${attack}（${attack}）：只读 · 不可用 · 权限范围未知`);
    assert.equal(rendered[4].label, "模型轮次上限"); assert.equal(rendered[4].value, "0");
    assert.ok(!rendered.slice(4).some(({ label }) => label === attack || label === "constructor"));
    assert.ok(rendered.every(({ term, detail }) => !term.children.length && !detail.children.length));
  });

  test("missing, malformed and empty snapshots do not invent availability or budgets", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const data of [undefined, null, [], true]) {
      const panel = mountAgentTools(h.element("agent"), data);
      assert.equal(panel.children[1].textContent, "尚未读取工具状态");
      assert.equal(panel.children.length, 2);
      assert.doesNotMatch(panel.textContent + panel.attributes["aria-label"], /只读|获准|可用|灰度|主动@/);
    }
    for (const data of [{}, { tools: [null] }, { tools: [{ name: {} }] }]) {
      const panel = mountAgentTools(h.element("agent"), data);
      assert.deepEqual(rows(panel).map(({ label, value }) => [label, value]), [
        ["新增工具范围", "未知"], ["灰度群白名单", "未知"], ["原生工具兼容性", "尚未验证"],
        ["工具清单", "未知"], ["模型轮次上限", "未知"], ["工具调用上限", "未知"],
        ["任务时限", "未知"], ["传输尝试上限", "未知"],
      ]);
    }
    const panel = mountAgentTools(h.element("agent"), { tools: [], limits: {}, rollout: { groups: [] } });
    assert.equal(rows(panel)[1].value, "未开放（空白名单）");
    assert.equal(rows(panel)[3].value, "服务端未列出工具");
    assert.doesNotMatch(panel.textContent, /calculate|read_public_page|可用|成功/);
  });

  test("strict booleans, unknown modes and invalid limits stay unknown; zero is not missing", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const available of [undefined, null, "true", "false", 0, 1, {}, []]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ tools: [{ name: "calculate", available }] }));
      assert.equal(rows(panel)[3].value, "模式未知 · 未知 · 权限范围未知");
    }
    const invalid = [undefined, null, "8", true, -1, 1.5, NaN, Infinity, {}, [], Number.MAX_SAFE_INTEGER + 1];
    for (const toolCalls of invalid) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ limits: { toolCalls } }));
      assert.equal(rows(panel).find(({ label }) => label === "工具调用上限").value, "未知");
      assert.doesNotMatch(panel.textContent, /undefined|NaN|Infinity|\[object/);
    }
    const panel = mountAgentTools(h.element("agent"), snapshot({ limits: { toolCalls: 0, durationMs: 1500, futureLimit: 12 } }));
    assert.deepEqual(rows(panel).slice(-4).map(({ label, value }) => [label, value]), [
      ["模型轮次上限", "未知"], ["工具调用上限", "0"], ["任务时限", "1.5 秒"], ["传输尝试上限", "未知"],
    ]);
    assert.ok(!panel.textContent.includes("futureLimit"));
  });

  test("parent read-mode projection and shared CHAT_TOOL_LIMITS render without enabling default-off tools", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const secret = "SYNTHETIC-PRIVATE-NOT-FOR-DISPLAY";
    const panel = mountAgentTools(h.element("agent"), {
      tools: [
        { name: "recall_memory", label: "查自己的记忆", mode: "read", available: true, access: "current_scope", credentials: secret },
        { name: "web_search", label: "搜索公开资料", mode: "read", available: true, access: "public_query" },
        { name: "calculate", label: "计算", mode: "read", available: false, access: "agent_group" },
        { name: "read_public_page", label: "读取公开原文", mode: "read", available: false, access: "agent_public_source" },
      ],
      rollout: { groups: [], privateEnabled: false, mentionedOnly: true }, compatibility: { status: "unknown" },
      limits: { modelRounds: 4, transportAttempts: 8, toolCalls: 4, slotRounds: 3, durationMs: 90000,
        requestChars: 24000, resultChars: 2000, totalResultChars: 6000, maxTokens: 1536, responseBytes: 262144, replyChars: 6000 },
      metadata: { toolsEnabled: true, apiKey: secret },
    });
    const rendered = rows(panel);
    assert.equal(rendered[1].value, "未开放（空白名单）");
    assert.equal(rendered[2].value, "尚未验证");
    assert.equal(rendered[0].label, "新增工具范围"); assert.equal(rendered[0].value, "主动@ · 灰度群");
    assert.equal(rendered[3].value, "只读 · 服务端标记可用 · 当前会话权限（含获准私聊）");
    assert.equal(rendered[4].value, "只读 · 服务端标记可用 · 本条公开关键词（按当前会话权限）");
    assert.equal(rendered[5].value, "只读 · 不可用 · Agent 群白名单");
    assert.equal(rendered[6].value, "只读 · 不可用 · 本轮授权公开来源（Agent 群白名单）");
    assert.deepEqual(rendered.slice(7).map(({ label, value }) => [label, value]), [
      ["模型轮次上限", "4"], ["工具调用上限", "4"], ["任务时限", "90 秒"], ["传输尝试上限", "8"],
    ]);
    assert.doesNotMatch(panel.textContent, /SYNTHETIC-PRIVATE|已验证|成功|全部群|slotRounds|requestChars|maxTokens|responseBytes|90000/);
    assert.equal(h.calls.length, 0);
    for (const mode of ["read", "readonly", "read_only"]) {
      const alias = mountAgentTools(h.element("agent"), snapshot({ tools: [{ name: "calculate", mode, available: false }] }));
      assert.match(rows(alias)[3].value, /^只读 · 不可用/);
    }
  });

  test("groups are only a strict supplied whitelist, never private or all-group fallback", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const invalid = [undefined, null, "1105126214", ["*"], ["all"], ["private"], ["1105126214", "bad"], [true], [0], [1e20], [{}]];
    for (const groups of invalid) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ rollout: { groups }, config: { groupWhitelist: ["999999999"] } }));
      assert.equal(rows(panel)[1].value, "未知");
      assert.doesNotMatch(panel.textContent, /999999999|私聊|全部群/);
    }
    const panel = mountAgentTools(h.element("agent"), snapshot({ rollout: { groups: ["1105126214", 1105126214, "123456789"] } }));
    assert.equal(rows(panel)[1].value, "1105126214、123456789");
  });

  test("native host or tools checkbox cannot upgrade unverified compatibility to success", async () => {
    const h = environment("native"); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const status of [undefined, null, "unknown", "ok", "success", "constructor", "__proto__", {}, true]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: { status }, toolsEnabled: true, nativeTools: true }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.doesNotMatch(panel.textContent, /成功|已验证|API 可用/);
    }
    for (const [status, value] of [["verified", "已验证"], ["incompatible", "不兼容"], ["unsupported", "不支持"]]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: { status } }));
      assert.equal(rows(panel)[2].value, value);
    }
  });

  test("import, mount and remount are passive, preserve siblings and replace stale snapshot rows", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0); assert.equal(h.element("unused").children.length, 0);
    const parent = h.element("parent"); const container = h.element("agent");
    const sibling = node(h.document, "input"); sibling.value = "existing dirty UI";
    parent.append(container, sibling);
    const first = mountAgentTools(container, snapshot());
    const second = mountAgentTools(container, { tools: [], rollout: { groups: [] } });
    assert.notEqual(first, second); assert.equal(container.children.length, 1); assert.equal(container.children[0], second);
    assert.equal(parent.children[1], sibling); assert.equal(sibling.value, "existing dirty UI");
    assert.doesNotMatch(second.textContent, /有界计算|1105126214|服务端标记可用/);
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
    assert.throws(() => mountAgentTools(null, snapshot()), /DOM container/);
  });

  test("existing diagnostics translate the two new trace names without new automatic calls", async () => {
    const h = environment();
    vm.runInContext("window.addEventListener = () => {}; MutationObserver = class { observe() {} };", h.context);
    const names = [["calculate", "有界计算"], ["read_public_page", "公开页面读取"]];
    h.host.items = [{ id: "synthetic", at: "2026-09-30T00:00:00Z", scope: "group", groupId: "1105126214",
      userId: "123456789", messageId: "123", route: "group_at", status: "sent", durationMs: 20,
      stages: names.map(([toolName], index) => ({ stage: "tool", status: "ok", reason: "tool_completed", toolName, elapsedMs: (index + 1) * 10 })),
    }];
    await h.entry("diagnostics.js");
    assert.equal(h.calls.length, 0);
    for (const listener of h.listeners.get("click") || []) {
      listener({ target: { closest: selector => selector === "[data-diagnostic-action]" ? { dataset: { diagnosticAction: "traces" } } : null } });
    }
    await setImmediate();
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].action, "getMessageTraces");
    assert.equal(h.element("traceNotice").dataset.error, "false", h.element("traceNotice").textContent);
    const steps = h.element("traceDetail").children.find(child => child.tagName === "OL").children;
    assert.equal(steps.length, 2);
    for (const [index, [name, label]] of names.entries()) {
      assert.equal(steps[index].children[0].textContent, `工具完成 · ${label}`);
      assert.ok(!steps[index].textContent.includes(name));
    }
  });
}
