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
const COUNTERS = ["modelRounds", "transportAttempts", "toolCalls", "toolOutputChars", "requestedCompletionTokens", "toolResultChars", "modelRoundLimit", "toolLimit"];

function node(tagName = "div") {
  let text = "";
  const classes = new Set();
  const queries = new Map();
  return {
    tagName: tagName.toUpperCase(), value: "", hidden: true, disabled: false, dataset: {}, children: [], listeners: {}, attributes: {},
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("trace rendering must not parse HTML"); },
    insertAdjacentHTML() { assert.fail("trace rendering must not insert HTML"); },
    classList: { toggle(name, yes) { if (yes) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
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

async function harness(items) {
  const nodes = new Map(); const listeners = new Map(); const calls = [];
  const element = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let rows = items;
  const host = { mode: "browser", async call(action, payload) {
    calls.push({ action, payload });
    assert.equal(action, "getMessageTraces", "only the existing trace read is expected");
    return { items: rows, total: rows.length, capacity: 300, retentionHours: 24 };
  } };
  const document = {
    getElementById: element, createElement: tag => node(tag), querySelector: element,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  };
  const context = vm.createContext({
    window: { QQFriendHost: host, addEventListener() {} }, document,
    MutationObserver: class { observe() {} },
  });
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  }
  const entry = load(path.join(ROOT, "diagnostics.js"));
  await entry.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await entry.evaluate();
  assert.equal(calls.length, 0);
  async function refresh(next = rows) {
    rows = next;
    for (const listener of listeners.get("click") || []) {
      listener({ target: { closest: selector => selector === "[data-diagnostic-action]" ? { dataset: { diagnosticAction: "traces" } } : null } });
    }
    await setImmediate();
    assert.equal(element("traceNotice").dataset.error, "false", element("traceNotice").textContent);
    assert.equal(element("messageTracePanel").attributes["aria-busy"], "false");
  }
  await refresh();
  const steps = () => element("traceDetail").children.find(child => child.tagName === "OL")?.children || [];
  return { element, calls, refresh, steps, text: () => element("traceDetail").textContent };
}

function trace(stages, extra = {}) {
  return { id: "synthetic-trace", at: "2026-09-23T00:00:00Z", messageId: "123", userId: "456", groupId: "789",
    scope: "group", route: "group_at", status: "sent", durationMs: 100, stages, ...extra };
}

if (!vm.SourceTextModule) {
  test("tool diagnostics render in isolated VM modules", () => {
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  test("tool traces render fixed Chinese names, counters and explicit request quota in the existing detail", async () => {
    const names = [["recall_memory", "记忆检索"], ["read_bot_status", "机器人状态"], ["web_search", "公开搜索"]];
    const h = await harness([trace(names.map(([toolName], index) => ({
      stage: "tool", status: "ok", reason: "tool_completed", toolName, elapsedMs: (index + 1) * 10,
      modelRounds: 2, transportAttempts: 3, toolCalls: 1, toolOutputChars: 120, requestedCompletionTokens: 4096,
      toolResultChars: 60, modelRoundLimit: 6, toolLimit: 8,
    })))]);
    assert.equal(h.steps().length, 3);
    for (const [index, [name, chinese]] of names.entries()) {
      const step = h.steps()[index];
      assert.ok(step.textContent.startsWith("工具 · 成功 · +10 ms"));
      assert.equal(step.children.length, 1);
      assert.equal(step.children[0].tagName, "SPAN");
      assert.equal(step.children[0].textContent, `工具完成 · ${chinese} · 模型轮次 2 / 6 · 工具调用 1 / 8 · 传输尝试 3 次 · 本次结果 60 字符 · 工具累计输出 120 字符 · 累计请求额度 4096 token（非实际用量）`);
      assert.ok(!step.textContent.includes(name));
    }
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].payload.limit, 100);
    assert.equal(h.element("traceRows").children.length, 1);
  });

  const reasons = [
    ["tool_model_round", "模型轮次", "ok", "成功"], ["tool_completed", "工具完成", "ok", "成功"],
    ["tool_empty", "无结果", "skipped", "跳过"], ["tool_denied", "权限拒绝", "skipped", "跳过"],
    ["tool_arguments", "参数无效", "skipped", "跳过"], ["tool_unavailable", "工具不可用", "failed", "失败"],
    ["tool_reused", "复用结果", "ok", "成功"], ["tool_budget", "达到预算上限", "failed", "失败"],
  ];
  for (const [reason, chinese, status, statusText] of reasons) test("tool reason renders without raw code: " + reason, async () => {
    const h = await harness([trace([{ stage: "tool", status, reason, elapsedMs: 10 }], { status: "no_reply", reason })]);
    assert.equal(h.element("traceDetail").children[2].textContent, chinese);
    assert.equal(h.steps()[0].children[0].textContent, chinese);
    assert.ok(h.steps()[0].textContent.startsWith(`工具 · ${statusText} · +10 ms`));
    assert.ok(!h.text().includes(reason));
    assert.doesNotMatch(h.text(), /undefined|NaN|token|工具调用/);
  });

  test("zero counts and standalone limits render without inventing missing values", async () => {
    const h = await harness([trace([
      { stage: "tool", status: "started", elapsedMs: 0, ...Object.fromEntries(COUNTERS.map(key => [key, 0])) },
      { stage: "tool", status: "ok", elapsedMs: 1, modelRoundLimit: 6, toolLimit: 8 },
      { stage: "tool", status: "ok", elapsedMs: 2, modelRounds: 2, toolCalls: 1 },
      { stage: "tool", status: "ok", elapsedMs: 3 },
    ])]);
    assert.ok(h.steps()[0].textContent.startsWith("工具 · 开始 · +0 ms"));
    assert.equal(h.steps()[0].children[0].textContent, "模型轮次 0 / 0 · 工具调用 0 / 0 · 传输尝试 0 次 · 本次结果 0 字符 · 工具累计输出 0 字符 · 累计请求额度 0 token（非实际用量）");
    assert.equal(h.steps()[1].children[0].textContent, "模型轮次上限 6 · 工具调用上限 8");
    assert.equal(h.steps()[2].children[0].textContent, "模型轮次 2 · 工具调用 1");
    assert.equal(h.steps()[3].children[0].textContent, "");
  });

  test("tool metadata rejects nonnumeric, nonfinite, negative and out-of-contract counts", async () => {
    const invalid = [undefined, null, false, "3", "<img src=x onerror=alert(1)>", {}, [], NaN, Infinity, -Infinity, -1, 1e9 + 1];
    const h = await harness([trace(invalid.map((value, index) => ({ stage: "tool", status: "ok", elapsedMs: index,
      ...Object.fromEntries(COUNTERS.map(key => [key, value])),
    })))]);
    assert.equal(h.steps().length, invalid.length);
    for (const step of h.steps()) assert.equal(step.children[0].textContent, "");
    await h.refresh([trace([{ stage: "tool", status: "ok", elapsedMs: 0, modelRounds: 1e9 }])]);
    assert.equal(h.steps()[0].children[0].textContent, "模型轮次 1000000000");
  });

  test("tool stages ignore unknown names, raw errors, arguments, queries, bodies and reasoning", async () => {
    const privateText = "PRIVATE-SYNTHETIC-<img src=x onerror=alert(1)>";
    const unknownValues = [privateText, "constructor", "__proto__", "toString", "future_tool", null, {}, ["web_search"], ["tool_completed"], { toString: privateText }];
    const h = await harness([trace(unknownValues.map((toolName, index) => ({
      stage: "tool", status: privateText, reason: toolName, toolName, elapsedMs: index,
      args: { query: privateText }, arguments: privateText, query: privateText,
      result: { body: privateText }, resultBody: privateText, content: privateText, error: privateText,
      reasoning: privateText, reasoning_content: privateText, internalReasoning: privateText,
      provider: privateText, model: privateText, promptVersion: privateText,
      sources: [{ kind: "note", messageId: privateText, noteId: privateText }],
      unknownCounter: privateText,
    })))]);
    for (const step of h.steps()) {
      assert.ok(step.textContent.startsWith("工具 · 待判断 · +"));
      assert.equal(step.children.length, 1);
      assert.equal(step.children[0].textContent, "");
    }
    assert.doesNotMatch(h.text(), /PRIVATE|<img|constructor|__proto__|toString|future_tool/);
  });

  test("known tool names do not expose attached bodies and other metadata stays text-only", async () => {
    const attack = "<svg onload=alert(1)>";
    const h = await harness([trace([
      { stage: "tool", status: "ok", reason: "tool_completed", toolName: "web_search", elapsedMs: 10,
        query: attack, arguments: attack, result: attack, reasoning_content: attack, toolResultChars: 23 },
      { stage: "model", status: "ok", provider: attack, elapsedMs: 20 },
    ], { messageId: attack })]);
    assert.equal(h.steps()[0].children[0].textContent, "工具完成 · 公开搜索 · 本次结果 23 字符");
    assert.equal(h.steps()[1].children[0].textContent, attack);
    assert.ok(h.element("traceDetail").children[1].textContent.includes(attack));
    const tags = element => [element.tagName, ...element.children.flatMap(tags)];
    assert.ok(tags(h.element("traceDetail")).every(tag => ["DIV", "H3", "P", "OL", "LI", "SPAN"].includes(tag)));
  });

  test("existing context and model details survive selection, refresh and empty trace lists", async () => {
    const legacy = trace([
      { stage: "context", status: "ok", elapsedMs: 5, messages: 2,
        sources: [{ kind: "note", reason: "explicit_note", noteId: "abcdef123456", revision: 2 }] },
      { stage: "model", status: "ok", elapsedMs: 20, provider: "synthetic", position: "primary", model: "synthetic-model", promptTokens: 100, cachedTokens: 40,
        modelRounds: 2, modelRoundLimit: 6, toolCalls: 1, toolLimit: 8 },
    ], { id: "legacy" });
    const tool = trace([{ stage: "tool", status: "ok", reason: "tool_completed", toolName: "recall_memory", elapsedMs: 1 }]);
    const h = await harness([legacy, tool]);
    assert.equal(h.steps()[0].children[0].textContent, "2 层上下文");
    assert.match(h.steps()[0].children[1].textContent, /明确记忆.*本人记忆命令.*条目 abcdef123456 · 修订 2/);
    assert.equal(h.steps()[1].children[0].textContent, "synthetic · 主模型 · synthetic-model · 输入 100 / 缓存 40 token · 模型轮次 2 / 6 · 工具调用 1 / 8");
    const button = h.element("traceRows").children[1].children[0].children[0];
    button.listeners.click();
    assert.equal(h.steps()[0].children[0].textContent, "工具完成 · 记忆检索");
    assert.equal(h.calls.length, 1);
    await h.refresh([tool, legacy]);
    assert.equal(h.steps()[0].children[0].textContent, "工具完成 · 记忆检索");
    assert.equal(h.element("traceRows").children[0].children[0].children[0].attributes["aria-pressed"], "true");
    await h.refresh([]);
    assert.equal(h.text(), "选择一条记录查看处理阶段");
    assert.equal(h.element("traceRows").textContent, "暂无符合条件的记录");
    assert.equal(h.steps().length, 0);
  });
}
