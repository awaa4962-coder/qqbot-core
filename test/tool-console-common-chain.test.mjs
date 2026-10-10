import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { consoleHarness, deferred, flush } from "./p5-ui-harness.mjs";
import { runVmTestFile } from "./vm-test-runner.mjs";

const parent = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "qqfriend-console-common-"));
for (const part of ["config", "data", "logs", "temp"]) fs.mkdirSync(path.join(root, part));
Object.assign(process.env, { NODE_ENV: "test", CI: "1", QQBOT_CONFIG_ROOT: path.join(root, "config"),
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  LOCALAPPDATA: root, TEMP: path.join(root, "temp"), TMP: path.join(root, "temp") });
after(() => {
  assert.equal(path.dirname(root), parent);
  fs.rmSync(root, { recursive: true, force: true });
});
const token = "synthetic-common-token";
const walk = node => [node, ...node.children.flatMap(walk)];
const response = (status, value) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });

async function fixture(t) {
  const { CFG } = await import("../bridge/config.mjs");
  const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");
  const { initializeMcpServices, closeMcpServices } = await import("../bridge/mcp/index.mjs");
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const previous = CFG.toolSettingsFile;
  CFG.toolSettingsFile = path.join(directory, "tool-settings.json");
  let failing = false, attempts = 0;
  await initializeMcpServices({ cfg: { configRoot: directory, mcpConfigFile: path.join(directory, "mcp-services.json") }, connect: false,
    createClient: async () => ({ async connect() { attempts++; if (failing) throw new Error("synthetic-connection-failure"); },
      async listTools() { return { tools: [] }; }, async abort() {} }) });
  t.after(async () => { await closeMcpServices(); CFG.toolSettingsFile = previous; });
  async function request(route, body) {
    assert.ok(["/admin/mcp", "/admin/capabilities", "/admin/agent-tools/settings"].includes(route));
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { method: body === undefined ? "GET" : "POST", url: route,
      socket: { remoteAddress: "127.0.0.1" }, headers: { "x-qqfriend-admin-token": token } });
    let result;
    await handleAdminApiRequest(req, {}, { pathname: route, requiredToken: token,
      sendJson(_res, status, value) { result = { status, value }; } });
    return result;
  }
  const initial = await request("/admin/mcp");
  const saved = await request("/admin/mcp", { action: "save", expectedRevision: initial.value.revision,
    configuration: { servers: [{ id: "review", label: "Review service", url: "http://synthetic-service:3000/mcp", enabled: true, tools: [] }] } });
  const connected = await request("/admin/mcp", { action: "connect", expectedRevision: saved.value.revision, serverId: "review" });
  assert.equal(connected.status, 200);

  const h = consoleHarness();
  const panels = [h.get("mcpToolsPanel"), h.get("toolSettingsPanel")];
  const node = id => panels.flatMap(walk).find(item => item.id === id) || h.get(id);
  h.document.getElementById = node;
  const posts = [], reads = [];
  let override;
  h.session.set("qqfriend-admin-token", token);
  h.window.fetch = async (route, options) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    if (body) posts.push({ route, body }); else reads.push(route);
    if (override) {
      const value = await override(route, body);
      if (value) return value;
    }
    const result = await request(route, body);
    return response(result.status, result.value);
  };
  const host = { ...h.runHost() };
  h.window.QQFriendHost = host;
  const [capabilities, mcp, settings, actions, background, mcpActions, settingsActions] = await h.imports([
    "pages/capabilities.js", "pages/mcp.js", "pages/tool-settings.js", "ui/actions.js", "ui/background-feedback.js",
    "ui/mcp-actions.js", "ui/tool-settings-actions.js",
  ]);
  const catalog = await host.call("getCapabilities");
  assert.equal(capabilities.renderCapabilities(catalog), true);
  background.installTaskFeedback();
  const button = action => panels.flatMap(walk).find(item => item.dataset.action === action);
  const edit = async (id, value) => {
    const input = node(id);
    if (typeof value === "boolean") input.checked = value; else input.value = value;
    await input.fire("input");
  };
  const reload = async () => {
    const target = panels.flatMap(walk).find(item => item.dataset.mcpLocal === "reload");
    target.closest = selector => selector === "[data-mcp-local]" ? target : null;
    await panels[0].fire("click", { target });
    const settingsReload = panels[1].children.flatMap(walk).find(item => item.textContent === "重新载入配置");
    await settingsReload.fire("click");
  };
  const backgroundRead = () => h.window.dispatchEvent({ type: "qqfriend:task", detail: { type: "done",
    task: { module: "agent_tools", action: "probe", phase: "done", resultAvailable: true, result: { ok: true } } } });
  return { h, host, node, panels, posts, reads, catalog, capabilities, mcp, settings, actions, mcpActions, settingsActions,
    edit, reload, backgroundRead, button, request, attempts: () => attempts, failConnect: () => { failing = true; },
    override: value => { override = value; } };
}

