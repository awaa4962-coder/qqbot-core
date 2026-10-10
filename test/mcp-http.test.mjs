import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHttpMcpClient, createMcpFetch } from "../bridge/mcp/http-client.mjs";
import { MCP_LIMITS, hash, safeEndpoint } from "../bridge/mcp/policy.mjs";
import { createMcpServices } from "../bridge/mcp/services.mjs";
import { registeredTool } from "../bridge/chat-tools/registry.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fakeService(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port + "/mcp";
}
test("MCP uses official v2 SDK initialize/list/call/close over Streamable HTTP", async t => {
  const calls = [];
  const tokens = [];
  const inputSchema = { type: "object", properties: { query: { type: "string", maxLength: 100 } }, required: ["query"], additionalProperties: false };
  const endpoint = await fakeService(t, async (request, response) => {
    tokens.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "synthetic", version: "1" }, instructions: "malicious instructions never forwarded" } :
      message.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema }] } : { content: [{ type: "text", text: "SDK synthetic result" }] };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const controller = new globalThis.AbortController();
  const client = await createHttpMcpClient({ url: endpoint }, { token: "synthetic-sdk-token", signal: controller.signal });
  t.after(() => client.abort());
  await client.connect({ signal: controller.signal, timeout: 1000 });
  const list = await client.listTools({ cursor: "" }, { signal: controller.signal, timeout: 1000 });
  assert.equal(list.tools[0].name, "lookup");
  const result = await client.callTool({ name: "lookup", arguments: { query: "weather" } },
    { signal: controller.signal, timeout: 1000, toolDefinition: list.tools[0] });
  assert.equal(result.content[0].text, "SDK synthetic result");
  assert.deepEqual(calls.filter(method => !method.startsWith("notifications/")), ["initialize", "tools/list", "tools/call"]);
  assert.ok(tokens.every(value => value === "Bearer synthetic-sdk-token"));
  await client.close();
});
test("MCP redirect never forwards bearer token to a second endpoint", async t => {
  let destinationHits = 0;
  const destination = await fakeService(t, (_request, response) => { destinationHits++; response.end("unexpected"); });
  const endpoint = await fakeService(t, (_request, response) => response.writeHead(307, { Location: destination }).end());
  await assert.rejects(createMcpFetch(endpoint, { token: "synthetic-no-leak" })(endpoint, { method: "POST", body: "{}" }));
  assert.equal(destinationHits, 0);
});
test("MCP fetch enforces endpoint, byte caps, cancellation and no error replay", async () => {
  let count = 0;
  let redirect;
  const endpoint = "https://example.test/mcp";
  const boundedFetch = createMcpFetch(endpoint, { fetchImpl: async (_url, init) => {
    count++; redirect = init.redirect;
    return new globalThis.Response("x".repeat(MCP_LIMITS.wireBytes + 1));
  } });
  const response = await boundedFetch(endpoint);
  await assert.rejects(response.text());
  assert.equal(redirect, "error"); assert.equal(count, 1);
  await assert.rejects(boundedFetch("https://other.test/mcp")); assert.equal(count, 1);
  const controller = new globalThis.AbortController(); controller.abort();
  const abortFetch = createMcpFetch(endpoint, { signal: controller.signal, fetchImpl: async (_url, init) => { init.signal.throwIfAborted(); } });
  await assert.rejects(abortFetch(endpoint));
});
test("MCP SDK does not replay 401, 403 or 404 tool POSTs", async t => {
  let status = 401;
  let attempts = 0;
  const endpoint = await fakeService(t, async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } })); return;
    }
    attempts++; response.writeHead(status).end("raw error never propagated to model");
  });
  const client = await createHttpMcpClient({ url: endpoint }, { token: "synthetic-token" });
  t.after(() => client.abort());
  await client.connect({ timeout: 1000 });
  for (status of [401, 403, 404]) {
    const before = attempts;
    await assert.rejects(client.callTool({ name: "lookup", arguments: {} }, {
      timeout: 1000, toolDefinition: { name: "lookup", inputSchema: { type: "object" } },
    }));
    assert.equal(attempts, before + 1);
  }
});

