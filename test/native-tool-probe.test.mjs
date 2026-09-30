import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-native-probe-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { probeNativeChatTools } = await import("../bridge/chat-tools/native-probe.mjs");
const { createToolCompatibilityStore } = await import("../bridge/chat-tools/compatibility-store.mjs");
const { nativeToolIdentity, buildNativeToolCompatibilitySnapshot } = await import("../bridge/chat-tools/compatibility.mjs");
const { createDefaultApiConfig } = await import("../bridge/api-providers/store.mjs");
const { createAdminTaskManager } = await import("../bridge/admin-api/task-manager.mjs");
let sequence = 0;
after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const folder = path.join(root, `case-${++sequence}`);
  fs.mkdirSync(folder);
  const config = createDefaultApiConfig();
  for (const provider of Object.values(config.providers)) Object.assign(provider, { endpoint: "https://example.com/" + provider.id, auth: "none", secretFile: "" });
  config.routes.group_chat.reasoning = "deep";
  const cfg = { configRoot: folder, dataRoot: folder, toolCompatibilityFile: path.join(folder, "proofs.json") };
  const store = createToolCompatibilityStore({ file: cfg.toolCompatibilityFile });
  return { cfg, config, store, currentConfig: () => config };
}
const response = message => ({ ok: true, transportAttempts: 1, raw: { choices: [{ message }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0,
    completion_tokens_details: { reasoning_tokens: 8 } } } });
const tool = (expression = "17*3+5", overrides = {}) => ({ content: null, reasoning_content: "PRIVATE_REASONING",
  tool_calls: [{ id: "native-calc", type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression }) } }], ...overrides });
function mockProvider(calls, replies) {
  return async (id, request, options) => {
    request.validatePrepared(request);
    assert.equal(request.beforeAttempt(), "");
    assert.equal(request.maxAttempts, 1);
    assert.equal(request.maxResponseBytes, 262144);
    assert.equal(options.usageTask, "agent_tool_probe");
    assert.equal(options.usagePosition, id === "mimo" ? "primary" : "fallback");
    calls.push({ id, request, options, wireMessages: JSON.stringify(request.messages) });
    return replies ? replies(id, request, calls.length) : response(request.messages.some(item => item.role === "tool") ? { content: "56" } : tool());
  };
}

test("actual configured modes are preserved and each native slot gets one tool/continuation without sends", async () => {
  const f = fixture(); const calls = [];
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls) });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.status, "verified");
  assert.equal(result.provenance, "qa");
  assert.equal(buildNativeToolCompatibilitySnapshot({ cfg: f.cfg, config: f.config, store: f.store }).status, "unknown");
  assert.equal(calls.length, 4);
  assert.equal(result.attempts, 4);
  assert.equal(result.sendsMessages, false);
  for (const call of calls) assert.equal(call.request.thinking.type, "enabled");
  assert.equal(calls[0].request.tools.length, 5);
  assert.equal(calls[1].request.toolChoice, "none");
  assert.match(JSON.stringify(calls[1].request.messages), /PRIVATE_REASONING/);
  assert.doesNotMatch(calls[2].wireMessages, /PRIVATE_REASONING/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING|native-calc|expression|api_key|endpoint|claimId|identity/);
  for (const slot of result.slots) {
    assert.equal(slot.attempts, 2);
    assert.equal(slot.usage.promptTokens, 200);
    assert.equal(slot.usage.transportAttempts, 2);
  }
});

test("repeated admin actions reuse quota/result and never issue another paid attempt", async () => {
  const f = fixture(); const calls = [];
  const runtime = { ...f, callProvider: mockProvider(calls) };
  await probeNativeChatTools({ action: "probe" }, runtime);
  const repeated = await probeNativeChatTools({ action: "probe" }, runtime);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.attempts, 0);
  assert.equal(calls.length, 4);
});

test("unknown or executable model calls are rejected, never dispatched and never confirmed compatible", async () => {
  for (const message of [tool("process.exit()"), tool("1+1"), tool("17*3+5", { tool_calls: [{ id: "exec", type: "function", function: { name: "exec", arguments: "{}" } }] }),
    { content: "56", reasoning_content: "PRIVATE_REASONING" }]) {
    const f = fixture(); const calls = [];
    const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls, () => response(message)) });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.ok(result.slots.every(slot => slot.status !== "verified"));
    assert.doesNotMatch(JSON.stringify(result), /process\.exit|PRIVATE_REASONING/);
  }
});

test("reasoning-only or wrong final answers cannot become compatibility proof", async () => {
  for (const final of [{ content: "", reasoning_content: "PRIVATE_REASONING" }, { content: "57" }, tool()]) {
    const f = fixture(); const calls = [];
    const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls,
      (_id, request) => response(request.messages.some(item => item.role === "tool") ? final : tool())) });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 4);
    assert.ok(result.slots.every(slot => slot.status === "failed"));
  }
});