if (!vm.SourceTextModule) {
  test("tool console common chains execute in isolated VM modules", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 9, timeout: 45000 })));
  });
} else {
  for (const status of [401, 403]) test("shared " + status + " rejects a late background GET and requires fresh authenticated reads", async t => {
    const f = await fixture(t);
    await f.edit("mcp-label", "Keep MCP draft"); await f.edit("mcp-token", "synthetic-private-input");
    await f.edit("toolAutonomyEnabled", false);
    const delayed = deferred(); let count = 0;
    f.override(route => route === "/admin/capabilities" ? ++count === 1 ? delayed.promise : response(status, { error: "forbidden" }) : undefined);
    f.backgroundRead(); await flush();
    await f.actions.runAction("refreshCapabilities");
    assert.equal(f.node("mcp-token").value, ""); assert.equal(f.node("mcp-label").value, "Keep MCP draft");
    assert.equal(f.node("toolAutonomyEnabled").checked, false);
    delayed.resolve(response(200, f.catalog)); await flush(); await flush();
    await f.reload();
    f.capabilities.renderCapabilities(f.catalog);
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    assert.throws(() => f.settings.toolSettingsPayload(), /tool_settings_view_locked/);
    assert.equal(f.posts.length, 0); assert.equal(f.h.get("toast").classList.contains("success"), false);
    f.override(undefined); f.h.session.set("qqfriend-admin-token", token);
    await f.actions.runAction("refreshCapabilities");
    assert.equal(f.node("mcp-label").value, "Keep MCP draft"); assert.equal(f.node("toolAutonomyEnabled").checked, false);
    assert.doesNotThrow(() => f.mcp.mcpServerPayload()); assert.doesNotThrow(() => f.settings.toolSettingsPayload());
    assert.equal(f.posts.length, 0);
  });

  test("shared 503 invalidates both panels and their pending tickets without dropping drafts", async t => {
    const f = await fixture(t);
    await f.edit("mcp-label", "Keep service edit"); await f.edit("toolAutonomyEnabled", false);
    const mcpTicket = f.mcp.mcpActionTicket(), settingsTicket = f.settings.toolSettingsActionTicket();
    f.override(route => route === "/admin/capabilities" ? response(503, { error: "tool_settings_unavailable" }) : undefined);
    await f.actions.runAction("refreshCapabilities");
    assert.equal(f.mcp.mcpTicketCurrent(mcpTicket), false); assert.equal(f.settings.toolSettingsTicketCurrent(settingsTicket), false);
    assert.equal(f.mcp.mcpHasDrafts(), true); assert.equal(f.settings.toolSettingsHasDrafts(), true);
    assert.equal(f.button("saveMcpServer").disabled, true); assert.equal(f.button("saveToolSettings").disabled, true);
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    assert.throws(() => f.settings.toolSettingsPayload(), /tool_settings_view_locked/);
    assert.equal(f.posts.length, 0);
  });

  test("malformed shared capability response also invalidates both new panels", async t => {
    const f = await fixture(t);
    await f.edit("mcp-label", "Keep draft"); await f.edit("toolAutonomyEnabled", false);
    f.override(route => route === "/admin/capabilities" ? response(200, { categories: [], capabilities: [null] }) : undefined);
    await f.actions.runAction("refreshCapabilities");
    assert.equal(f.mcp.mcpHasDrafts(), true); assert.equal(f.settings.toolSettingsHasDrafts(), true);
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    assert.throws(() => f.settings.toolSettingsPayload(), /tool_settings_view_locked/);
  });

  test("actual backend connect 400 preserves the error snapshot, never reports success and remains a known failure", async t => {
    const f = await fixture(t); f.failConnect();
    const result = await f.actions.runAction("connectMcpServer", f.button("connectMcpServer"));
    assert.equal(result, false); assert.equal(f.attempts(), 2); assert.equal(f.posts.length, 1);
    assert.match(f.panels[0].textContent, /连接失败/); assert.doesNotMatch(f.panels[0].textContent, /已连接|写入结果未知/);
    assert.equal(f.panels[0].dataset.state, "error"); assert.doesNotThrow(() => f.mcp.mcpServerPayload());
    assert.equal(f.h.get("toast").classList.contains("success"), false);
    assert.match(f.h.get("toast").textContent, /连接或发现失败/);
    const actual = await f.request("/admin/mcp"); assert.equal(actual.value.servers[0].status, "error");
  });

  for (const scenario of ["503", "transport", "malformed400"]) test("MCP " + scenario + " write result stays unknown even with a claimed failure snapshot", async t => {
    const f = await fixture(t);
    f.override((route, body) => {
      if (route !== "/admin/mcp" || !body) return;
      if (scenario === "transport") throw new Error("synthetic-network-failure");
      const snapshot = scenario === "malformed400" ? { status: "ready" } : f.catalog.mcpServices;
      return response(scenario === "503" ? 503 : 400, { ok: false, error: "connection_failed", reason: "connection_failed", snapshot });
    });
    assert.equal(await f.actions.runAction("connectMcpServer", f.button("connectMcpServer")), false);
    assert.equal(f.posts.length, 1); assert.equal(f.panels[0].dataset.state, "unknown");
    assert.doesNotMatch(f.panels[0].textContent, /已连接/);
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    f.override(undefined); await f.mcpActions.runMcpAction("refreshMcp", f.button("refreshMcp"));
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    assert.equal(f.posts.length, 1);
  });

  test("shared failure during a pending MCP save rejects its late acknowledgement until explicit reconciliation", async t => {
    const f = await fixture(t); await f.edit("mcp-label", "Pending service edit");
    const delayed = deferred();
    f.override((route, body) => route === "/admin/mcp" && body ? delayed.promise : route === "/admin/capabilities" ? response(503, { error: "unavailable" }) : undefined);
    const pending = f.actions.runAction("saveMcpServer", f.button("saveMcpServer")); await flush();
    await f.actions.runAction("refreshCapabilities");
    delayed.resolve(response(200, { ok: true, ...f.catalog.mcpServices }));
    assert.equal(await pending, false);
    f.override(undefined); await f.actions.runAction("refreshCapabilities");
    assert.equal(f.node("mcp-label").value, "Pending service edit");
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/); assert.equal(f.posts.length, 1);
    await f.reload(); assert.doesNotThrow(() => f.mcp.mcpServerPayload());
  });

  test("late background rejection cannot invalidate a newer successful common read", async t => {
    const f = await fixture(t); const delayed = deferred(); let count = 0;
    f.override(route => route === "/admin/capabilities" && ++count === 1 ? delayed.promise : undefined);
    f.backgroundRead(); await flush(); await f.actions.runAction("refreshCapabilities");
    delayed.reject(new Error("synthetic-late-transport-failure")); await flush(); await flush();
    assert.doesNotThrow(() => f.mcp.mcpServerPayload());
    assert.equal(f.node("toolAutonomyEnabled").disabled, false);
    assert.equal(f.h.get("capabilityNotice").dataset.state, "ready");
  });

  test("a consumed actual capability DTO cannot clear a subsequent authentication fence", async t => {
    const f = await fixture(t); await f.edit("toolAutonomyEnabled", false);
    const snapshot = await f.host.call("getCapabilities"); f.capabilities.renderCapabilities(snapshot);
    f.capabilities.capabilityReadFailed({ status: 403 });
    f.capabilities.renderCapabilities(snapshot); await f.reload();
    assert.throws(() => f.mcp.mcpServerPayload(), /mcp_view_locked/);
    assert.throws(() => f.settings.toolSettingsPayload(), /tool_settings_view_locked/);
    assert.equal(f.posts.length, 0);
  });

  for (const scenario of ["success", "transport", "503", "403", "rawSuccess"]) test("stale front " + scenario + " cannot invalidate or overwrite a newer background read", async t => {
    const f = await fixture(t); await f.edit("toolAutonomyEnabled", false);
    const delayed = deferred(); let count = 0;
    if (scenario === "rawSuccess") {
      const call = f.host.call;
      f.host.call = (action, ...args) => action === "getCapabilities" && ++count === 1 ? delayed.promise : call(action, ...args);
    } else {
      f.override(route => route === "/admin/capabilities" && ++count === 1 ? delayed.promise : undefined);
    }
    const front = f.actions.runAction("refreshCapabilities"); await flush();
    f.backgroundRead(); await flush(); await flush();
    const current = () => ({ mcp: f.panels[0].dataset.state, settings: f.node("toolSettingsActionStatus").textContent,
      capability: f.h.get("capabilityNotice").textContent, capabilityState: f.h.get("capabilityNotice").dataset.state,
      toast: f.h.get("toast").textContent, activityTitle: f.h.get("activityTitle").textContent,
      activityDetail: f.h.get("activityDetail").textContent });
    const before = current();
    assert.equal(before.mcp, "ready"); assert.equal(f.node("toolAutonomyEnabled").disabled, false);
    assert.equal(f.settings.toolSettingsHasDrafts(), true); assert.doesNotThrow(() => f.settings.toolSettingsPayload());
    if (scenario === "transport") delayed.reject(new Error("synthetic-old-front-transport"));
    else if (["503", "403"].includes(scenario)) delayed.resolve(response(Number(scenario), { error: "synthetic-old-front-failure" }));
    else delayed.resolve(scenario === "rawSuccess" ? f.catalog : response(200, f.catalog));
    await front; await flush();
    assert.deepEqual(current(), before);
    assert.equal(f.node("toolAutonomyEnabled").checked, false); assert.equal(f.node("toolAutonomyEnabled").disabled, false);
    assert.equal(f.settings.toolSettingsHasDrafts(), true); assert.doesNotThrow(() => f.settings.toolSettingsPayload());
    assert.doesNotThrow(() => f.mcp.mcpServerPayload()); assert.equal(f.posts.length, 0);
    assert.equal(f.h.document.body.attributes["aria-busy"], "false");
  });
}
