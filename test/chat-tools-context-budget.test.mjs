import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-context-budget-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), NODE_ENV: "test" });

const { CFG } = await import("../bridge/config.mjs");
const { saveApiProvider } = await import("../bridge/api-providers/store.mjs");
const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
const { runScopedChat } = await import("../bridge/chat-tools/runner.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { CHAT_TOOL_LIMITS } = await import("../bridge/chat-tools/policy.mjs");
const { measureVisionRequest } = await import("../bridge/vision/request-budget.mjs");

after(() => {
  const temp = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(root).startsWith(temp));
  fs.rmSync(root, { recursive: true, force: true });
});

CFG.groupWhitelist = [50100];
CFG.friendWhitelist = [60100];
CFG.botBlacklist = [];

const scope = { surface: "group", groupId: "50100", userId: "60100" };
const current = "CURRENT_INPUT_BUDGET_SENTINEL: compare the earlier notes";
const quote = "QUOTE_BUDGET_SENTINEL: exact user quotation";
const preference = "PREFERENCE_BUDGET_SENTINEL: preserve this preference";
const memory = "MEMORY_BUDGET_SENTINEL: note citation";
const file = "FILE_BUDGET_SENTINEL: attached document excerpt";
const opaque = "opaque-state-" + "A+/=".repeat(2700);
const source = { noteId: "abcdef012345", revision: 2 };

for (const [id, protocol] of [["budget-anthropic", "anthropic-messages"], ["budget-responses", "openai-responses"]]) {
  saveApiProvider({ id, protocol, presetId: "custom-openai-chat", auth: "none", model: id,
    endpoint: "https://example.com/" + id, capabilities: ["text", "tools", "reasoning"], enabled: true }, { root });
}
saveApiProvider({ id: "budget-dynamic-token", protocol: "openai-chat", presetId: "custom-openai-chat", auth: "none",
  model: "budget-dynamic-token", tokenField: "max_new_tokens", endpoint: "https://example.com/budget-dynamic-token",
  capabilities: ["text"], enabled: true }, { root });

function boundedHistory(protectedLength = 160) {
  const layers = [];
  for (let group = 0; group < 4; group++) {
    layers.push({ role: "user", content: `OLD_GROUP_${group}_USER ` + "u".repeat(2500), contextGroup: `old-${group}`, contextPriority: 20 });
    layers.push({ role: "assistant", content: `OLD_GROUP_${group}_ASSISTANT ` + "a".repeat(2500), contextGroup: `old-${group}`, contextPriority: 20 });
  }
  layers.push({ role: "user", content: quote + " q".repeat(protectedLength), contextGroup: "quote", contextPriority: 90 });
  layers.push({ role: "user", content: preference, contextGroup: "preference", contextPriority: 90 });
  layers.push({ role: "user", content: memory, contextGroup: "memory", contextPriority: 95, contextMemorySources: [source] });
  layers.push({ role: "user", content: file, contextGroup: "file", contextPriority: 95 });
  const bounded = enforceContextBudget(layers, current, { maxChars: 23000, maxMessageChars: 18000, maxMessages: 32 });
  if (protectedLength === 160) assert.equal(bounded.budget.prunedGroupCount, 0);
  return bounded;
}

function sessionWithMeasurements() {
  const actual = createChatToolSession({ scope, cfg: CFG, task: "group_chat", userMessage: current,
    recallMemory: () => ({ status: "ok", text: "synthetic recalled fact", memorySources: [source] }),
    readBotStatus: () => ({ status: "ok", text: "synthetic status" }) });
  const measurements = [];
  const toolSession = { ...actual, prepareModel(request) {
    const sample = { beforeSession: measureVisionRequest(request).chars,
      withoutOldHistory: measureVisionRequest({ ...request, messages: request.messages.filter(message =>
        !/^OLD_GROUP_\d+_/.test(message.content || "")) }).chars };
    measurements.push(sample);
    const prepared = actual.prepareModel(request);
    return { ...prepared, fitPreparedContext(gatewayRequest, measure) {
      if (!measure) sample.afterSelfContext = measureVisionRequest(gatewayRequest).chars;
      const messages = prepared.fitPreparedContext(gatewayRequest, measure);
      sample.sent = (measure || measureVisionRequest)({ ...gatewayRequest, messages }).chars;
      return messages;
    } };
  } };
  return { toolSession, measurements };
}

