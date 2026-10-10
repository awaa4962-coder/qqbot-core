import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { CFG } from "../bridge/config.mjs";
import { handleAdminApiRequest } from "../bridge/admin-api/routes.mjs";
import { initializeMcpServices, closeMcpServices } from "../bridge/mcp/index.mjs";
import { hash } from "../bridge/mcp/policy.mjs";
import { buildRuntimeStatus } from "../bridge/admin-api/runtime-status.mjs";

const token = "synthetic-admin-token";
const schema = { type: "object", properties: {}, additionalProperties: false };
async function request(route, body, authorized = true) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method: body === undefined ? "GET" : "POST", url: route,
    socket: { remoteAddress: "127.0.0.1" }, headers: authorized ? { authorization: "Bearer " + token } : {} });
  let response;
  await handleAdminApiRequest(req, {}, { pathname: route, requiredToken: token,
    sendJson(_res, code, value) { response = { code, value }; } });
  return response;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tool-admin-"));
  const original = { toolSettingsFile: CFG.toolSettingsFile };
  CFG.toolSettingsFile = path.join(root, "tool-settings.json");
  await initializeMcpServices({ cfg: { configRoot: root, mcpConfigFile: path.join(root, "mcp-services.json") },
    createClient: async () => ({ connect: async () => {}, abort: async () => {},
      listTools: async () => ({ tools: [{ name: "public_info", inputSchema: schema }] }) }) });
  t.after(async () => { await closeMcpServices(); Object.assign(CFG, original); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("new tool and MCP routes retain management authentication for reads and writes", async () => {
  for (const route of ["/admin/agent-tools/settings", "/admin/mcp"]) {
    assert.equal((await request(route, undefined, false)).code, 403);
    assert.equal((await request(route, { action: "save" }, false)).code, 403);
  }
});

test("tool settings routes persist validated profiles and surface conflicts", async t => {
  const root = await fixture(t);
  const read = await request("/admin/agent-tools/settings");
  assert.equal(read.code, 200);
  const body = { action: "save", expectedRevision: read.value.revision,
    settings: { ...read.value.settings, profile: "extended" } };
  const saved = await request("/admin/agent-tools/settings", body);
  assert.equal(saved.code, 200);
  assert.equal(saved.value.effective.chat.toolCalls, 12);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "tool-settings.json"))).profile, "extended");
  assert.equal((await request("/admin/agent-tools/settings", body)).code, 409);
  assert.equal((await request("/admin/agent-tools/settings", { ...body, expectedRevision: saved.value.revision,
    settings: { ...body.settings, arbitrary: "unsafe" } })).code, 400);
});

test("MCP route distinguishes empty/default, successful save and stale revision", async t => {
  await fixture(t);
  const read = await request("/admin/mcp");
  assert.equal(read.code, 200);
  assert.deepEqual(read.value.configuration.servers, []);
  const body = { action: "save", expectedRevision: read.value.revision,
    configuration: { servers: [{ id: "synthetic", label: "Synthetic readonly service", url: "http://napcat-mcp:3010/mcp",
      enabled: false, tools: [] }] } };
  const saved = await request("/admin/mcp", body);
  assert.equal(saved.code, 200);
  assert.equal(saved.value.servers[0].status, "disabled");
  assert.equal((await request("/admin/mcp", body)).code, 409);
  const text = JSON.stringify(saved.value);
  assert.doesNotMatch(text, /tokenRef|\.mcp-secrets/);
});

test("runtime MCP counts use actually available tools rather than private approval fields", async t => {
  await fixture(t);
  const read = await request("/admin/mcp");
  const saved = await request("/admin/mcp", { action: "save", expectedRevision: read.value.revision,
    configuration: { servers: [{ id: "synthetic", label: "Synthetic service", url: "http://napcat-mcp:3010/mcp", enabled: true,
      tools: [{ name: "public_info", mode: "read", enabled: true, scope: "public", bindings: {}, schemaHash: hash(schema) }] }] } });
  assert.equal(saved.code, 200);
  const connected = await request("/admin/mcp", { action: "connect", expectedRevision: saved.value.revision, serverId: "synthetic" });
  assert.equal(connected.code, 200);
  assert.equal(connected.value.servers[0].tools[0].available, true);
  assert.equal(buildRuntimeStatus().modules.mcp.tools, 1);
  assert.equal(buildRuntimeStatus().modules.mcp.health, "ready");
});