test("MCP adapter executes SDK no-argument, public-query and bound-current-scope paths", async t => {
  const empty = { type: "object" };
  const query = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  const current = { type: "object", properties: { group_id: { type: "integer" } }, required: ["group_id"] };
  const person = { type: "object", properties: { user_id: { type: "string" } }, required: ["user_id"] };
  const tools = [{ name: "status", inputSchema: empty }, { name: "lookup", inputSchema: query },
    { name: "mine", inputSchema: current }, { name: "person", inputSchema: person }];
  const calls = [];
  const endpoint = await fakeService(t, async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "tools/call") calls.push(message.params);
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } :
      message.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "synthetic scoped data" }] };
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-mcp-sdk-"));
  const services = createMcpServices({ cfg: { configRoot: root, mcpConfigFile: path.join(root, "mcp-services.json") } });
  t.after(async () => { await services.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const configuration = { servers: [{ id: "sdkpaths", label: "SDK paths", enabled: true, url: endpoint,
    tools: tools.map(tool => ({ name: tool.name, enabled: true, mode: "read", scope: ["mine", "person"].includes(tool.name) ? "current" : "public",
      bindings: tool.name === "mine" ? { group_id: "groupId" } : tool.name === "person" ? { user_id: "userId" } : {}, schemaHash: hash(tool.inputSchema) })) }] };
  const saved = await services.action({ action: "save", expectedRevision: "0", configuration });
  const connected = await services.action({ action: "connect", expectedRevision: saved.revision, serverId: "sdkpaths" });
  assert.equal(connected.ok, true);
  assert.equal(connected.servers[0].toolCount, 4);
  const ctx = { scope: { surface: "group", groupId: "200001", userId: "100001" }, signal: new globalThis.AbortController().signal,
    networkAllowed: true, assertCurrent() {}, options: { task: "group_chat", userMessage: "weather" }, publicQueryGuard: {
      allows: input => input === "weather", protectedValues: () => ["200001", "100001", "private-name"], hasPrivateContext: () => false } };
  for (const tool of connected.servers[0].tools) {
    const entry = registeredTool(tool.publicName);
    assert.equal(entry.available(ctx), true);
    const result = await entry.execute(tool.name === "lookup" ? { query: "weather" } : {}, ctx);
    assert.equal(result.status, "ok"); assert.ok(result.text);
  }
  assert.deepEqual(calls.map(call => call.arguments), [{}, { query: "weather" }, { group_id: 200001 }, { user_id: "100001" }]);
  const lookup = registeredTool(connected.servers[0].tools.find(tool => tool.name === "lookup").publicName);
  assert.equal((await lookup.execute({ query: "private-name" }, ctx)).status, "denied");
  assert.equal(calls.length, 4);
});

test("MCP official SDK cancellation aborts a pending HTTP tool response without replay", async t => {
  let began;
  let calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  const endpoint = await fakeService(t, async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "tools/call") { calls++; began(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
  });
  const client = await createHttpMcpClient({ url: endpoint });
  t.after(() => client.abort());
  await client.connect({ timeout: 1000 });
  const controller = new globalThis.AbortController();
  const pending = client.callTool({ name: "lookup", arguments: {} }, { signal: controller.signal, timeout: 1000,
    toolDefinition: { name: "lookup", inputSchema: { type: "object" } } });
  const rejected = assert.rejects(pending);
  await started; controller.abort();
  await rejected;
  assert.equal(calls, 1);
});

test("MCP private HTTP endpoint boundaries allow administrator Docker DNS/RFC1918/ULA only", () => {
  for (const url of ["http://mcp-service:3000/mcp", "http://localhost/mcp", "http://10.1.2.3/mcp",
    "http://172.16.0.1/mcp", "http://172.31.255.254/mcp", "http://192.168.2.1/mcp", "http://[fd12::1]/mcp", "https://public.example/mcp"]) assert.equal(safeEndpoint(url), new globalThis.URL(url).href);
  for (const url of ["http://8.8.8.8/mcp", "http://public.example/mcp", "http://172.15.0.1/mcp", "http://172.32.0.1/mcp",
    "http://169.254.169.254/mcp", "http://[2001:4860::1]/mcp", "http://[fe80::1]/mcp", "http://mcp-service./mcp",
    "http://user:secret@mcp-service/mcp", "http://mcp-service/mcp?token=key", "http://mcp-service/mcp#key", "file:///tmp/mcp"]) {
    assert.throws(() => safeEndpoint(url), error => error.mcpReason === "invalid_endpoint");
  }
});
test("MCP private endpoints remain pinned and do not accept redirected tool destinations", async () => {
  let calls = 0;
  const endpoint = "http://mcp-service:3000/mcp";
  const fetch = createMcpFetch(endpoint, { token: "synthetic-token", fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, "error"); return new globalThis.Response(null, { status: 307, headers: { location: "http://other-service:3000/mcp" } });
  } });
  await assert.rejects(fetch(endpoint), error => error.mcpReason === "redirect_denied");
  await assert.rejects(fetch("http://other-service:3000/mcp"), error => error.mcpReason === "endpoint_changed");
  assert.equal(calls, 1);
});
