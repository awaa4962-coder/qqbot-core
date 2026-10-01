import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";

const SOURCE = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/agent-writes.js", import.meta.url));
const CONTROLLER = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/ui/agent-write-actions.js", import.meta.url));
const HOST = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/host-client.js", import.meta.url));
const START = Date.parse("2026-10-01T00:00:00Z");
const CF = "cf_0123456789abcdef0123456789abcdef";
const REM = "rem_abcdef0123456789abcdef0123456789";
const ACTIONS = { set_name: "修改称呼", set_style: "修改风格", memory_create: "新增记忆",
  memory_update: "修改记忆", memory_remove: "删除记忆", create: "创建提醒", cancel: "取消提醒" };
const PHASES = { pending: "待本人确认", executing: "执行中", applied: "已应用", not_applied: "未应用",
  unknown: "结果未知", revoked: "已撤销", expired: "已过期", invalidated: "已失效", armed: "待发送", sending: "发送中",
  sent: "已发送", failed: "失败", cancelled: "已取消", partial: "部分完成", interrupted: "已中断" };
const PRIVATE = "SYNTHETIC_PRIVATE_BODY_918273645";

function node(document, tag = "div") {
  let text = "";
  return {
    ownerDocument: document, tagName: tag.toUpperCase(), className: "", children: [], attributes: {},
    dataset: {}, style: {}, disabled: false,
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("HTML parsing forbidden"); },
    set outerHTML(_value) { assert.fail("HTML parsing forbidden"); },
    insertAdjacentHTML() { assert.fail("HTML parsing forbidden"); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ""; this.children = [...children]; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener() { assert.fail("renderer callbacks forbidden"); },
  };
}

async function environment() {
  const forbidden = () => assert.fail("renderer I/O, clocks, timers, storage and callbacks forbidden");
  const document = { createElement: tag => node(document, tag), addEventListener: forbidden };
  const window = new Proxy({}, { get: forbidden });
  const context = vm.createContext({ document, window, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    setInterval: forbidden, setTimeout: forbidden, queueMicrotask: forbidden, MutationObserver: forbidden,
    localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
    navigator: new Proxy({}, { get: forbidden }), console: new Proxy({}, { get: forbidden }) });
  vm.runInContext("Date.now = () => { throw new Error('live clock forbidden'); }", context);
  const module = new vm.SourceTextModule(fs.readFileSync(SOURCE, "utf8"), { identifier: SOURCE, context });
  await module.link(() => assert.fail("standalone renderer imports forbidden"));
  await module.evaluate();
  return { document, container: () => node(document), mount: module.namespace.mountAgentWrites, module: module.namespace };
}

