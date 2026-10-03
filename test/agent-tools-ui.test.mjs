import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";
import { runVmTestFile } from "./vm-test-runner.mjs";

const ROOT = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const NOW = Date.parse("2026-09-30T08:00:00Z");

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
    Date: class extends Date { static now() { return NOW; } },
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

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function probeButton(panel) {
  const buttons = descendants(panel).filter(element => element.tagName === "BUTTON");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].type, "button");
  assert.equal(buttons[0].dataset.action, "probeAgentTools");
  assert.equal(buttons[0].textContent, "验证工具");
  assert.equal(buttons[0].attributes.title, "最多4次模型请求，不发送QQ消息");
  return buttons[0];
}

function slot(position, status = "verified", extra = {}) {
  return { position, model: position === "primary" ? "测试主模型" : "测试备用模型", status,
    reason: "synthetic", checkedAt: NOW - 1000, expiresAt: NOW + 60000, attempts: 2, ...extra };
}

function proof(status = "verified", extra = {}) {
  return { status, provenance: "live", slots: [slot("primary"), slot("fallback")], probeAllowed: false, requestLimit: 4, ...extra };
}

function snapshot(extra = {}) {
  return { tools: [{ name: "calculate", label: "有界计算", mode: "read", available: true, access: "agent_group" }],
    limits: { modelRounds: 4, toolCalls: 4, durationMs: 90000, transportAttempts: 8 },
    rollout: { groups: ["1105126214"], privateEnabled: false, mentionedOnly: true },
    compatibility: { status: "unknown" }, ...extra };
}