test("transport failure consumes only its actual attempt and does not retry or manufacture continuation", async () => {
  const f = fixture(); const calls = [];
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls,
    () => ({ ok: false, transportAttempts: 1, error: "PRIVATE_PROVIDER_ERROR" })) });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_ERROR/);
  assert.ok(result.slots.every(slot => slot.attempts === 1 && slot.usage.usageReported === false && slot.usage.promptTokens === null));
});

test("unsupported declarations and missing keys do not cause a paid request", async () => {
  const f = fixture();
  f.config.providers.mimo.capabilities = ["text"];
  f.config.providers.deepseek.auth = "bearer";
  f.config.providers.deepseek.secretFile = "missing-key";
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: () => assert.fail("must not call") });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.ok(result.slots.every(slot => slot.status === "unsupported"));
});

test("schema, real key, mode and endpoint changes invalidate proof; a cosmetic name does not", () => {
  const f = fixture(); const provider = f.config.providers.mimo;
  const options = { config: f.config, root: f.cfg.configRoot, secret: "synthetic-a" };
  const identity = nativeToolIdentity(provider, options);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(nativeToolIdentity({ ...provider, name: "renamed" }, options), identity);
  for (const replacement of [{ model: "changed-model" }, { endpoint: "https://example.com/new" }, { tokenField: "max_new_tokens" },
    { protocol: "openai-responses" }, { capabilities: ["text"] }]) assert.notEqual(nativeToolIdentity({ ...provider, ...replacement }, options), identity);
  assert.notEqual(nativeToolIdentity(provider, { ...options, secret: "synthetic-b" }), identity);
  f.config.routes.group_chat.reasoning = "economy";
  assert.notEqual(nativeToolIdentity(provider, options), identity);
});

test("a route change during a response invalidates that slot's proof before final continuation", async () => {
  const f = fixture(); const calls = [];
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls, (id) => {
    if (id === "mimo") f.config.providers.mimo.model = "changed-model";
    return response(tool());
  }) });
  assert.equal(result.slots[0].status, "failed");
  assert.equal(result.slots[0].reason, "configuration_changed");
  assert.equal(calls.filter(call => call.id === "mimo").length, 1);
});

test("global cancellation before a probe does not create a false active budget claim", async () => {
  const f = fixture(); const controller = new globalThis.AbortController(); controller.abort();
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, signal: controller.signal, callProvider: () => assert.fail() });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0);
  assert.equal(f.store.snapshot().recordCount, 0);
});

test("corrupt proof state refuses network authorization and never rewrites its bytes", async () => {
  const f = fixture(); const original = "{corrupt-proof";
  fs.writeFileSync(f.cfg.toolCompatibilityFile, original);
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: () => assert.fail() });
  assert.equal(result.ok, false);
  assert.equal(result.snapshot.probeAllowed, false);
  assert.equal(result.snapshot.status, "unavailable");
  assert.ok(result.snapshot.slots.every(slot => slot.status === "unavailable"));
  assert.equal(fs.readFileSync(f.cfg.toolCompatibilityFile, "utf8"), original);
});

test("one verified provider cannot make an unsupported fallback fully verified", async () => {
  const f = fixture(); const calls = [];
  f.config.providers.deepseek.capabilities = ["text"];
  const result = await probeNativeChatTools({ action: "probe" }, { ...f, callProvider: mockProvider(calls) });
  assert.equal(result.ok, false);
  assert.equal(result.snapshot.status, "partial");
  assert.deepEqual(result.snapshot.slots.map(slot => slot.status), ["verified", "unsupported"]);
  assert.equal(calls.length, 2);
});

test("management tasks accept only fixed probe action, not tools, URLs, paths or fake success flags", async () => {
  const f = fixture(); let invoked = 0;
  const manager = createAdminTaskManager({ filename: path.join(f.cfg.dataRoot, "tasks.json"), handlers: {
    agent_tools: payload => { invoked++; assert.deepEqual(payload, { action: "probe" }); return { ok: false }; },
  } });
  for (const extras of [{ url: "https://example.com" }, { path: "/config/key" }, { status: "verified" }, { providerId: "other" }]) {
    assert.throws(() => manager.start({ module: "agent_tools", payload: { action: "probe", ...extras } }), /参数无效/);
    await assert.rejects(probeNativeChatTools({ action: "probe", ...extras }, f), /参数无效/);
  }
  assert.equal(invoked, 0);
  const started = manager.start({ module: "agent_tools", payload: { action: "probe" } });
  await manager.wait();
  assert.equal(manager.snapshot({ id: started.jobId }).task.phase, "failed");
  assert.equal(invoked, 1);
  assert.equal(buildNativeToolCompatibilitySnapshot({ cfg: f.cfg, config: f.config, store: f.store }).status, "unknown");
});