async function controllerEnvironment(mode = "browser") {
  const document = { createElement: tag => node(document, tag) };
  const panel = node(document); const status = node(document, "p");
  panel.querySelectorAll = () => find(panel, "button").filter(button => button.dataset.action === "refreshAgentWrites");
  const elements = { agentWritesPanel: panel, agentWriteActionStatus: status };
  const calls = []; const events = []; let busy = false; let reply = loaded();
  const host = { mode, call: async (action, payload) => {
    calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
    return typeof reply === "function" ? reply() : reply;
  } };
  const context = vm.createContext({ document });
  const synthetic = (exports, name) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context, identifier: name });
  const dependencies = {
    "./state.js": synthetic({ host }, "state"),
    "./dom.js": synthetic({ $: id => elements[id] }, "dom"),
    "./activity.js": synthetic({
      beginAction: (action, button, silent) => {
        if (busy) return false;
        events.push({ type: "begin", action, button, silent }); busy = true; return true;
      },
      endAction: action => { events.push({ type: "end", action }); busy = false; },
      groupIsBusy: () => busy,
      finishActivity: (message, tone) => events.push({ type: "finish", message, tone }),
      toast: (message, tone) => events.push({ type: "toast", message, tone }),
    }, "activity"),
    "../agent-writes.js": new vm.SourceTextModule(fs.readFileSync(SOURCE, "utf8"), { context, identifier: SOURCE }),
  };
  const module = new vm.SourceTextModule(fs.readFileSync(CONTROLLER, "utf8"), { context, identifier: CONTROLLER });
  await module.link(name => {
    assert.ok(Object.hasOwn(dependencies, name), "unexpected controller dependency: " + name);
    return dependencies[name];
  });
  await module.evaluate();
  return { controller: module.namespace, host, panel, status, calls, events, setReply: value => { reply = value; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const confirmation = (extra = {}) => ({ ref: CF, action: "set_name", phase: "pending", createdAt: START, expiresAt: START + 300000, ...extra });
const reminder = (extra = {}) => ({ ref: REM, phase: "armed", createdAt: START, dueAt: START + 3600000, ...extra });
const ready = (extra = {}) => ({ status: "ready", enabled: false,
  confirmations: { status: "ready", items: [] }, reminders: { status: "ready", items: [] }, ...extra });
const loaded = (extra = {}) => ready({ enabled: true, confirmations: { status: "ready", items: [confirmation()] },
  reminders: { status: "ready", items: [reminder()] }, ...extra });
const descendants = element => [element, ...element.children.flatMap(descendants)];
const find = (element, tag) => descendants(element).filter(item => item.tagName === tag.toUpperCase());
const region = (element, kind) => descendants(element).find(item => item.className === "agent-writes-" + kind);
const output = element => descendants(element).map(item => item.textContent + JSON.stringify(item.attributes) + JSON.stringify(item.dataset)).join("\n");
const render = (h, value) => h.mount(h.container(), value);
const withItems = (kind, items) => ready({ [kind]: { status: "ready", items } });

if (!vm.SourceTextModule) {
  test("agent writes execute real isolated VM cases", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 46 })));
  });
} else {
  test("pure renderer exports only its parent-facing mount function", async () => {
    const h = await environment();
    assert.deepEqual(Object.keys(h.module), ["mountAgentWrites"]);
    const panel = render(h, loaded());
    assert.equal(find(panel, "button").length, 1);
    assert.equal(find(panel, "a").length, 0); assert.equal(find(panel, "input").length, 0);
    assert.equal(find(panel, "form").length, 0); assert.equal(find(panel, "pre").length, 0);
  });

  test("closed empty snapshot explicitly stays unopened without fake success or counts", async () => {
    const h = await environment(); const panel = render(h, ready());
    assert.match(panel.textContent, /未开放/); assert.match(panel.textContent, /服务端未列出确认记录/);
    assert.match(panel.textContent, /服务端未列出提醒记录/);
    assert.doesNotMatch(panel.textContent, /成功|已应用|已发送|已开放|0.*记录/);
    assert.equal(find(panel, "table").length, 0);
  });

  test("enabled empty snapshot shows only actual open and empty metadata states", async () => {
    const h = await environment(); const panel = render(h, ready({ enabled: true }));
    assert.match(panel.textContent, /已开放/); assert.match(panel.textContent, /未列出确认记录/);
    assert.doesNotMatch(panel.textContent, /成功|已应用|已发送/);
  });

  test("global unavailable suppresses stale metadata and keeps refresh available", async () => {
    const h = await environment();
    for (const enabled of [true, false]) {
      const panel = render(h, loaded({ status: "unavailable", enabled }));
      assert.match(panel.textContent, /状态无法读取/); assert.match(panel.textContent, /确认记录无法读取/);
      assert.match(panel.textContent, /提醒记录无法读取/);
      assert.doesNotMatch(panel.textContent, /已开放|待本人确认|待发送|未列出|0123456789/);
      assert.equal(find(panel, "table").length, 0); assert.equal(find(panel, "button")[0].disabled, false);
    }
  });

  test("missing malformed inherited and nonboolean top-level DTOs fail closed", async () => {
    const h = await environment();
    for (const value of [undefined, null, true, [], {}, "ready", ready({ status: "success" }), ready({ status: "constructor" }),
      ready({ enabled: undefined }), ready({ enabled: 1 }), ready({ enabled: "false" }), Object.create(loaded()), new Date()]) {
      const panel = render(h, value);
      assert.match(panel.textContent, /状态未知/); assert.doesNotMatch(panel.textContent, /未列出|已开放|未开放|成功/);
      assert.equal(find(panel, "table").length, 0);
    }
  });

  test("unavailable top-level DTO never consults stale section getters", async () => {
    const h = await environment(); const value = { status: "unavailable", enabled: false };
    for (const key of ["confirmations", "reminders"]) Object.defineProperty(value, key, { get: () => assert.fail("stale section read") });
    const panel = render(h, value);
    assert.match(panel.textContent, /无法读取.*未开放/); assert.equal(find(panel, "table").length, 0);
  });

  test("each unavailable service hides only its own stale list without fabricating emptiness", async () => {
    const h = await environment();
    for (const kind of ["confirmations", "reminders"]) {
      const value = loaded(); value[kind].status = "unavailable";
      Object.defineProperty(value[kind], "items", { get: () => assert.fail("unavailable items read") });
      const panel = render(h, value); const section = region(panel, kind);
      assert.match(section.textContent, /无法读取/); assert.doesNotMatch(section.textContent, /未列出|待发送|待本人确认/);
      assert.equal(find(panel, "table").length, 1);
    }
  });

  test("missing malformed and inherited sections are unknown rather than empty", async () => {
    const h = await environment();
    for (const kind of ["confirmations", "reminders"]) for (const section of [undefined, null, [], {}, true,
      { status: "success", items: [] }, { status: "constructor", items: [] }, Object.create({ status: "ready", items: [] })]) {
      const panel = render(h, loaded({ [kind]: section }));
      assert.match(region(panel, kind).textContent, /状态未知/);
      assert.doesNotMatch(region(panel, kind).textContent, /未列出|成功/);
    }
  });

  test("nonarray missing and sparse lists fail closed", async () => {
    const h = await environment();
    for (const kind of ["confirmations", "reminders"]) for (const items of [undefined, null, {}, "[]", true, new Array(2)]) {
      const section = region(render(h, withItems(kind, items)), kind);
      assert.match(section.textContent, /状态未知/); assert.equal(find(section, "table").length, 0);
      assert.doesNotMatch(section.textContent, /未列出/);
    }
  });

  test("oversized lists are rejected before any entry is read", async () => {
    const h = await environment(); const items = new Array(129);
    Object.defineProperty(items, "0", { get: () => assert.fail("oversized entry read") });
    for (const kind of ["confirmations", "reminders"]) {
      const section = region(render(h, withItems(kind, items)), kind);
      assert.match(section.textContent, /状态未知/); assert.ok(output(section).length < 2000);
    }
  });

  test("duplicate references make their complete service list unknown", async () => {
    const h = await environment();
    for (const [kind, make] of [["confirmations", confirmation], ["reminders", reminder]]) {
      const section = region(render(h, withItems(kind, [make(), make({ phase: "applied" })])), kind);
      assert.match(section.textContent, /状态未知/); assert.doesNotMatch(section.textContent, /已应用|未列出/);
      assert.equal(find(section, "table").length, 0);
    }
  });

  test("the documented 128 row bound remains renderable without silent truncation", async () => {
    const h = await environment();
    for (const [kind, make, prefix] of [["confirmations", confirmation, "cf_"], ["reminders", reminder, "rem_"]]) {
      const items = Array.from({ length: 128 }, (_, index) => make({ ref: prefix + index.toString(16).padStart(32, "0") }));
      const section = region(render(h, withItems(kind, items)), kind);
      assert.equal(find(section, "tbody")[0].children.length, 128);
      assert.equal(find(section, "code").at(-1).textContent, items.at(-1).ref);
    }
  });

  test("all seven action labels use fixed allowlisted display text", async () => {
    const h = await environment();
    for (const [action, label] of Object.entries(ACTIONS)) {
      const section = region(render(h, withItems("confirmations", [confirmation({ action })])), "confirmations");
      assert.match(section.textContent, new RegExp(label)); assert.ok(!section.textContent.includes(action));
    }
  });

  test("all confirmation phases map explicitly without general success claims", async () => {
    const h = await environment();
    for (const [phase, label] of Object.entries(PHASES)) {
      const panel = render(h, withItems("confirmations", [confirmation({ phase })]));
      assert.match(panel.textContent, new RegExp(label)); assert.ok(!panel.textContent.includes(phase));
      assert.equal(find(panel, "button").length, 1); assert.doesNotMatch(panel.textContent, /成功/);
    }
  });

  test("all reminder phases remain distinct including partial unknown and interrupted", async () => {
    const h = await environment();
    for (const [phase, label] of Object.entries(PHASES)) {
      const panel = render(h, withItems("reminders", [reminder({ phase })]));
      assert.match(panel.textContent, new RegExp(label)); assert.ok(!panel.textContent.includes(phase));
      assert.equal(find(panel, "button").length, 1);
    }
  });

  test("actual confirmation invalidated terminal phase remains readable without hiding its service list", async () => {
    const value = loaded({ confirmations: { status: "ready", items: [confirmation({ phase: "invalidated" })] } });
    const h = await environment(); const panel = render(h, value);
    assert.match(panel.textContent, /已失效/); assert.equal(find(panel, "table").length, 2);
    assert.equal(find(panel, "button").length, 1); assert.doesNotMatch(panel.textContent, /已应用|成功|invalidated/);
    const controller = await controllerEnvironment();
    assert.equal(controller.controller.renderAgentWriteSnapshot(value), true);
    assert.match(controller.panel.textContent, /已失效/); assert.equal(find(controller.panel, "table").length, 2);
  });

  test("unknown prototype-like and injected action or phase codes never become labels", async () => {
    const h = await environment();
    for (const code of [undefined, null, true, 1, {}, [], "constructor", "__proto__", "success", "running", PRIVATE, "<svg onload=alert(1)>"])
      for (const [kind, make, key] of [["confirmations", confirmation, "action"], ["confirmations", confirmation, "phase"], ["reminders", reminder, "phase"]]) {
        const section = region(render(h, withItems(kind, [make({ [key]: code })])), kind);
        assert.match(section.textContent, /状态未知/); assert.doesNotMatch(output(section), /SYNTHETIC|onload|constructor|__proto__|success|running/);
      }
  });

  test("confirmation references are exact opaque lowercase refs without whitespace or coercion", async () => {
    const h = await environment();
    for (const ref of [undefined, null, 42, {}, [], "", CF.toUpperCase(), REM, CF + "\n", CF + "\r", CF + "\u2028", " " + CF,
      CF.slice(0, -1), CF + "a", CF.replace("f", "g"), PRIVATE, "x".repeat(100000)]) {
      const section = region(render(h, withItems("confirmations", [confirmation({ ref })])), "confirmations");
      assert.match(section.textContent, /状态未知/); assert.equal(find(section, "code").length, 0);
      assert.doesNotMatch(output(section), /SYNTHETIC/); assert.ok(output(section).length < 2000);
    }
  });

  test("reminder references reject other domains and malformed opaque IDs", async () => {
    const h = await environment();
    for (const ref of [CF, REM.toUpperCase(), REM + "\n", REM + "\u2029", " " + REM, REM + " ", REM.slice(0, -1),
      REM + "0", "rem_" + "z".repeat(32), PRIVATE, { toString: () => assert.fail("ref coercion") }]) {
      const section = region(render(h, withItems("reminders", [reminder({ ref })])), "reminders");
      assert.match(section.textContent, /状态未知/); assert.equal(find(section, "code").length, 0);
    }
  });

  test("invalid numeric dates never produce invalid date text or terminal success", async () => {
    const h = await environment();
    for (const createdAt of [undefined, null, true, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, "123", "2026-10-01", {}]) {
      const section = region(render(h, withItems("confirmations", [confirmation({ phase: "applied", createdAt })])), "confirmations");
      assert.match(section.textContent, /状态未知/); assert.doesNotMatch(section.textContent, /已应用|Invalid Date|NaN|Infinity/);
    }
  });

  test("missing invalid equal and reversed deadlines do not assert an applied or sent result", async () => {
    const h = await environment();
    for (const [kind, make, key, phase] of [["confirmations", confirmation, "expiresAt", "applied"], ["reminders", reminder, "dueAt", "sent"]])
      for (const value of [undefined, null, NaN, Infinity, -1, START, START - 1, true, "private", 253402272000000]) {
        const section = region(render(h, withItems(kind, [make({ phase, [key]: value })])), kind);
        assert.match(section.textContent, /状态未知/); assert.doesNotMatch(section.textContent, /已应用|已发送|Invalid Date/);
      }
  });

  test("strict ISO deadlines accept timezone-bearing real dates but reject calendar rollover and ambiguity", async () => {
    const h = await environment();
    for (const dueAt of ["2026-10-01T01:00:00.000Z", "2026-10-01T09:00:00+08:00", "2026-09-30T20:00:00-05:00", START + 3600000]) {
      const section = region(render(h, withItems("reminders", [reminder({ dueAt })])), "reminders");
      assert.match(section.textContent, /计划：2026-10-01 09:00:00/);
    }
    for (const dueAt of ["2026-10-01T01:00:00", "2026-02-30T01:00:00Z", "2026-13-01T01:00:00Z",
      "2026-10-00T01:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T01:60:00Z", "2026-10-01T01:00:60Z",
      "2026-10-01T01:00:00+14:01", "2026-10-01T01:00:00+08:60", "2026-10-01T01:00:00.000Z\n", "Thu Oct 01 2026"]) {
      const section = region(render(h, withItems("reminders", [reminder({ dueAt })])), "reminders");
      assert.match(section.textContent, /状态未知/); assert.equal(find(section, "table").length, 0);
    }
  });

  test("Beijing dates roll across UTC days and ignore machine-local timezone", async () => {
    const h = await environment(); const createdAt = Date.parse("2026-09-30T23:59:59Z");
    const panel = render(h, withItems("confirmations", [confirmation({ createdAt, expiresAt: createdAt + 1000 })]));
    assert.match(panel.textContent, /北京时间/); assert.match(panel.textContent, /创建：2026-10-01 07:59:59/);
    assert.match(panel.textContent, /到期：2026-10-01 08:00:00/);
  });

  test("epoch and maximum four-digit Beijing date remain finite and correctly formatted", async () => {
    const h = await environment();
    for (const [createdAt, expiresAt, expected] of [[0, 1000, "1970-01-01 08:00:00"],
      [253402271998999, 253402271999999, "9999-12-31 23:59:58"]]) {
      const panel = render(h, withItems("confirmations", [confirmation({ createdAt, expiresAt })]));
      assert.ok(panel.textContent.includes(expected)); assert.equal(find(panel, "table").length, 1);
    }
  });

  test("all nested private metadata values remain absent from text attributes and datasets", async () => {
    const h = await environment(); const value = loaded();
    for (const target of [value, value.confirmations, value.reminders, ...value.confirmations.items, ...value.reminders.items])
      for (const key of ["params", "parameters", "body", "text", "user", "userId", "group", "groupId", "internalhash", "bindingHash",
        "operationHash", "error", "preview", "raw", "operation", "scope", "path", "apiKey"]) target[key] = { body: PRIVATE };
    const panel = render(h, value);
    assert.equal(find(panel, "table").length, 2); assert.doesNotMatch(output(panel), /SYNTHETIC|918273645|bindingHash|operationHash|apiKey/);
    for (const element of descendants(panel)) assert.deepEqual(element.dataset,
      element.tagName === "BUTTON" ? { action: "refreshAgentWrites" } : {});
  });

  test("private and unknown properties are never read even when they contain throwing getters", async () => {
    const h = await environment(); const value = loaded(); let reads = 0;
    for (const target of [value, value.confirmations, value.reminders, ...value.confirmations.items, ...value.reminders.items])
      for (const key of ["params", "parameters", "body", "user", "group", "internalhash", "error", "preview", "scope", "raw", "toJSON"])
        Object.defineProperty(target, key, { get: () => { reads++; throw new Error(PRIVATE); } });
    const panel = render(h, value);
    assert.equal(reads, 0); assert.equal(find(panel, "table").length, 2); assert.doesNotMatch(output(panel), /SYNTHETIC/);
  });

  test("accessors on required DTO fields and list indices fail closed without invoking getters", async () => {
    const h = await environment(); let reads = 0;
    const getter = { get: () => { reads++; return PRIVATE; }, configurable: true };
    for (const key of ["ref", "action", "phase", "createdAt", "expiresAt"]) {
      const item = confirmation(); Object.defineProperty(item, key, getter);
      assert.match(region(render(h, withItems("confirmations", [item])), "confirmations").textContent, /状态未知/);
    }
    for (const key of ["status", "enabled"]) {
      const value = loaded(); Object.defineProperty(value, key, getter);
      assert.equal(find(render(h, value), "table").length, 0);
    }
    const items = [confirmation()]; Object.defineProperty(items, "0", getter);
    assert.equal(find(render(h, withItems("confirmations", items)), "table").length, 0);
    assert.equal(reads, 0);
  });

  test("HTML injected into allowlisted metadata is rejected while extra HTML is never rendered", async () => {
    const h = await environment(); const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    for (const key of ["ref", "action", "phase", "createdAt", "expiresAt"]) {
      const panel = render(h, withItems("confirmations", [confirmation({ [key]: attack })]));
      assert.match(panel.textContent, /状态未知/); assert.doesNotMatch(output(panel), /onerror|alert|script/);
    }
    const panel = render(h, loaded({ preview: attack, body: attack }));
    assert.equal(find(panel, "img").length, 0); assert.equal(find(panel, "script").length, 0);
    for (const element of descendants(panel)) assert.ok(Object.keys(element.attributes).every(name => !/^on/i.test(name)));
  });

  test("renderer never infers expiry completion or sending from its own clock", async () => {
    const h = await environment(); const panel = render(h, loaded());
    assert.match(panel.textContent, /待本人确认/); assert.match(panel.textContent, /待发送/);
    assert.doesNotMatch(panel.textContent, /已过期|已应用|已发送|成功/);
    const closed = render(h, loaded({ enabled: false }));
    assert.match(closed.textContent, /未开放/); assert.match(closed.textContent, /待本人确认/);
    assert.equal(find(closed, "button").length, 1);
  });

  test("320 390 and 1440 width constraints use unframed fixed wrapping metadata tables", async () => {
    const h = await environment();
    for (const width of [320, 390, 1440]) {
      const container = h.container(); container.style.width = width + "px"; const panel = h.mount(container, loaded());
      assert.equal(panel.className, "agent-tools agent-writes"); assert.equal(panel.style.minWidth, "0");
      assert.equal(panel.style.maxWidth, "100%"); assert.equal(panel.style.overflowWrap, "anywhere");
      assert.equal(find(panel, "section").length, 1); assert.equal(find(panel, "h3").length, 1);
      for (const heading of find(panel, "h4")) assert.equal(heading.style.fontSize, "13px");
      for (const table of find(panel, "table")) {
        assert.equal(table.style.tableLayout, "fixed"); assert.equal(table.style.width, "100%"); assert.equal(table.style.minWidth, "0");
      }
      for (const cell of find(panel, "td")) {
        assert.equal(cell.style.overflowWrap, "anywhere"); assert.equal(cell.style.whiteSpace, "normal");
      }
      for (const ref of find(panel, "code")) assert.equal(ref.style.overflowWrap, "anywhere");
      const refresh = find(panel, "button")[0];
      assert.equal(refresh.type, "button"); assert.equal(refresh.style.width, "36px"); assert.equal(refresh.style.height, "34px");
      assert.equal(refresh.attributes.title, "刷新状态"); assert.equal(refresh.attributes["aria-label"], "刷新状态");
    }
  });

  test("frozen snapshots mount without mutation including null-prototype JSON records", async () => {
    const h = await environment(); const value = loaded(); const before = JSON.stringify(value);
    const freeze = item => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
    freeze(value); assert.equal(find(render(h, value), "table").length, 2); assert.equal(JSON.stringify(value), before);
    const nullRecord = Object.assign(Object.create(null), loaded());
    assert.equal(find(render(h, nullRecord), "table").length, 2);
  });

  test("remount clears stale metadata but preserves parent siblings and dirty controls", async () => {
    const h = await environment(); const parent = h.container(); const container = h.container(); const sibling = node(h.document, "input");
    sibling.value = "dirty parent input"; parent.append(container, sibling);
    const first = h.mount(container, loaded()); const second = h.mount(container, ready({ status: "unavailable" }));
    assert.notEqual(first, second); assert.equal(container.children.length, 1); assert.equal(container.children[0], second);
    assert.equal(parent.children[1], sibling); assert.equal(sibling.value, "dirty parent input");
    assert.equal(find(second, "code").length, 0); assert.doesNotMatch(second.textContent, /待本人确认|待发送/);
    assert.equal(find(second, "button")[0].dataset.action, "refreshAgentWrites");
  });

  test("non-DOM mount targets throw a fixed programming error", async () => {
    const h = await environment();
    for (const container of [undefined, null, {}, { ownerDocument: {}, replaceChildren() {} }, { ownerDocument: h.document }])
      assert.throws(() => h.mount(container, loaded()), /DOM container required/);
  });

  test("revoked and throwing proxies fail closed without exposing exception text", async () => {
    const h = await environment(); const { proxy, revoke } = Proxy.revocable(loaded(), {}); revoke();
    for (const value of [proxy, new Proxy(loaded(), { getPrototypeOf() { throw new Error(PRIVATE); } }),
      loaded({ reminders: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(PRIVATE); } }) })]) {
      const panel = render(h, value); assert.match(panel.textContent, /状态未知/);
      assert.equal(find(panel, "table").length, 0); assert.doesNotMatch(output(panel), /SYNTHETIC/);
    }
  });

  test("one malformed row cannot leave a misleading successful partial list", async () => {
    const h = await environment();
    for (const bad of [null, [], true, {}, Object.create(confirmation()), confirmation({ phase: "success" })]) {
      const panel = render(h, withItems("confirmations", [confirmation({ phase: "applied" }), bad]));
      assert.match(region(panel, "confirmations").textContent, /状态未知/);
      assert.doesNotMatch(panel.textContent, /已应用|成功/); assert.equal(find(panel, "table").length, 0);
    }
  });

  test("controller recognizes only refresh and calls the exact parent metadata read", async () => {
    const h = await controllerEnvironment();
    for (const action of ["confirmAgentWrite", "executeAgentWrite", "revokeAgentWrite", "cancelAgentWrite", "refreshAgentDrafts", undefined]) {
      assert.equal(h.controller.isAgentWriteAction(action), false);
      await h.controller.runAgentWriteAction(action); assert.equal(h.calls.length, 0);
    }
    assert.equal(h.controller.isAgentWriteAction("refreshAgentWrites"), true);
    await h.controller.runAgentWriteAction("refreshAgentWrites", {}, { silent: true });
    assert.deepEqual(h.calls, [{ action: "getAgentActions", payload: {} }]);
    assert.equal(h.events[0].button, null); assert.equal(h.status.dataset.state, "ready");
    assert.equal(find(h.panel, "button").length, 1); assert.equal(find(h.panel, "button")[0].disabled, false);
  });

  test("native controller displays unsupported read notice without a host call or controls", async () => {
    const h = await controllerEnvironment("desktop");
    assert.equal(h.controller.renderAgentWriteSnapshot(loaded()), false);
    await h.controller.runAgentWriteAction("refreshAgentWrites"); h.controller.invalidateAgentWriteView();
    assert.match(h.panel.textContent, /Windows.*不支持读取/); assert.equal(find(h.panel, "button").length, 0);
    assert.deepEqual(h.calls, []); assert.deepEqual(h.events, []); assert.equal(h.status.dataset.state, "unavailable");
  });

  test("controller rejects incomplete malformed duplicate sparse and nonmillisecond DTOs", async () => {
    const h = await controllerEnvironment();
    for (const value of [null, {}, loaded({ enabled: 1 }), loaded({ status: "success" }), loaded({ reminders: undefined }),
      loaded({ confirmations: { status: "ready", items: [confirmation(), confirmation()] } }),
      loaded({ confirmations: { status: "ready", items: new Array(2) } }),
      loaded({ confirmations: { status: "ready", items: [confirmation({ phase: "constructor" })] } }),
      loaded({ reminders: { status: "ready", items: [reminder({ dueAt: "2026-10-01T01:00:00.000Z" })] } })]) {
      h.controller.renderAgentWriteSnapshot(loaded());
      assert.equal(h.controller.renderAgentWriteSnapshot(value), false); assert.equal(find(h.panel, "code").length, 0);
      assert.equal(h.status.dataset.state, "error"); assert.doesNotMatch(h.panel.textContent, /已应用|已发送|成功/);
    }
  });

  test("controller projects only metadata and never invokes getters on private fields", async () => {
    const h = await controllerEnvironment(); const value = loaded(); let reads = 0;
    for (const target of [value, value.confirmations, value.reminders, ...value.confirmations.items, ...value.reminders.items])
      for (const key of ["body", "parameters", "preview", "userId", "groupId", "internalhash", "error", "raw", "toJSON"])
        Object.defineProperty(target, key, { get() { reads++; throw new Error(PRIVATE); } });
    assert.equal(h.controller.renderAgentWriteSnapshot(value), true); assert.equal(reads, 0);
    assert.equal(find(h.panel, "table").length, 2); assert.doesNotMatch(output(h.panel), /SYNTHETIC|918273645/);
  });

  test("controller pending feedback and icon dimensions persist until the actual GET settles", async () => {
    const h = await controllerEnvironment(); const pending = deferred(); h.setReply(() => pending.promise);
    h.controller.renderAgentWriteSnapshot(loaded()); const button = find(h.panel, "button")[0]; const icon = button.textContent;
    const run = h.controller.runAgentWriteAction("refreshAgentWrites", button);
    assert.equal(h.status.dataset.state, "loading"); assert.match(h.status.textContent, /正在读取.*尚未确认/);
    assert.equal(button.disabled, true); assert.equal(button.textContent, icon); assert.equal(button.style.width, "36px");
    assert.equal(h.events.some(event => event.type === "finish"), false); assert.equal(h.panel.attributes["aria-busy"], "true");
    pending.resolve(loaded()); await run;
    assert.equal(h.status.dataset.state, "ready"); assert.equal(find(h.panel, "button")[0].disabled, false);
    assert.equal(h.panel.attributes["aria-busy"], "false"); assert.equal(h.events.filter(event => event.type === "finish").length, 1);
  });

  test("controller has a single in-flight metadata read without polling or duplicate calls", async () => {
    const h = await controllerEnvironment(); const pending = deferred(); h.setReply(() => pending.promise);
    const first = h.controller.runAgentWriteAction("refreshAgentWrites");
    await h.controller.runAgentWriteAction("refreshAgentWrites"); assert.equal(h.calls.length, 1);
    pending.resolve(ready()); await first; assert.equal(h.calls.length, 1);
    assert.match(h.status.textContent, /未开放/);
  });

  test("invalidated pending reads cannot restore stale records or claim a finished refresh", async () => {
    const h = await controllerEnvironment(); const pending = deferred(); h.setReply(() => pending.promise);
    h.controller.renderAgentWriteSnapshot(loaded()); const run = h.controller.runAgentWriteAction("refreshAgentWrites");
    h.controller.invalidateAgentWriteView(); const notice = h.status.textContent;
    pending.resolve(loaded()); await run;
    assert.equal(find(h.panel, "code").length, 0); assert.equal(h.status.textContent, notice);
    assert.equal(h.events.some(event => event.type === "finish" || event.type === "toast"), false);
  });

  test("late rejected reads cannot overwrite newer capabilities metadata or its feedback", async () => {
    const h = await controllerEnvironment(); const pending = deferred(); h.setReply(() => pending.promise);
    const run = h.controller.runAgentWriteAction("refreshAgentWrites");
    const current = loaded({ enabled: false }); h.controller.renderAgentWriteSnapshot(current); const notice = h.status.textContent;
    pending.reject(Object.assign(new Error(PRIVATE), { status: 403 })); await run;
    assert.match(h.panel.textContent, /待本人确认/); assert.equal(h.status.textContent, notice);
    assert.equal(h.events.some(event => event.type === "finish" || event.type === "toast"), false);
    assert.equal(find(h.panel, "button")[0].disabled, false);
  });

  test("controller transport authorization and invalid-response failures use fixed safe errors", async () => {
    const h = await controllerEnvironment();
    for (const status of [401, 403, 404, 500, undefined]) {
      h.controller.renderAgentWriteSnapshot(loaded()); h.setReply(() => Promise.reject(Object.assign(new Error(PRIVATE), { status })));
      await h.controller.runAgentWriteAction("refreshAgentWrites");
      assert.equal(h.status.dataset.state, "error"); assert.equal(find(h.panel, "code").length, 0);
      assert.doesNotMatch(JSON.stringify(h.events) + output(h.panel) + h.status.textContent, /SYNTHETIC|918273645/);
      assert.match(h.status.textContent, [401, 403].includes(status) ? /无权读取/ : status === 404 ? /接口未开放/ : /读取失败/);
    }
    h.setReply({ error: PRIVATE }); await h.controller.runAgentWriteAction("refreshAgentWrites");
    assert.equal(h.status.dataset.state, "error"); assert.equal(find(h.panel, "code").length, 0);
  });

  test("unavailable metadata clears stale rows and does not receive ready or success feedback", async () => {
    const h = await controllerEnvironment(); const value = loaded({ status: "unavailable" });
    Object.defineProperty(value, "confirmations", { get: () => assert.fail("stale confirmations read") });
    h.setReply(value); await h.controller.runAgentWriteAction("refreshAgentWrites");
    assert.equal(find(h.panel, "code").length, 0); assert.equal(h.status.dataset.state, "unavailable");
    assert.equal(h.events.find(event => event.type === "finish").tone, "error");
    assert.doesNotMatch(h.panel.textContent, /未列出|已发送|已应用/);
  });

  test("host metadata read is exact GET only and native mode never posts to the desktop bridge", async () => {
    const calls = []; const nativeCalls = []; let timers = 0;
    const window = { sessionStorage: { getItem: () => "" }, AbortController: globalThis.AbortController,
      setTimeout: () => { timers++; return 1; }, clearTimeout() {},
      fetch: async (url, settings) => { calls.push({ url, method: settings.method, body: settings.body });
        return { ok: true, status: 200, text: async () => JSON.stringify(loaded()) }; } };
    vm.runInNewContext(fs.readFileSync(HOST, "utf8"), { window });
    await window.QQFriendHost.call("getAgentActions", { userId: PRIVATE, id: CF, action: "execute" });
    assert.deepEqual(calls, [{ url: "/admin/agent-actions", method: "GET", body: undefined }]);
    const desktop = { ...window, chrome: { webview: { postMessage: value => nativeCalls.push(value), addEventListener() {} } } };
    vm.runInNewContext(fs.readFileSync(HOST, "utf8"), { window: desktop });
    const before = timers;
    await assert.rejects(desktop.QQFriendHost.call("getAgentActions"), /Windows.*不支持读取/);
    assert.deepEqual(nativeCalls, []); assert.equal(timers, before); assert.equal(calls.length, 1);
  });
}
