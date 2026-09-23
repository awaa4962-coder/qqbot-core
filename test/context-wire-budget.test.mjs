import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-wire-budget-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });

const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { CHAT_TOOL_LIMITS } = await import("../bridge/chat-tools/policy.mjs");
const { callApiProvider } = await import("../bridge/api-providers/gateway.mjs");
const { measureVisionRequest } = await import("../bridge/vision/request-budget.mjs");

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

const limit = CHAT_TOOL_LIMITS.requestChars;
const scope = { surface: "group", groupId: "50100", userId: "60100" };
const cfg = { groupWhitelist: [50100], friendWhitelist: [60100], botBlacklist: [], selfUin: 99900 };

function provider(protocol) {
  return { id: "wire-" + protocol, protocol, model: "wire-" + protocol, auth: "none", enabled: true,
    endpoint: "https://example.com/wire-" + protocol, capabilities: ["text", "vision"] };
}

function response(protocol) {
  if (protocol === "anthropic-messages") return { content: [{ type: "text", text: "ok" }] };
  if (protocol === "openai-responses") return { output: [{ type: "message", id: "reply", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok" }] }] };
  if (protocol === "gemini-native") return { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
  return { choices: [{ message: { content: "ok" } }] };
}

function session() { return createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "wire budget fixture" }); }

async function sendPrepared(t, protocol, input) {
  const api = provider(protocol);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), api.endpoint);
    assert.equal(options.method, "POST");
    bodies.push({ text: options.body, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(response(protocol)) };
  });
  const prepared = session().prepareModel(input);
  const result = await callApiProvider(api.id, prepared, { provider: api, key: "", usageMetricsDir: path.join(root, "usage") });
  return { prepared, result, bodies };
}

test("Responses 887 text parts cannot put 29k of non-image input on a 24k wire", async t => {
  const parts = Array.from({ length: 887 }, () => ({ type: "text", text: "x" }));
  const input = { messages: [{ role: "user", content: parts }], tools: [] };
  assert.equal(measureVisionRequest(input).chars, 23980);
  const { result, bodies } = await sendPrepared(t, "openai-responses", input);
  assert.equal(bodies.length, 0);
  assert.equal(result.ok, false);
  assert.ok(bodies.every(item => item.text.length <= limit), `actual wire chars: ${bodies.map(item => item.text.length)}`);
  assert.equal(result.ok, bodies.length === 1);
});

test("OpenAI Chat exact measured boundary cannot exceed the actual wire limit", async t => {
  const input = { messages: [{ role: "user", content: "" }], tools: [] };
  input.messages[0].content = "x".repeat(limit - measureVisionRequest(input).chars);
  assert.equal(measureVisionRequest(input).chars, limit);
  const { result, bodies } = await sendPrepared(t, "openai-chat", input);
  assert.equal(bodies.length, 0);
  assert.equal(result.ok, false);
  assert.ok(bodies.every(item => item.text.length <= limit), `actual wire chars: ${bodies.map(item => item.text.length)}`);
  assert.equal(result.ok, bodies.length === 1);
});

for (const protocol of ["anthropic-messages", "gemini-native"]) {
  test(`${protocol} refits a registered old group after native structural conversion`, async t => {
    const history = enforceContextBudget([{ role: "user", content: "OLD_WIRE_GROUP " + "h".repeat(1700),
      contextPriority: 20, contextGroup: "old-wire" }], "current", { maxChars: 30000, maxMessageChars: 30000 });
    const current = { role: "user", content: "CURRENT_WIRE_INPUT " };
    const input = { messages: [{ role: "system", content: "KEEP_SYSTEM" }, ...history.messages, current], tools: [] };
    current.content += "x".repeat(limit - 10 - measureVisionRequest(input).chars);
    assert.equal(measureVisionRequest(input).chars, limit - 10);
    const { result, bodies } = await sendPrepared(t, protocol, input);
    assert.equal(result.ok, true);
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].text.length <= limit, `actual wire chars: ${bodies[0].text.length}`);
    assert.doesNotMatch(bodies[0].text, /OLD_WIRE_GROUP/);
    assert.match(bodies[0].text, /CURRENT_WIRE_INPUT/);
    assert.match(bodies[0].text, /KEEP_SYSTEM/);
    if (protocol === "anthropic-messages") {
      assert.equal(typeof bodies[0].body.system, "string");
      assert.ok(Array.isArray(bodies[0].body.messages));
    } else {
      assert.ok(Array.isArray(bodies[0].body.systemInstruction.parts));
      assert.ok(Array.isArray(bodies[0].body.contents));
    }
  });
}

for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages", "gemini-native"]) {
  test(`${protocol} exempts trusted JPEG base64 while retaining its wire payload`, async t => {
    const base64 = Buffer.alloc(24000, 0xff).toString("base64");
    const url = "data:image/jpeg;base64," + base64;
    const input = { messages: [{ role: "user", content: [
      { type: "text", text: "Describe this prepared image" }, { type: "image_url", image_url: { url } },
    ] }], tools: [], trustedImageUrls: [url] };
    assert.equal(measureVisionRequest(input).imageBytes, 24000);
    assert.ok(measureVisionRequest(input).chars < limit);
    const { result, bodies } = await sendPrepared(t, protocol, input);
    assert.equal(result.ok, true);
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].text.length > limit);
    assert.ok(bodies[0].text.includes(base64.slice(0, 120)));
  });
}