function firstResponse(protocol) {
  if (protocol === "anthropic-messages") return { content: [
    { type: "thinking", thinking: "synthetic reasoning", signature: opaque },
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "recall-a", name: "recall_memory", input: { query: "project" } },
    { type: "tool_use", id: "status-b", name: "read_bot_status", input: {} },
  ], stop_reason: "tool_use" };
  return { output: [
    { type: "reasoning", id: "reason-a", summary: [], encrypted_content: opaque },
    { type: "message", id: "message-a", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
    { type: "function_call", id: "function-a", call_id: "recall-a", name: "recall_memory", arguments: '{"query":"project"}', status: "completed" },
    { type: "function_call", id: "function-b", call_id: "status-b", name: "read_bot_status", arguments: "{}", status: "completed" },
  ] };
}

function finalResponse(protocol, text = "Bounded continuation succeeded.") {
  return protocol === "anthropic-messages" ? { content: [{ type: "text", text }] }
    : { output: [{ type: "message", id: "final", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] }] };
}

function wireText(body) { return JSON.stringify(body.messages ?? body.input); }
function assertGroups(body) {
  const text = wireText(body);
  for (let group = 0; group < 4; group++) {
    assert.equal(text.includes(`OLD_GROUP_${group}_USER`), text.includes(`OLD_GROUP_${group}_ASSISTANT`));
  }
  for (const marker of [current, quote, preference, memory, file]) assert.ok(text.includes(marker), marker);
  return text;
}

function assertReplay(protocol, body) {
  if (protocol === "anthropic-messages") {
    const assistant = body.messages.find(item => item.role === "assistant" && item.content.some(block => block.type === "tool_use"));
    assert.ok(assistant);
    assert.equal(assistant.content[0].signature, opaque);
    assert.deepEqual(assistant.content.filter(block => block.type === "tool_use").map(block => block.id), ["recall-a", "status-b"]);
    const results = body.messages.find(item => item.role === "user" && item.content.some(block => block.type === "tool_result"));
    assert.deepEqual(results.content.map(block => block.tool_use_id), ["recall-a", "status-b"]);
  } else {
    assert.equal(body.input.find(item => item.type === "reasoning").encrypted_content, opaque);
    assert.deepEqual(body.input.filter(item => item.type === "function_call").map(item => item.call_id), ["recall-a", "status-b"]);
    assert.deepEqual(body.input.filter(item => item.type === "function_call_output").map(item => item.call_id), ["recall-a", "status-b"]);
  }
  const serialized = JSON.stringify(body);
  for (const internal of ["fitPreparedContext", "contextGroup", "memorySources", "providerContinuation"]) {
    assert.equal(serialized.includes(internal), false, internal);
  }
}

for (const [providerId, protocol] of [["budget-anthropic", "anthropic-messages"], ["budget-responses", "openai-responses"]]) {
  test(`${protocol}: runner prunes complete history groups across a signed two-round continuation`, async t => {
    const history = boundedHistory();
    const { toolSession, measurements } = sessionWithMeasurements();
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), `https://example.com/${providerId}`);
      const body = JSON.parse(options.body);
      bodies.push(body);
      assert.ok(bodies.length <= 2, "no summary or extra model request");
      return { ok: true, status: 200, text: async () => JSON.stringify(bodies.length === 1 ? firstResponse(protocol) : finalResponse(protocol)) };
    });
    const outcome = await runScopedChat({ messages: [...history.messages, { role: "user", content: current }], selfContext: scope,
      memorySources: history.memorySources }, { providerId, task: "group_chat", userMessage: current, toolSession });
    assert.equal(outcome.kind, "reply");
    assert.equal(outcome.text, "Bounded continuation succeeded.");
    assert.deepEqual(outcome.memorySources, [source]);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map(body => body.model), [providerId, providerId]);
    for (const body of bodies) for (const internal of ["fitPreparedContext", "contextGroup", "memorySources"]) {
      assert.equal(JSON.stringify(body).includes(internal), false, internal);
    }
    assert.ok(measurements[0].sent <= CHAT_TOOL_LIMITS.requestChars);
    assert.ok(measurements[1].beforeSession > CHAT_TOOL_LIMITS.requestChars, JSON.stringify(measurements));
    assert.ok(measurements[1].afterSelfContext > CHAT_TOOL_LIMITS.requestChars, JSON.stringify(measurements));
    assert.ok(measurements[1].sent <= CHAT_TOOL_LIMITS.requestChars, JSON.stringify(measurements));
    const firstText = assertGroups(bodies[0]);
    const secondText = assertGroups(bodies[1]);
    assert.ok([0, 1, 2, 3].some(group => firstText.includes(`OLD_GROUP_${group}_USER`) && !secondText.includes(`OLD_GROUP_${group}_USER`)));
    assertReplay(protocol, bodies[1]);
    t.diagnostic(`measured chars ${JSON.stringify(measurements)}`);
  });

  test(`${protocol}: stops the slot before an over-budget native replay`, async t => {
    const history = boundedHistory(6500);
    const { toolSession, measurements } = sessionWithMeasurements();
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), `https://example.com/${providerId}`);
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify(firstResponse(protocol)) };
    });
    const outcome = await runScopedChat({ messages: [...history.messages, { role: "user", content: current }], selfContext: scope },
      { providerId, task: "group_chat", userMessage: current, toolSession });
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.reason, "tools_unavailable");
    assert.equal(bodies.length, 1);
    assert.ok(measurements[0].sent <= CHAT_TOOL_LIMITS.requestChars);
    assert.ok(measurements[1].beforeSession > CHAT_TOOL_LIMITS.requestChars);
    assert.ok(measurements[1].withoutOldHistory > CHAT_TOOL_LIMITS.requestChars, JSON.stringify(measurements));
    assert.ok([0, 1, 2, 3].some(group => wireText(bodies[0]).includes(`OLD_GROUP_${group}_USER`)));
    t.diagnostic(`measured chars ${JSON.stringify(measurements)}`);
  });

  test(`${protocol}: a new fallback slot carries tool evidence but not primary opaque state`, async t => {
    const { toolSession } = sessionWithMeasurements();
    const bodies = [];
    const fallbackId = providerId === "budget-anthropic" ? "budget-responses" : "budget-anthropic";
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), `https://example.com/${bodies.length < 2 ? providerId : fallbackId}`);
      bodies.push(JSON.parse(options.body));
      const response = bodies.length === 1 ? firstResponse(protocol) : bodies.length === 2 ? finalResponse(protocol, "")
        : finalResponse(protocol === "anthropic-messages" ? "openai-responses" : "anthropic-messages", "Fallback answer.");
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    });
    const request = { messages: [{ role: "user", content: current }], selfContext: scope };
    const primary = await runScopedChat(request, { providerId, task: "group_chat", userMessage: current, toolSession });
    assert.equal(primary.kind, "error");
    const fallback = await runScopedChat(request, { providerId: fallbackId, task: "group_chat", userMessage: current,
      toolSession, position: "fallback" });
    assert.equal(fallback.kind, "reply");
    assert.equal(fallback.text, "Fallback answer.");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].model, fallbackId);
    assert.ok(wireText(bodies[2]).includes("synthetic recalled fact"));
    assert.equal(JSON.stringify(bodies[2]).includes(opaque), false);
    assert.equal(JSON.stringify(bodies[2]).includes("providerContinuation"), false);
  });
}

