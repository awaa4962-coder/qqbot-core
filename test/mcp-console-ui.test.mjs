import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";

const ROOT = fileURLToPath(new globalThis.URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
const HASH = "a".repeat(64);
const copy = value => JSON.parse(JSON.stringify(value));
function domNode(document, tag = "div") {
  let text = "";
  const classes = new Set();
  const node = { ownerDocument: document, tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {}, attributes: {},
    listeners: {}, value: "", checked: false, disabled: false, hidden: false, style: {},
    classList: { add(...values) { values.forEach(value => classes.add(value)); }, remove(...values) { values.forEach(value => classes.delete(value)); },
      toggle(value, force) { if (force === false) classes.delete(value); else classes.add(value); }, contains(value) { return classes.has(value); } },
    get textContent() { return text + this.children.map(child => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    set innerHTML(_value) { assert.fail("MCP must use textContent, not HTML parsing"); },
    append(...children) { children.forEach(child => { child.parentNode = this; this.children.push(child); }); },
    replaceChildren(...children) { text = ""; this.children = []; this.append(...children); },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    querySelectorAll(selector) { return walk(this).slice(1).filter(child => selector === "*" || child.tagName.toLowerCase() === selector); },
    closest(selector) { for (let current = this; current; current = current.parentNode) {
      if (selector === "[data-mcp-local]" && current.dataset.mcpLocal) return current;
    } return null; },
  };
  return node;
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
async function environment(mode = "browser") {
  let document;
  const nodes = new Map();
  const calls = [];
  const get = id => {
    for (const root of nodes.values()) { const found = walk(root).find(node => node.id === id); if (found) return found; }
    if (!nodes.has(id)) { const node = domNode(document); node.id = id; nodes.set(id, node); }
    return nodes.get(id);
  };
  document = { getElementById: get, createElement: tag => domNode(document, tag), body: domNode(null, "body") };
  const forbidden = () => assert.fail("No direct network, storage, polling, model or QQ calls");
  const host = { mode, response: sample(), async call(action, payload) {
    assert.ok(["getMcpServices", "applyMcpAction"].includes(action)); calls.push({ action, payload: copy(payload) });
    if (host.handle) return host.handle(action, payload);
    return action === "getMcpServices" ? copy(host.response) : { ok: true, ...copy(host.response) };
  } };
  const window = { QQFriendHost: host, confirm: () => true, setTimeout: () => 1, clearTimeout() {}, addEventListener: forbidden };
  Object.defineProperty(window, "localStorage", { get: forbidden }); Object.defineProperty(window, "sessionStorage", { get: forbidden });
  const context = vm.createContext({ document, window, URL: globalThis.URL, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    setInterval: forbidden, setTimeout: forbidden, console });
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { identifier: file, context }));
    return modules.get(file);
  }
  const actionModule = load(path.join(ROOT, "ui/mcp-actions.js"));
  await actionModule.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
  await actionModule.evaluate();
  const page = modules.get(path.join(ROOT, "pages/mcp.js")).namespace;
  const actions = actionModule.namespace;
  const panel = get("mcpToolsPanel");
  function button(action, name) { return walk(panel).find(node => node.tagName === "BUTTON" && node.dataset.action === action && (!name || node.dataset.toolName === name)); }
  function local(name, id) { const target = walk(panel).find(node => node.dataset.mcpLocal === name && (!id || node.dataset.serverId === id));
    assert.ok(target); for (const listener of panel.listeners.click || []) listener({ target }); }
  function input(id, value) { const node = get("mcp-" + id); if (node.type === "checkbox") node.checked = value; else node.value = value;
    for (const listener of node.listeners.input || []) listener({ target: node }); }
  function permission(name, enabled) {
    const node = walk(panel).find(child => child.attributes["aria-label"] === "允许 " + name);
    assert.ok(node); node.checked = enabled; for (const listener of node.listeners.change || []) listener({ target: node });
  }
  return { host, page, actions, panel, get, button, local, input, permission, calls, window };
}
function sample({ revision = "r1", tools = ["lookup"], groupOnly = false, empty = false } = {}) {
  const configured = tools.map(name => ({ name, label: "Public " + name, enabled: false, mode: "read", scope: groupOnly ? "current" : "public",
    inputPolicy: groupOnly ? "current-scope" : "public-query", bindings: groupOnly ? { group_id: "groupId" } : {}, schemaHash: HASH }));
  const server = { id: "catalog", label: "Catalog", url: "http://mcp-service:3000/mcp", enabled: true, tools: configured };
  const projection = { id: "catalog", label: "Catalog", enabled: true, hasToken: true, status: "connected", reason: "", toolCount: 0,
    tools: tools.map(name => ({ name, enabled: false, available: false, discovered: true, mode: "read", schemaHash: HASH,
      reason: "disabled", scopeFields: groupOnly ? ["group_id"] : [], supportedScopes: groupOnly ? ["current"] : ["public"] })) };
  return { revision, status: "ready", configuration: { servers: empty ? [] : [server] }, servers: empty ? [] : [projection] };
}
if (!vm.SourceTextModule) {
  test("MCP console DOM cases run in isolated VM modules", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 18 })));
  });
} else {
  test("MCP page/action exports are explicit and rendering never performs IO", async () => {
    const h = await environment();
    for (const name of ["renderMcp", "invalidateMcpView", "canDiscardMcpDrafts", "mcpHasDrafts"]) assert.equal(typeof h.page[name], "function");
    for (const action of ["refreshMcp", "saveMcpServer", "connectMcpServer", "refreshMcpTools", "disconnectMcpServer", "approveMcpTool"]) assert.equal(h.actions.isMcpAction(action), true);
    assert.equal(h.actions.isMcpAction("sendQQ"), false);
    h.page.renderMcp(sample({ empty: true })); assert.match(h.panel.textContent, /暂无|尚未/); assert.equal(h.calls.length, 0);
  });
  test("MCP service table, tools and credential state render without trusting remote HTML or keys", async () => {
    const h = await environment(); const snapshot = sample();
    snapshot.servers[0].label = "<img onerror=evil()>"; snapshot.configuration.servers[0].token = "never-echo-GET-key";
    snapshot.rawError = "never-echo-private-error";
    assert.equal(h.page.renderMcp(snapshot), true);
    assert.equal(h.get("mcp-token").type, "password"); assert.equal(h.get("mcp-token").value, "");
    assert.doesNotMatch(h.panel.textContent, /never-echo/); assert.match(h.panel.textContent, /<img onerror/);
    assert.match(h.panel.textContent, /不等于.*安全审计/); assert.equal(h.calls.length, 0);
  });
  test("MCP read-only refresh preserves dirty form fields and exposes revision conflict", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Unsaved label");
    h.host.response = sample({ revision: "r2" });
    assert.equal(await h.actions.runMcpAction("refreshMcp", h.button("refreshMcp")), true);
    assert.equal(h.get("mcp-label").value, "Unsaved label"); assert.equal(h.page.mcpHasDrafts(), true);
    assert.equal(h.panel.dataset.state, "conflict"); assert.equal(h.button("saveMcpServer").disabled, true);
    assert.equal(h.calls[0].action, "getMcpServices");
    h.window.confirm = () => false; h.local("reload"); assert.equal(h.get("mcp-label").value, "Unsaved label");
    h.window.confirm = () => true; h.local("reload"); assert.equal(h.page.mcpHasDrafts(), false); assert.equal(h.get("mcp-label").value, "Catalog");
  });
  test("MCP successful service save sends CAS and only explicitly entered token; GET never prefills it", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Weather capability"); h.input("token", "typed-synthetic-key");
    h.host.handle = async (_action, payload) => ({ ok: true, ...sample({ revision: "r2" }), configuration: payload.configuration });
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), true);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.expectedRevision, "r1");
    assert.deepEqual(h.calls[0].payload.tokens, { catalog: "typed-synthetic-key" });
    assert.equal(h.get("mcp-token").value, ""); assert.equal(h.page.mcpHasDrafts(), false);
  });
  test("MCP save with unchanged credential omits tokens; explicit removal sends null", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Changed");
    assert.equal(Object.hasOwn(h.page.mcpServerPayload(), "tokens"), false);
    h.input("clearToken", true); assert.deepEqual(copy(h.page.mcpServerPayload().tokens), { catalog: null });
  });
  test("MCP new server form uses structured payload and selects the newly saved service", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.local("new");
    h.input("id", "localdocs"); h.input("label", "Documentation"); h.input("url", "http://docs-service:3000/mcp"); h.input("enabled", true);
    h.host.handle = async (_action, payload) => ({ ok: true, revision: "r2", status: "ready", configuration: payload.configuration,
      servers: [...sample().servers, { id: "localdocs", label: "Documentation", enabled: true, status: "disconnected", toolCount: 0, tools: [] }] });
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), true);
    assert.equal(h.calls[0].payload.configuration.servers[1].id, "localdocs"); assert.equal(h.get("mcp-id").value, "localdocs");
  });
  test("MCP actual ok:false is an error, retains edits and does not retry", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Pending");
    h.host.handle = async () => ({ ok: false, reason: "connection_failed", rawError: "private raw key" });
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.calls.length, 1); assert.equal(h.page.mcpHasDrafts(), true);
    assert.equal(h.get("toast").classList.contains("error"), true); assert.doesNotMatch(h.panel.textContent, /private raw key/);
  });
  test("MCP a complete ok:true stale configuration cannot acknowledge a changed service", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Actually submitted label");
    h.host.handle = async () => ({ ok: true, ...sample({ revision: "r2" }) });
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.get("mcp-label").value, "Actually submitted label"); assert.equal(h.page.mcpHasDrafts(), true);
    assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.get("toast").classList.contains("error"), true);
  });
  test("MCP exact tool/schema acknowledgement is required before clearing a permission draft", async () => {
    for (const stale of ["enabled", "schemaHash", "bindings", "scope", "inputPolicy", "label", "mode", "name", "missingTool"]) {
      const h = await environment(); h.page.renderMcp(sample({ tools: ["get_group_info"], groupOnly: true })); h.permission("get_group_info", true);
      h.host.handle = async (_action, payload) => {
        const configuration = copy(payload.configuration); const tool = configuration.servers[0].tools[0];
        if (stale === "enabled") tool.enabled = false;
        if (stale === "schemaHash") tool.schemaHash = "b".repeat(64);
        if (stale === "bindings") tool.bindings = { user_id: "userId" };
        if (stale === "scope") { tool.scope = "public"; tool.bindings = {}; tool.inputPolicy = "public-query"; }
        if (stale === "inputPolicy") tool.inputPolicy = "public-query";
        if (stale === "label") tool.label = "Stale capability";
        if (stale === "mode") tool.mode = "write";
        if (stale === "name") tool.name = "another_tool";
        if (stale === "missingTool") configuration.servers[0].tools = [];
        return { ok: true, ...sample({ revision: "r2", tools: ["get_group_info"], groupOnly: true }), configuration };
      };
      assert.equal(await h.actions.runMcpAction("approveMcpTool", h.button("approveMcpTool", "get_group_info")), false);
      assert.equal(h.page.mcpHasDrafts(), true); assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.calls.length, 1);
      assert.equal(h.get("toast").classList.contains("error"), true);
      assert.equal(h.get("activityBar").classList.contains("success"), false);
      assert.equal(h.button("approveMcpTool", "get_group_info").disabled, true);
    }
  });
  test("MCP matching configuration still needs an advanced revision and matching credential presence", async () => {
    for (const scenario of ["unchangedRevision", "tokenNotInstalled", "tokenNotRemoved"]) {
      const h = await environment(); h.page.renderMcp(sample());
      if (scenario === "unchangedRevision") h.input("label", "Submitted change");
      else if (scenario === "tokenNotInstalled") h.input("token", "synthetic-new-token");
      else h.input("clearToken", true);
      h.host.handle = async (_action, payload) => {
        const result = sample({ revision: scenario === "unchangedRevision" ? "r1" : "r2" });
        result.configuration = copy(payload.configuration);
        result.servers[0].hasToken = scenario !== "tokenNotInstalled";
        return { ok: true, snapshot: result };
      };
      assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
      assert.equal(h.page.mcpHasDrafts(), true); assert.equal(h.panel.dataset.state, "unknown");
      assert.equal(h.button("saveMcpServer").disabled, true); assert.equal(h.calls.length, 1);
      assert.equal(h.get("toast").classList.contains("error"), true);
    }
  });
  test("MCP wrapped matching acknowledgement allows normalized URL/tool ordering and credential removal", async () => {
    const h = await environment(); h.page.renderMcp(sample({ tools: ["lookup", "status"] }));
    h.input("label", "Submitted change"); h.input("clearToken", true);
    h.host.handle = async (_action, payload) => {
      const result = sample({ revision: "r2", tools: ["lookup", "status"] });
      result.configuration = copy(payload.configuration);
      result.configuration.servers[0].tools.reverse();
      result.configuration.servers[0].url = "http://MCP-SERVICE:3000/mcp";
      result.servers[0].hasToken = false;
      return { ok: true, snapshot: result };
    };
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), true);
    assert.deepEqual(h.calls[0].payload.tokens, { catalog: null });
    assert.equal(h.page.mcpHasDrafts(), false); assert.equal(h.panel.dataset.state, "ready");
    assert.equal(h.get("mcp-clearToken").checked, false); assert.equal(h.get("mcp-token").value, "");
  });
  test("MCP invalidation during a pending POST keeps unknown locked through late timeout and GET", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Keep pending draft"); let reject;
    h.host.handle = () => new Promise((_resolve, fail) => { reject = fail; });
    const pending = h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer"));
    h.page.invalidateMcpView();
    assert.equal(h.page.canDiscardMcpDrafts(), false);
    h.local("reload"); assert.equal(h.get("mcp-label").value, "Keep pending draft");
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.calls.length, 1);
    reject(new Error("late synthetic timeout"));
    assert.equal(await pending, false); assert.equal(h.panel.dataset.state, "unknown");
    h.host.handle = undefined; await h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.get("mcp-label").value, "Keep pending draft");
    assert.equal(h.button("saveMcpServer").disabled, true);
    assert.throws(() => h.page.mcpServerPayload(), /mcp_view_locked/);
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.calls.filter(call => call.action === "applyMcpAction").length, 1);
    h.window.confirm = () => false; h.local("reload"); assert.equal(h.panel.dataset.state, "unknown");
    assert.equal(h.page.mcpHasDrafts(), true);
    h.window.confirm = () => true; h.local("reload"); assert.equal(h.panel.dataset.state, "ready"); assert.equal(h.page.mcpHasDrafts(), false);
  });
  test("MCP a late known failure after invalidation cannot reopen writing", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Pending"); let resolve;
    h.host.handle = () => new Promise(done => { resolve = done; });
    const pending = h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")); h.page.invalidateMcpView();
    resolve({ ok: false, reason: "invalid_configuration" }); assert.equal(await pending, false);
    h.host.handle = undefined; await h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.button("saveMcpServer").disabled, true);
  });
  test("MCP explicit and HTTP revision conflicts lock writing without dropping drafts", async () => {
    for (const httpConflict of [false, true]) {
      const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Conflict draft");
      h.host.handle = async () => { if (httpConflict) throw { status: 409, message: "raw conflict" };
        return { ok: false, reason: "revision_conflict", snapshot: sample({ revision: "r2" }) }; };
      assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
      assert.equal(h.panel.dataset.state, "conflict"); assert.equal(h.page.mcpHasDrafts(), true);
      assert.equal(h.button("saveMcpServer").disabled, true); assert.equal(h.calls.length, 1);
    }
  });
  test("MCP ambiguous write failure stays unknown after readonly refresh and never replays a key", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("token", "typed-private-token");
    h.host.handle = async () => { throw new Error("raw typed-private-token https://private.test"); };
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.get("mcp-token").value, "typed-private-token");
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false); assert.equal(h.calls.length, 1);
    h.host.handle = undefined; await h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    assert.equal(h.panel.dataset.state, "unknown"); assert.equal(h.button("saveMcpServer").disabled, true);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].action, "getMcpServices");
    assert.doesNotMatch(h.panel.textContent, /typed-private-token|private\.test/);
    h.local("reload"); assert.equal(h.get("mcp-token").value, ""); assert.equal(h.panel.dataset.state, "ready");
  });
  test("MCP auth failure clears credential input and live directory but preserves other dirty fields", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "My draft"); h.input("token", "private-key");
    h.host.handle = async () => { throw { status: 401, message: "raw private-key" }; };
    await h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    assert.equal(h.panel.dataset.state, "authfailed"); assert.equal(h.get("mcp-token").value, "");
    assert.equal(h.get("mcp-label").value, "My draft"); assert.equal(h.page.mcpHasDrafts(), true);
    assert.doesNotMatch(h.panel.textContent, /raw private-key|已连接/);
  });
  test("MCP a stale response after invalidation cannot repopulate old service state", async () => {
    const h = await environment(); h.page.renderMcp(sample()); let resolve;
    h.host.handle = () => new Promise(done => { resolve = done; });
    const pending = h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    h.page.invalidateMcpView(); resolve(sample()); assert.equal(await pending, false);
    assert.equal(h.panel.dataset.state, "unknown"); assert.doesNotMatch(h.panel.textContent, /已连接/);
  });
  test("MCP an older asynchronous read cannot roll back a newer integrated configuration view", async () => {
    const h = await environment(); h.page.renderMcp(sample()); let resolve;
    h.host.handle = () => new Promise(done => { resolve = done; });
    const pending = h.actions.runMcpAction("refreshMcp", h.button("refreshMcp"));
    h.page.renderMcp(sample({ revision: "r2" })); resolve(sample({ revision: "r1" }));
    assert.equal(await pending, false); assert.equal(h.page.mcpServerPayload().expectedRevision, "r2");
  });
  test("MCP unknown/malformed snapshots and success responses remain locked and retain drafts", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.input("label", "Keep me");
    h.host.handle = async () => ({ ok: true, privateError: "do not display" });
    assert.equal(await h.actions.runMcpAction("saveMcpServer", h.button("saveMcpServer")), false);
    assert.equal(h.get("mcp-label").value, "Keep me"); assert.equal(h.panel.dataset.state, "unknown");
    assert.equal(h.page.renderMcp({ status: "ready" }), false); assert.equal(h.page.mcpHasDrafts(), true);
    assert.doesNotMatch(h.panel.textContent, /do not display/);
  });
  test("MCP group-only permission derives approved bindings and hash from actual discovery", async () => {
    const h = await environment(); h.page.renderMcp(sample({ tools: ["get_group_info"], groupOnly: true }));
    h.permission("get_group_info", true);
    h.host.handle = async (_action, payload) => ({ ok: true, ...sample({ revision: "r2", tools: ["get_group_info"], groupOnly: true }), configuration: payload.configuration });
    assert.equal(await h.actions.runMcpAction("approveMcpTool", h.button("approveMcpTool", "get_group_info")), true);
    const tool = h.calls[0].payload.configuration.servers[0].tools[0];
    assert.equal(tool.enabled, true); assert.equal(tool.scope, "current"); assert.equal(tool.schemaHash, HASH);
    assert.deepEqual(tool.bindings, { group_id: "groupId" }); assert.equal(Object.hasOwn(tool.bindings, "message_id"), false);
  });
  test("MCP schema drift does not turn an old checkbox draft into approval of new schema", async () => {
    const h = await environment(); h.page.renderMcp(sample()); h.permission("lookup", true);
    const changed = sample(); changed.servers[0].tools[0].schemaHash = "b".repeat(64); h.page.renderMcp(changed);
    assert.equal(await h.actions.runMcpAction("approveMcpTool", h.button("approveMcpTool", "lookup")), false);
    assert.equal(h.calls.length, 0); assert.equal(h.page.mcpHasDrafts(), true); assert.match(h.get("toast").textContent, /定义已变化/);
  });
  test("MCP saving one tool does not discard another tool's unsaved permission", async () => {
    const h = await environment(); h.page.renderMcp(sample({ tools: ["lookup", "status"] }));
    h.permission("lookup", true); h.permission("status", true); let count = 1;
    h.host.handle = async (_action, payload) => ({ ok: true, ...sample({ revision: "r" + (++count), tools: ["lookup", "status"] }), configuration: payload.configuration });
    assert.equal(await h.actions.runMcpAction("approveMcpTool", h.button("approveMcpTool", "lookup")), true);
    assert.equal(h.page.mcpHasDrafts(), true);
    assert.equal(await h.actions.runMcpAction("approveMcpTool", h.button("approveMcpTool", "status")), true);
    assert.equal(h.calls[1].payload.expectedRevision, "r2");
    assert.ok(h.calls[1].payload.configuration.servers[0].tools.every(tool => tool.enabled)); assert.equal(h.page.mcpHasDrafts(), false);
  });
  test("MCP connect/discover/disconnect only use bounded management actions with CAS", async () => {
    const h = await environment(); h.page.renderMcp(sample());
    for (const [action, expected] of [["connectMcpServer", "connect"], ["refreshMcpTools", "refresh"], ["disconnectMcpServer", "disconnect"]]) {
      assert.equal(await h.actions.runMcpAction(action, h.button(action)), true);
      assert.equal(h.calls.at(-1).payload.action, expected); assert.equal(h.calls.at(-1).payload.expectedRevision, "r1");
    }
    assert.ok(h.calls.every(call => call.action === "applyMcpAction"));
  });
  test("MCP single management action group prevents concurrent replay and preserves button labels", async () => {
    const h = await environment(); h.page.renderMcp(sample()); let resolve;
    h.host.handle = () => new Promise(done => { resolve = done; }); const button = h.button("refreshMcp"); const label = button.textContent;
    const pending = h.actions.runMcpAction("refreshMcp", button); assert.equal(button.textContent, label);
    assert.equal(await h.actions.runMcpAction("refreshMcp", button), false); assert.equal(h.calls.length, 1);
    resolve(sample()); assert.equal(await pending, true); assert.equal(button.textContent, label);
  });
  test("MCP desktop has no management calls and stylesheet keeps tools unframed/responsive", async () => {
    const h = await environment("desktop"); assert.equal(h.page.renderMcp(sample()), false);
    assert.equal(await h.actions.runMcpAction("refreshMcp", null), false); assert.equal(h.calls.length, 0);
    const css = fs.readFileSync(path.join(ROOT, "mcp.css"), "utf8");
    assert.match(css, /minmax\(0, 1fr\)/); assert.match(css, /@media \(max-width: 760px\)/);
    assert.match(css, /overflow-wrap: anywhere/); assert.doesNotMatch(css, /vw|hero|gradient|letter-spacing:\s*-/);
  });
}
