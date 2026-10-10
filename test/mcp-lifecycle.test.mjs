import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpServices } from "../bridge/mcp/services.mjs";
import { hash, MCP_LIMITS } from "../bridge/mcp/policy.mjs";
import { registeredTool, getToolSourceRevision } from "../bridge/chat-tools/registry.mjs";
import { createMcpFetch } from "../bridge/mcp/http-client.mjs";

function context(task = "group_chat", userMessage = "weather") {
  return { scope: { surface: task === "private_chat" ? "private" : "group", userId: "100001", ...(task === "private_chat" ? {} : { groupId: "200001" }) },
    options: { task, userMessage }, networkAllowed: true, signal: new globalThis.AbortController().signal, assertCurrent() {} };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Expected lifecycle transition did not occur");
}
async function service(t, { notifications = true, pendingCall = false, holdNotification = false } = {}) {
  const schema = { type: "object" }; const counters = { gets: 0, calls: 0, lists: 0 };
  let stream;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      counters.gets++;
      if (!notifications) { response.writeHead(405).end(); return; }
      stream = response;
      if (!holdNotification) { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": synthetic initial\n\n"); }
      return;
    }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "tools/call") { counters.calls++; if (pendingCall) return; }
    if (message.method === "tools/list") counters.lists++;
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: notifications } },
      serverInfo: { name: "synthetic-lifecycle", version: "1" } } : message.method === "tools/list" ? { tools: [{ name: "ping", inputSchema: schema }] } :
      { content: [{ type: "text", text: "synthetic result" }] };
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "synthetic-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-mcp-lifecycle-"));
  const services = createMcpServices({ cfg: { configRoot: root, mcpConfigFile: path.join(root, "mcp-services.json") } });
  t.after(async () => {
    await services.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  const saved = await services.action({ action: "save", expectedRevision: "0", configuration: { servers: [{ id: "lifecycle", label: "Synthetic lifecycle",
    url: "http://127.0.0.1:" + server.address().port + "/mcp", enabled: true, tools: [{ name: "ping", enabled: true, mode: "read", scope: "public", bindings: {}, schemaHash: hash(schema) }] }] } });
  const connected = await services.action({ action: "connect", expectedRevision: saved.revision, serverId: "lifecycle" });
  assert.equal(connected.ok, true); if (notifications) await waitFor(() => Boolean(stream));
  const entry = registeredTool(connected.servers[0].tools[0].publicName);
  return { services, counters, entry, schema, stream: () => stream };
}

test("MCP real SDK no-argument tools obey current group/private network veto", async t => {
  const f = await service(t, { notifications: false });
  for (const task of ["group_chat", "private_chat"]) for (const message of ["不要联网，只用本地资料", "do not browse or make network requests", "不\u200b要联\u200b网"]) {
    const ctx = context(task, message);
    assert.equal(f.entry.available(ctx), false);
    assert.equal((await f.entry.execute({}, ctx)).status, "denied");
  }
  assert.equal(f.counters.calls, 0);
  for (const task of ["interjection", "file_chat", "unknown"]) {
    const ctx = context(task);
    assert.equal(f.entry.available(ctx), false);
    assert.equal((await f.entry.execute({}, ctx)).status, "denied");
  }
  assert.equal(f.counters.calls, 0);
  assert.equal((await f.entry.execute({}, context())).status, "ok"); assert.equal(f.counters.calls, 1);
});
test("MCP real SDK notification channel survives eight seconds then invalidates on schema notification", async t => {
  const f = await service(t);
  await delay(MCP_LIMITS.timeoutMs + 300);
  assert.equal(f.services.snapshot().servers[0].status, "connected"); assert.equal(f.counters.gets, 1);
  assert.equal(f.entry.available(context()), true);
  f.schema.properties = { query: { type: "string" } };
  f.stream().write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await waitFor(() => f.services.snapshot().servers[0].status !== "connected");
  assert.equal(f.entry.available(context()), false); assert.equal((await f.entry.execute({}, context())).status, "denied");
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.equal(f.services.snapshot().servers[0].toolCount, 0);
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.gets, 1); assert.equal(f.counters.lists, 1);
  const refreshed = await f.services.action({ action: "refresh", serverId: "lifecycle", expectedRevision: f.services.snapshot().revision });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.servers[0].toolCount, 0);
  assert.equal(refreshed.servers[0].tools[0].reason, "schema_changed");
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.equal((await f.entry.execute({}, context())).status, "denied");
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.lists, 2);
});
test("MCP real SDK GET EOF invalidates old approval and cancels a pending POST without replay", async t => {
  const f = await service(t, { pendingCall: true });
  const revision = getToolSourceRevision();
  const pending = f.entry.execute({}, context()); await waitFor(() => f.counters.calls === 1);
  f.stream().end();
  const result = await pending;
  assert.notEqual(result.status, "ok"); assert.equal(f.entry.available(context()), false);
  assert.equal(f.services.snapshot().servers[0].reason, "notification_stream_ended");
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.ok(getToolSourceRevision() > revision);
  await delay(100); assert.equal(f.counters.gets, 1); assert.equal(f.counters.calls, 1);
});
test("MCP real SDK abrupt notification error invalidates service and cannot reuse old schema", async t => {
  const f = await service(t);
  f.stream().destroy(); await waitFor(() => !f.entry.available(context()));
  assert.equal(f.services.snapshot().servers[0].status, "disconnected");
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.equal((await f.entry.execute({}, context())).status, "denied");
  await delay(100); assert.equal(f.counters.gets, 1); assert.equal(f.counters.calls, 0);
});
test("MCP real SDK notification parse error revokes the old directory without reconnect", async t => {
  const f = await service(t);
  const revision = getToolSourceRevision();
  f.stream().write("event: message\ndata: not-json\n\n");
  await waitFor(() => f.services.snapshot().servers[0].status === "disconnected");
  assert.equal(f.services.snapshot().servers[0].reason, "transport_error");
  assert.equal(f.services.snapshot().servers[0].toolCount, 0);
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.ok(getToolSourceRevision() > revision);
  assert.equal((await f.entry.execute({}, context())).status, "denied");
  await delay(100); assert.equal(f.counters.gets, 1); assert.equal(f.counters.calls, 0);
});
test("MCP valid SSE frames may share a network chunk larger than the per-frame cap", async () => {
  const frame = ": " + "x".repeat(MCP_LIMITS.wireBytes / 2) + "\n\n";
  const fetch = createMcpFetch("http://mcp-service/mcp", {
    fetchImpl: async () => new globalThis.Response(frame.repeat(3), { headers: {
      "content-type": "text/event-stream", "content-length": String(frame.length * 3),
    } }),
  });
  const response = await fetch("http://mcp-service/mcp", { method: "GET" });
  assert.equal((await response.text()).length, frame.length * 3);
});
test("MCP SSE byte bounds apply to each frame, not cumulative stream lifetime", async () => {
  const frames = [": " + "x".repeat(MCP_LIMITS.wireBytes / 2) + "\r\n\r\n", ": " + "y".repeat(MCP_LIMITS.wireBytes / 2) + "\n\n"];
  const fetch = createMcpFetch("http://mcp-service/mcp", { fetchImpl: async () => new globalThis.Response(new globalThis.ReadableStream({ start(controller) {
    for (const frame of frames) controller.enqueue(new globalThis.TextEncoder().encode(frame)); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }) });
  const response = await fetch("http://mcp-service/mcp", { method: "GET" });
  assert.equal((await response.text()).length, frames.join("").length);
  let reason;
  const huge = createMcpFetch("http://mcp-service/mcp", { onNotificationFailure: value => { reason = value; },
    fetchImpl: async () => new globalThis.Response("x".repeat(MCP_LIMITS.wireBytes + 1), { headers: { "content-type": "text/event-stream" } }) });
  await assert.rejects((await huge("http://mcp-service/mcp", { method: "GET" })).text()); assert.equal(reason, "notification_stream_limit");
});

for (const status of [200, 204, 205]) {
  test("MCP bodyless successful GET " + status + " invalidates notification approval", async () => {
    const reasons = [];
    const fetch = createMcpFetch("http://mcp-service/mcp", { onNotificationFailure: reason => reasons.push(reason),
      fetchImpl: async () => new globalThis.Response(null, { status, headers: { "content-type": "text/event-stream" } }) });
    await assert.rejects(fetch("http://mcp-service/mcp", { method: "GET" }), { mcpReason: "notification_stream_invalid" });
    assert.deepEqual(reasons, ["notification_stream_invalid"]);
  });
}

test("MCP real SDK bodyless 204 revokes a published entry and aborts pending POST without replay", async t => {
  const f = await service(t, { holdNotification: true, pendingCall: true });
  const revision = getToolSourceRevision();
  const pending = f.entry.execute({}, context()); await waitFor(() => f.counters.calls === 1);
  f.stream().writeHead(204, { "Content-Type": "text/event-stream" }).end();
  const result = await pending;
  assert.notEqual(result.status, "ok"); assert.equal(f.entry.available(context()), false);
  assert.equal(f.services.snapshot().servers[0].reason, "notification_stream_invalid");
  assert.equal(f.services.snapshot().servers[0].toolCount, 0);
  assert.equal(registeredTool(f.entry.definition.function.name), undefined);
  assert.ok(getToolSourceRevision() > revision);
  await delay(100); assert.equal(f.counters.gets, 1); assert.equal(f.counters.calls, 1);
});

test("MCP real SDK explicit GET 405 unsupported preserves a legal approved client", async t => {
  const f = await service(t, { holdNotification: true });
  const revision = getToolSourceRevision();
  f.stream().writeHead(405).end(); await delay(100);
  assert.equal(f.services.snapshot().servers[0].status, "connected");
  assert.equal(f.services.snapshot().servers[0].reason, "");
  assert.equal(f.entry.available(context()), true);
  assert.equal(getToolSourceRevision(), revision);
  assert.equal((await f.entry.execute({}, context())).status, "ok");
  assert.equal(f.counters.gets, 1); assert.equal(f.counters.calls, 1);
});