test("current input alone above the hard request budget never reaches transport", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("over-budget current input reached transport"); });
  const input = "CURRENT_OVERSIZE_SENTINEL " + "x".repeat(CHAT_TOOL_LIMITS.requestChars);
  const measured = measureVisionRequest({ messages: [{ role: "user", content: input }], tools: [] }).chars;
  assert.ok(measured > CHAT_TOOL_LIMITS.requestChars);
  const outcome = await runScopedChat({ messages: [{ role: "user", content: input }], selfContext: scope },
    { providerId: "budget-anthropic", task: "group_chat", userMessage: input });
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.reason, "tools_unavailable");
  assert.equal(calls, 0);
  t.diagnostic(`current-only measured chars ${measured}`);
});

test("runner charges optional extra payloads and refuses prompt, route and budget overrides", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("extra budget bypass reached transport"); });
  const messages = [{ role: "user", content: "Short current input" }];
  const extra = { metadata: { synthetic: "x".repeat(CHAT_TOOL_LIMITS.requestChars) } };
  assert.ok(measureVisionRequest({ messages, extra }).chars > CHAT_TOOL_LIMITS.requestChars);
  const extras = [extra, { instructions: "override" }, { system: "override" }, { systemInstruction: {} },
    { model: "different-model" }, { max_tokens: 999999 }, { generationConfig: { maxOutputTokens: 999999 } },
    { thinking: { type: "enabled" } }, { previous_response_id: "other-scope" }];
  for (const bodyExtra of extras) {
    const outcome = await runScopedChat({ messages, extra: bodyExtra, selfContext: scope },
      { providerId: "budget-responses", task: "group_chat", userMessage: "Short current input" });
    assert.equal(outcome.kind, "error");
  }
  assert.equal(calls, 0);
});

test("runner refuses extra overriding a provider's configured output token field", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("dynamic token override reached transport"); });
  const messages = [{ role: "user", content: "Short current input" }];
  const extra = { max_new_tokens: 999999 };
  assert.ok(measureVisionRequest({ messages, extra }).chars < CHAT_TOOL_LIMITS.requestChars);
  const outcome = await runScopedChat({ messages, maxTokens: 10, extra, selfContext: scope },
    { providerId: "budget-dynamic-token", task: "group_chat", userMessage: "Short current input" });
  assert.equal(outcome.kind, "error");
  assert.equal(calls, 0);
});