if (!vm.SourceTextModule) {
  test("agent visibility renders in isolated VM modules", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 28 })));
  });
} else {
  test("personal, reminder and action access labels stay scoped and independent of management proof", async () => {
    for (const mode of ["browser", "native"]) {
      const h = environment(mode); const { mountAgentTools } = await h.entry("agent-tools.js");
      const tools = [
        { name: "prepare_personal_change", label: "准备自己的资料变更", mode: "draft", available: true, access: "agent_personal" },
        { name: "prepare_reminder", label: "准备有限提醒", mode: "draft", available: false, access: "agent_reminder" },
        { name: "read_personal_actions", label: "查看自己的确认与提醒", mode: "read", available: true, access: "agent_actions" },
      ];
      for (const compatibility of [proof(), proof("unknown"), proof("failed"),
        proof("verified", { provenance: "qa" }), proof("verified", {
          slots: [slot("primary", "verified", { expiresAt: NOW - 1 }), slot("fallback")],
        })]) {
        const data = snapshot({ tools, compatibility }); const before = JSON.stringify(data);
        const panel = mountAgentTools(h.element("agent"), data);
        assert.deepEqual(rows(panel).slice(5, 8).map(({ value }) => value), [
          "草稿 · 服务端标记可用 · 本人当前群资料草稿（需要本人另发确认，非管理员权限）",
          "草稿 · 不可用 · 本人当前群提醒草稿（需要本人另发确认，非管理员权限）",
          "只读 · 服务端标记可用 · 本人当前群确认与提醒状态（只读，非管理员权限）",
        ]);
        assert.equal(probeButton(panel).disabled, true);
        for (const element of descendants(panel)) assert.deepEqual(element.listeners, {});
        assert.equal(JSON.stringify(data), before);
      }
      assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
    }
  });

  test("write and reminder group rows render only supplied fields with strict whitelist formatting", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const labels = { writeGroups: "本人设置工具群", reminderGroups: "提醒工具群" };
    for (const [key, label] of Object.entries(labels)) {
      for (const [groups, expected] of [
        [["1105126214", 123456789, "123456789"], "1105126214、123456789"],
        [[], "未开放（空白名单）"], [undefined, "未知"], [null, "未知"], ["123456789", "未知"],
        [{}, "未知"], [[0], "未知"], [[-1], "未知"], [[1.5], "未知"],
        [[Number.MAX_SAFE_INTEGER + 1], "未知"], [["0123"], "未知"],
        [["1".repeat(21)], "未知"], [["1105126214", "<img onerror=alert(1)>"], "未知"],
      ]) {
        const data = snapshot({ rollout: { groups: ["1105126214"], [key]: groups } });
        const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
        const rendered = rows(panel);
        assert.equal(rendered.find(row => row.label === label).value, expected);
        assert.equal(rendered.filter(row => Object.values(labels).includes(row.label)).length, 1);
        assert.equal(rendered.find(row => row.label === "灰度群白名单").value, "1105126214");
        assert.doesNotMatch(panel.textContent, /onerror|\[object|undefined|NaN/);
        assert.equal(JSON.stringify(data), before);
      }
    }
    const panel = mountAgentTools(h.element("agent"), snapshot({ rollout: {
      groups: [], writeGroups: ["123456789"], reminderGroups: ["987654321"],
    } }));
    assert.deepEqual(rows(panel).slice(1, 4).map(({ label, value }) => [label, value]), [
      ["灰度群白名单", "未开放（空白名单）"], ["本人设置工具群", "123456789"], ["提醒工具群", "987654321"],
    ]);
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("unknown access values and new snapshot fields cannot imply personal permissions", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const access of [undefined, null, true, 1, {}, [], "agent_future", "constructor", "__proto__", "agent_personal "]) {
      const data = snapshot({ tools: [{ name: "future_tool", mode: "read", available: false, access,
        grant: true, admin: true }], futurePermissions: "SYNTHETIC-PRIVATE", rollout: {
        groups: [], futureGroups: ["999999999"], permissionsGranted: true,
      } });
      const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
      assert.equal(rows(panel)[5].value, "只读 · 不可用 · 权限范围未知");
      assert.doesNotMatch(panel.textContent, /本人设置工具群|提醒工具群|SYNTHETIC-PRIVATE|999999999|需要本人另发确认/);
      assert.equal(JSON.stringify(data), before);
      for (const element of descendants(panel)) assert.deepEqual(element.listeners, {});
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("legacy snapshots omit optional group rows and remount removes old personal group state", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const container = h.element("agent");
    mountAgentTools(container, snapshot({ rollout: { groups: [], writeGroups: ["123456789"], reminderGroups: [] } }));
    for (const rollout of [undefined, null, {}, { groups: [] },
      Object.assign(Object.create({ writeGroups: ["123456789"], reminderGroups: [] }), { groups: [] })]) {
      const panel = mountAgentTools(container, snapshot({ rollout }));
      assert.doesNotMatch(panel.textContent, /本人设置工具群|提醒工具群|123456789/);
      assert.equal(container.children.length, 1);
      assert.equal(container.children[0], panel);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

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
      ["主模型", "模型未知 · 尚未验证"], ["备用模型", "模型未知 · 尚未验证"],
      ["有界计算", "只读 · 服务端标记可用 · Agent 群白名单"],
      ["公开页面读取", "只读 · 不可用 · 本轮授权公开来源（Agent 群白名单）"], ["后续工具", "模式未知 · 未知 · 权限范围未知"],
      ["模型轮次上限", "4"], ["工具调用上限", "4"], ["任务时限", "90 秒"], ["传输尝试上限", "8"],
    ]);
    assert.equal(rows(panel)[5].term.attributes.title, "有界计算（calculate）");
    assert.doesNotMatch(panel.textContent, /999999999|全部群|API 可用|成功|记忆检索|公开搜索/);
    assert.equal(h.calls.length, 0);
    const tags = descendants(panel).map(element => element.tagName);
    assert.ok(tags.every(tag => ["SECTION", "DIV", "H3", "P", "DL", "DT", "DD", "BUTTON"].includes(tag)));
    assert.ok(!tags.includes("INPUT"));
    assert.equal(probeButton(panel).disabled, true);
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
    assert.equal(rendered[5].label, attack);
    assert.equal(rendered[5].term.attributes.title, `${attack}（${attack}）`);
    assert.equal(rendered[5].detail.attributes["aria-label"], `${attack}（${attack}）：只读 · 不可用 · 权限范围未知`);
    assert.equal(rendered[6].label, "模型轮次上限"); assert.equal(rendered[6].value, "0");
    assert.ok(!rendered.slice(6).some(({ label }) => label === attack || label === "constructor"));
    assert.ok(rendered.every(({ term, detail }) => !term.children.length && !detail.children.length));
  });

  test("missing, malformed and empty snapshots do not invent availability or budgets", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const data of [undefined, null, [], true]) {
      const panel = mountAgentTools(h.element("agent"), data);
      assert.equal(panel.children[1].textContent, "尚未读取工具状态");
      assert.equal(panel.children.length, 2);
      assert.equal(probeButton(panel).disabled, true);
      assert.doesNotMatch(panel.textContent + panel.attributes["aria-label"], /只读|获准|可用|灰度|主动@/);
    }
    for (const data of [{}, { tools: [null] }, { tools: [{ name: {} }] }]) {
      const panel = mountAgentTools(h.element("agent"), data);
      assert.deepEqual(rows(panel).map(({ label, value }) => [label, value]), [
        ["新增工具范围", "未知"], ["灰度群白名单", "未知"], ["原生工具兼容性", "尚未验证"],
        ["主模型", "模型未知 · 尚未验证"], ["备用模型", "模型未知 · 尚未验证"],
        ["工具清单", "未知"], ["模型轮次上限", "未知"], ["工具调用上限", "未知"],
        ["任务时限", "未知"], ["传输尝试上限", "未知"],
      ]);
    }
    const panel = mountAgentTools(h.element("agent"), { tools: [], limits: {}, rollout: { groups: [] } });
    assert.equal(rows(panel)[1].value, "未开放（空白名单）");
    assert.equal(rows(panel)[5].value, "服务端未列出工具");
    assert.doesNotMatch(panel.textContent, /calculate|read_public_page|可用|成功/);
  });

  test("strict booleans, unknown modes and invalid limits stay unknown; zero is not missing", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const available of [undefined, null, "true", "false", 0, 1, {}, []]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ tools: [{ name: "calculate", available }] }));
      assert.equal(rows(panel)[5].value, "模式未知 · 未知 · 权限范围未知");
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
    assert.equal(rendered[5].value, "只读 · 服务端标记可用 · 当前会话权限（含获准私聊）");
    assert.equal(rendered[6].value, "只读 · 服务端标记可用 · 本条公开关键词（按当前会话权限）");
    assert.equal(rendered[7].value, "只读 · 不可用 · Agent 群白名单");
    assert.equal(rendered[8].value, "只读 · 不可用 · 本轮授权公开来源（Agent 群白名单）");
    assert.deepEqual(rendered.slice(9).map(({ label, value }) => [label, value]), [
      ["模型轮次上限", "4"], ["工具调用上限", "4"], ["任务时限", "90 秒"], ["传输尝试上限", "8"],
    ]);
    assert.doesNotMatch(panel.textContent, /SYNTHETIC-PRIVATE|已验证|成功|全部群|slotRounds|requestChars|maxTokens|responseBytes|90000/);
    assert.equal(h.calls.length, 0);
    for (const mode of ["read", "readonly", "read_only"]) {
      const alias = mountAgentTools(h.element("agent"), snapshot({ tools: [{ name: "calculate", mode, available: false }] }));
      assert.match(rows(alias)[5].value, /^只读 · 不可用/);
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
    for (const status of [undefined, null, "unknown", "ok", "success", "constructor", "__proto__", {}, true, "verified", "partial", "incompatible"]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: { status }, toolsEnabled: true, nativeTools: true }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.doesNotMatch(panel.textContent, /成功|已验证|API 可用/);
    }
    for (const [status, value] of [["failed", "验证失败"], ["unsupported", "不支持"], ["pending", "验证结果未确认"], ["unavailable", "不可用"]]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: { status } }));
      assert.equal(rows(panel)[2].value, value);
    }
  });

  test("fresh primary and fallback proof render in fixed order without changing groups or shared caps", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const compatibility = proof("verified", { slots: [
      slot("fallback", "verified", { checkedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString() }),
      slot("primary"),
    ] });
    const data = snapshot({ compatibility }); const before = JSON.stringify(data);
    const panel = mountAgentTools(h.element("agent"), data);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(rows(panel).slice(2, 5).map(({ label, value }) => [label, value]), [
      ["原生工具兼容性", "已验证"], ["主模型", "测试主模型 · 已验证"], ["备用模型", "测试备用模型 · 已验证"],
    ]);
    assert.equal(rows(panel)[1].value, "1105126214");
    assert.deepEqual(rows(panel).slice(-4).map(({ value }) => value), ["4", "4", "90 秒", "8"]);
    assert.equal(probeButton(panel).disabled, true);
    assert.equal(h.calls.length, 0);
  });

  test("each model has an independent Chinese status and cannot promote the aggregate claim", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const labels = { unknown: "尚未验证", verified: "已验证", partial: "部分验证", failed: "验证失败",
      unsupported: "不支持", pending: "验证结果未确认", unavailable: "不可用" };
    for (const [status, label] of Object.entries(labels)) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("unknown", {
        slots: [slot("primary", status), slot("fallback", "failed")],
      }), toolsEnabled: true, nativeTools: true, state: true }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.equal(rows(panel)[3].value, `测试主模型 · ${label}`);
      assert.equal(rows(panel)[4].value, "测试备用模型 · 验证失败");
    }
    for (const status of ["unknown", "partial", "failed", "unsupported", "pending", "unavailable"]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof(status) }));
      assert.equal(rows(panel)[2].value, labels[status]);
    }
    for (const status of ["unknown", "partial", "failed", "unsupported", "pending", "unavailable"]) {
      for (const position of ["primary", "fallback"]) {
        const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", {
          slots: [slot("primary", position === "primary" ? status : "verified"),
            slot("fallback", position === "fallback" ? status : "verified")],
        }) }));
        assert.equal(rows(panel)[2].value, labels[status]);
        assert.ok(rows(panel)[position === "primary" ? 3 : 4].value.endsWith(` · ${labels[status]}`));
      }
    }
  });

  test("expired or invalid positive proof becomes unknown without polling or mutating the snapshot", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const position of ["primary", "fallback"]) {
      for (const expiresAt of [NOW - 1, NOW, new Date(NOW).toISOString()]) {
        const data = snapshot({ compatibility: proof("verified", {
          slots: [slot("primary", "verified", position === "primary" ? { expiresAt } : {}),
            slot("fallback", "verified", position === "fallback" ? { expiresAt } : {})],
        }) });
        const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
        assert.equal(rows(panel)[2].value, "尚未验证");
        assert.ok(rows(panel)[position === "primary" ? 3 : 4].value.endsWith(" · 尚未验证（已过期）"));
        assert.ok(rows(panel)[position === "primary" ? 4 : 3].value.endsWith(" · 已验证"));
        assert.equal(JSON.stringify(data), before);
      }
    }
    for (const extra of [{ checkedAt: null }, { checkedAt: "1" }, { checkedAt: NOW + 1 },
      { checkedAt: {} }, { expiresAt: null }, { expiresAt: "invalid" }, { expiresAt: true },
      { expiresAt: Infinity }, { checkedAt: NOW, expiresAt: NOW - 1 }]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", {
        slots: [slot("primary", "verified", extra), slot("fallback")],
      }) }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.match(rows(panel)[3].value, /尚未验证/);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("malformed, missing and duplicate slots fail closed rather than inventing both models", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const slots of [undefined, null, {}, "verified", [], [null], [true], Array(1), Array(2),
      [slot("primary"), null], [slot("primary"), slot("primary")],
      [slot("primary"), slot("other")], [slot("primary"), slot("fallback"), slot("other")]]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", { slots }) }));
      assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
        "尚未验证", "模型未知 · 尚未验证", "模型未知 · 尚未验证",
      ]);
      assert.doesNotMatch(panel.textContent, /已验证|undefined|\[object/);
    }
    for (const position of ["primary", "fallback"]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", { slots: [slot(position)] }) }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.ok(rows(panel)[position === "primary" ? 3 : 4].value.endsWith(" · 已验证"));
      assert.equal(rows(panel)[position === "primary" ? 4 : 3].value, "模型未知 · 尚未验证");
    }
    const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("unavailable", {
      slots: [slot("primary", "unavailable", { model: null, checkedAt: null, expiresAt: null, attempts: 0 }),
        slot("fallback", "unavailable", { model: {}, checkedAt: null, expiresAt: null, attempts: 0 })],
    }) }));
    assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), ["不可用", "模型未知 · 不可用", "模型未知 · 不可用"]);
  });

  test("unsafe and fake statuses never render or become proof despite checkbox and group state", async () => {
    const h = environment("native"); const { mountAgentTools } = await h.entry("agent-tools.js");
    const attack = '<img src=x onerror=alert(1)>https://synthetic.invalid/private';
    for (const status of [undefined, null, true, 1, {}, [], "ok", "success", "incompatible", "constructor", "__proto__", attack]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof(status, {
        status, slots: [slot("primary", status, { status }), slot("fallback", status, { status })],
      }), toolsEnabled: true, nativeTools: true, state: true,
      config: { capabilities: { tools: true }, groupWhitelist: ["999999999"] } }));
      assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
        "尚未验证", "测试主模型 · 尚未验证", "测试备用模型 · 尚未验证",
      ]);
      const output = descendants(panel).map(element => element.textContent + JSON.stringify(element.attributes)).join("");
      assert.doesNotMatch(output, /已验证|onerror|https:|constructor|__proto__|999999999/);
    }
  });

  test("proof model labels use literal text and never expose raw reasons, keys, URLs or config identity", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const attack = '<img src=x onerror=alert(1)> & "<svg>"';
    const secret = "SYNTHETIC-PRIVATE-NOT-FOR-DISPLAY";
    const identity = "a".repeat(64);
    const data = snapshot({ compatibility: proof("failed", {
      apiKey: secret, url: "https://synthetic.invalid/private", configurationRevision: identity,
      slots: [slot("primary", "failed", { model: attack, reason: secret, apiKey: secret,
        endpoint: "https://synthetic.invalid/private", identity }), slot("fallback", "partial", { reason: attack })],
      requestLimit: attack,
    }) });
    const panel = mountAgentTools(h.element("agent"), data);
    assert.equal(rows(panel)[3].value, `${attack} · 验证失败`);
    assert.equal(rows(panel)[3].detail.children.length, 0);
    assert.equal(rows(panel)[4].value, "测试备用模型 · 部分验证");
    const output = descendants(panel).map(element => element.textContent + JSON.stringify(element.attributes)).join("");
    assert.ok(!output.includes(secret)); assert.ok(!output.includes(identity));
    assert.doesNotMatch(output, /https:|configurationRevision|synthetic\.invalid/);
    for (const model of ["https://synthetic.invalid/private", "file:///private/config", "www.synthetic.invalid",
      "sk-SYNTHETIC-PRIVATE", "Bearer SYNTHETIC-PRIVATE", `configurationRevision=${identity}`, identity,
      "model\nprivate", "x".repeat(81), null, {}, []]) {
      const unknown = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", {
        slots: [slot("primary", "verified", { model }), slot("fallback")],
      }) }));
      assert.equal(rows(unknown)[2].value, "尚未验证");
      assert.equal(rows(unknown)[3].value, "模型未知 · 尚未验证");
    }
  });

  test("the sole probe command is strictly parent-enabled and has no local handler or inline CSS", async () => {
    for (const mode of ["browser", "native"]) {
      const h = environment(mode); const { mountAgentTools } = await h.entry("agent-tools.js");
      for (const probeAllowed of [undefined, null, false, "true", "false", 0, 1, {}, [], true]) {
        const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("pending", { probeAllowed }) }));
        assert.equal(probeButton(panel).disabled, probeAllowed !== true);
        for (const element of descendants(panel)) {
          assert.deepEqual(element.listeners, {}); assert.deepEqual(element.style, {});
          assert.ok(!Object.hasOwn(element.attributes, "style"));
          assert.ok(Object.keys(element.attributes).every(name => !/^on/i.test(name)));
        }
      }
      const invalid = []; invalid.probeAllowed = true;
      assert.equal(probeButton(mountAgentTools(h.element("agent"), snapshot({ compatibility: invalid }))).disabled, true);
      const first = mountAgentTools(h.element("agent"), null);
      assert.equal(probeButton(first).disabled, true); assert.equal(first.children[1].textContent, "尚未读取工具状态");
      const ready = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("unknown", { probeAllowed: true }) }));
      assert.equal(probeButton(ready).disabled, false);
      const stale = mountAgentTools(h.element("agent"), snapshot());
      assert.equal(probeButton(stale).disabled, true);
      assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
    }
  });

  test("pending proof is an unconfirmed result, not evidence of a running task or live process", async () => {
    const h = environment("native"); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const extra of [{}, { checkedAt: null, expiresAt: null, attempts: 0 }]) {
      const data = snapshot({ compatibility: proof("pending", {
        slots: [slot("primary", "pending", extra), slot("fallback", "pending", extra)],
        task: { id: "synthetic-old-task", status: "running" }, processAlive: true,
      }) });
      const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
      assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
        "验证结果未确认", "测试主模型 · 验证结果未确认", "测试备用模型 · 验证结果未确认",
      ]);
      const output = descendants(panel).map(element => element.textContent + JSON.stringify(element.attributes)).join("");
      assert.doesNotMatch(output, /验证中|进程存活|任务运行中|synthetic-old-task|running|processAlive/);
      assert.equal(probeButton(panel).disabled, true);
      assert.equal(JSON.stringify(data), before);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("management proof expiry never changes tool authority, groups, parameters or parent probe permission", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const authority = panel => rows(panel).filter(({ label }) =>
      !["原生工具兼容性", "主模型", "备用模型"].includes(label)).map(({ label, value }) => [label, value]);
    const current = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", { probeAllowed: true }) }));
    const expected = authority(current);
    for (const status of ["unknown", "pending", "partial", "failed", "unsupported", "unavailable", "verified"]) {
      const data = snapshot({ compatibility: proof(status, { probeAllowed: true,
        slots: [slot("primary", "verified", { expiresAt: NOW - 1 }), slot("fallback", "verified", { expiresAt: NOW - 1 })],
      }) });
      const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
      assert.deepEqual(authority(panel), expected);
      assert.equal(rows(panel)[3].value, "测试主模型 · 尚未验证（已过期）");
      assert.equal(rows(panel)[4].value, "测试备用模型 · 尚未验证（已过期）");
      if (status === "verified") assert.equal(rows(panel)[2].value, "尚未验证");
      assert.equal(probeButton(panel).disabled, false);
      assert.equal(JSON.stringify(data), before);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("QA verified proof with two fresh slots is never accepted as live evidence or a probe permission", async () => {
    for (const mode of ["browser", "native"]) {
      const h = environment(mode); const { mountAgentTools } = await h.entry("agent-tools.js");
      for (const status of ["verified", "partial", "failed", "unsupported", "pending", "unavailable", "unknown"]) {
        const data = snapshot({ compatibility: proof(status, { provenance: "qa", probeAllowed: true,
          reason: "configuration_changed", slots: [slot("primary", status), slot("fallback", status)],
        }), toolsEnabled: true, nativeTools: true, state: true });
        const before = JSON.stringify(data);
        const panel = mountAgentTools(h.element("agent"), JSON.parse(before));
        assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
          "尚未验证", "测试主模型 · 尚未验证", "测试备用模型 · 尚未验证",
        ]);
        assert.equal(probeButton(panel).disabled, true);
        assert.equal(panel.children[1].textContent, "非生产验证快照（不作为当前配置证明）");
        assert.equal(panel.children[1].attributes.role, "status");
        assert.doesNotMatch(panel.textContent, /已验证|部分验证|验证失败|验证结果未确认|配置已变化/);
        assert.equal(rows(panel)[1].value, "1105126214");
        assert.equal(rows(panel)[5].value, "只读 · 服务端标记可用 · Agent 群白名单");
        assert.deepEqual(rows(panel).slice(-4).map(({ value }) => value), ["4", "4", "90 秒", "8"]);
        assert.equal(descendants(panel).filter(element => /^H[1-6]$/.test(element.tagName)).length, 1);
        assert.equal(JSON.stringify(data), before);
      }
      const live = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", { probeAllowed: true }) }));
      assert.equal(rows(live)[2].value, "已验证"); assert.equal(probeButton(live).disabled, false);
      const qa = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("verified", { provenance: "qa", probeAllowed: true }) }));
      assert.equal(rows(qa)[2].value, "尚未验证"); assert.equal(probeButton(qa).disabled, true);
      assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
    }
  });

  test("missing or unsafe provenance cannot promote fresh positive legacy proof or enable a probe", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    for (const provenance of [undefined, null, false, true, "", "QA", "LIVE", "unknown", {}, [],
      "https://synthetic.invalid/private", "constructor", "__proto__"]) {
      for (const status of ["verified", "partial"]) {
        const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof(status, { provenance, probeAllowed: true,
          slots: [slot("primary", status), slot("fallback", status)],
        }) }));
        assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
          "尚未验证", "测试主模型 · 尚未验证", "测试备用模型 · 尚未验证",
        ]);
        assert.equal(probeButton(panel).disabled, true);
        const output = descendants(panel).map(element => element.textContent + JSON.stringify(element.attributes)).join("");
        assert.doesNotMatch(output, /已验证|部分验证|https:|constructor|__proto__/);
      }
    }
    const legacy = mountAgentTools(h.element("agent"), snapshot());
    assert.equal(rows(legacy)[2].value, "尚未验证"); assert.equal(probeButton(legacy).disabled, true);
    assert.equal(legacy.children[1].textContent, "服务端状态快照（非 API 调用验证）");
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("fixed failure reason codes render compact Chinese feedback without raw reason attributes", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const reasons = { native_tools_not_declared: "未声明原生工具支持", protocol_not_supported: "协议不支持原生工具",
      provider_not_configured: "未配置模型服务", tool_call_missing: "未返回有效工具调用",
      no_native_call: "未调用原生工具", direct_answer_expected: "直接回答，未调用工具",
      invalid_response_envelope: "模型响应结构异常", invalid_call_envelope: "工具调用结构异常",
      multiple_calls: "返回了多次工具调用", invalid_arguments: "工具参数格式异常",
      expression_mismatch: "未计算指定表达式", truncated_response: "模型响应截断，未通过完整验证",
      tool_arguments: "工具参数不符", unexpected_tool: "返回了非预期工具",
      tool_result_wrong: "工具结果不符", reply_unusable: "验证回复不可用", wrong_answer: "验证答案不符",
      wrongargs: "工具参数不符", configuration_changed: "配置已变化",
      transport_unavailable: "验证连接不可用", too_budget: "验证预算超限",
      claim_busy: "验证任务占用", proof_unavailable: "验证证据不可用",
      cancelled: "验证已取消", probe_deadline: "验证超时", probe_budget: "验证预算超限",
      result_budget: "工具结果超限", proof_persistence_failed: "验证结果保存失败",
      malformed_state: "验证记录格式异常", probe_pending: "验证结果未确认", expired: "验证证据已过期" };
    for (const [reason, label] of Object.entries(reasons)) {
      const data = snapshot({ compatibility: proof("failed", { reason,
        slots: [slot("primary", "failed", { reason }), slot("fallback", "unavailable", { reason })],
      }) });
      const before = JSON.stringify(data); const panel = mountAgentTools(h.element("agent"), data);
      assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
        `验证失败 · ${label}`, `测试主模型 · 验证失败 · ${label}`, `测试备用模型 · 不可用 · ${label}`,
      ]);
      for (const { term, detail } of rows(panel).slice(2, 5)) {
        assert.equal(detail.children.length, 0);
        assert.ok(detail.attributes["aria-label"].endsWith(` · ${label}`));
        assert.ok(!term.attributes.title.includes(reason));
      }
      assert.equal(panel.children[1].attributes.role, "status");
      assert.equal(descendants(panel).filter(element => /^H[1-6]$/.test(element.tagName)).length, 1);
      assert.equal(panel.children.filter(element => element.tagName === "DL").length, 1);
      assert.equal(JSON.stringify(data), before);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("unsafe vendor reasons and malformed codes never leak into status text, roles, titles or aria labels", async () => {
    const h = environment(); const { mountAgentTools } = await h.entry("agent-tools.js");
    const raw = 'VENDOR-PRIVATE sk-SYNTHETIC-PRIVATE https://synthetic.invalid/private <img onerror=alert(1)>';
    for (const reason of [undefined, null, true, 1, {}, [], "constructor", "__proto__", "vendor_private_error", raw,
      "wrongargs " + raw, { code: "wrongargs", message: raw, role: raw }]) {
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: proof("failed", { reason,
        slots: [slot("primary", "failed", { reason }), slot("fallback", "failed", { reason })],
      }) }));
      assert.deepEqual(rows(panel).slice(2, 5).map(({ value }) => value), [
        "验证失败", "测试主模型 · 验证失败", "测试备用模型 · 验证失败",
      ]);
      const output = descendants(panel).map(element => element.textContent + JSON.stringify(element.attributes)).join("");
      assert.doesNotMatch(output, /VENDOR-PRIVATE|sk-SYNTHETIC|https:|synthetic\.invalid|onerror|constructor|__proto__|vendor_private_error|wrongargs/);
      assert.equal(panel.children[1].attributes.role, "status");
      for (const element of descendants(panel)) assert.deepEqual(element.listeners, {});
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("shared verification helper is passive and agrees with rendered model, time and provenance proof", async () => {
    const h = environment(); const { mountAgentTools, hasVerifiedNativeTools } = await h.entry("agent-tools.js");
    assert.equal(typeof hasVerifiedNativeTools, "function");
    let created = 0; const createElement = h.document.createElement;
    h.document.createElement = tag => { created++; return createElement(tag); };
    const cases = [
      [proof(), true],
      [proof("verified", { slots: [slot("primary", "verified", {
        checkedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(),
      }), slot("fallback")] }), true],
      [proof("verified", { slots: [slot("primary", "verified", { model: "x".repeat(80) }), slot("fallback")] }), true],
      [undefined, false], [null, false], [true, false], [[], false], [{}, false], [snapshot(), false],
      [proof("verified", { provenance: "qa" }), false],
      [proof("verified", { provenance: undefined }), false],
      [proof("verified", { provenance: "LIVE" }), false],
      [proof("verified", { slots: [] }), false],
      [proof("verified", { slots: [slot("primary")] }), false],
      [proof("verified", { slots: [slot("primary"), slot("primary")] }), false],
      [proof("verified", { slots: [slot("primary", "verified", { expiresAt: NOW }), slot("fallback")] }), false],
      [proof("verified", { slots: [slot("primary"), slot("fallback", "verified", { expiresAt: NOW - 1 })] }), false],
      [proof("verified", { slots: [slot("primary", "verified", { checkedAt: NOW + 1 }), slot("fallback")] }), false],
      [proof("verified", { slots: [slot("primary", "verified", { checkedAt: null }), slot("fallback")] }), false],
      [proof("verified", { slots: [slot("primary"), slot("fallback", "verified", { expiresAt: "invalid" })] }), false],
      [proof("verified", { slots: [slot("primary", "verified", { model: null }), slot("fallback")] }), false],
      [proof("verified", { slots: [slot("primary"), slot("fallback", "verified", { model: "https://synthetic.invalid/private" })] }), false],
    ];
    for (const status of ["unknown", "partial", "failed", "unsupported", "pending", "unavailable", "success"]) {
      cases.push([proof(status), false]);
      for (const position of ["primary", "fallback"]) cases.push([proof("verified", {
        slots: [slot("primary", position === "primary" ? status : "verified"),
          slot("fallback", position === "fallback" ? status : "verified")],
      }), false]);
    }
    for (const [value, expected] of cases) {
      const before = JSON.stringify(value); const beforeCreated = created;
      assert.equal(hasVerifiedNativeTools(value), expected);
      assert.equal(created, beforeCreated);
      assert.equal(JSON.stringify(value), before);
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: value }));
      assert.equal(hasVerifiedNativeTools(value), rows(panel)[2].value === "已验证");
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
  });

  test("shared verification helper rejects an 81-character model label in either otherwise fresh live verified slot", async () => {
    const h = environment(); const { mountAgentTools, hasVerifiedNativeTools } = await h.entry("agent-tools.js");
    for (const position of ["primary", "fallback"]) {
      const value = proof("verified", { slots: [slot("primary", "verified", position === "primary" ? { model: "x".repeat(81) } : {}),
        slot("fallback", "verified", position === "fallback" ? { model: "x".repeat(81) } : {})] });
      const before = JSON.stringify(value);
      assert.equal(value.status, "verified"); assert.equal(value.provenance, "live");
      assert.equal(hasVerifiedNativeTools(value), false);
      const panel = mountAgentTools(h.element("agent"), snapshot({ compatibility: value }));
      assert.equal(rows(panel)[2].value, "尚未验证");
      assert.equal(rows(panel)[position === "primary" ? 3 : 4].value, "模型未知 · 尚未验证");
      assert.equal(JSON.stringify(value), before);
    }
    assert.equal(h.calls.length, 0); assert.equal(h.listeners.size, 0);
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
