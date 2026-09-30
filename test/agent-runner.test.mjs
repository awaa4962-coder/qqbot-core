import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-agent-runner-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { saveApiProvider } = await import("../bridge/api-providers/store.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { runScopedChat } = await import("../bridge/chat-tools/runner.mjs");
after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});
Object.assign(CFG, { groupWhitelist: [50100], friendWhitelist: [60100], agentGroupWhitelist: [50100], botBlacklist: [] });
const scope = { surface: "group", groupId: "50100", userId: "60100" };
saveApiProvider({ id: "agent-native", protocol: "openai-chat", presetId: "custom-openai-chat", auth: "none",
  model: "agent-fixture", endpoint: "https://example.com/agent", capabilities: ["text", "tools"], enabled: true }, { root });

const toolCall = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const modelResponse = message => new globalThis.Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
const invoke = (session, question, position = "primary") => runScopedChat({ messages: [{ role: "system", content: "Use tools only when needed." },
  { role: "user", content: question }], selfContext: scope, maxTokens: 128, temperature: 0 },
{ providerId: "agent-native", task: "group_chat", position, mentioned: true, userMessage: question, toolSession: session });

test("native calculation roundtrip consumes exactly two model rounds and returns no private reasoning", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) return modelResponse({ content: null, reasoning_content: "PRIVATE_REASONING",
      tool_calls: [toolCall("calculate", { expression: "21*2" }, "calc")] });
    assert.equal(JSON.parse(body.messages.find(message => message.role === "tool").content).result, 42);
    return modelResponse({ content: "结果是42。", reasoning_content: "PRIVATE_REASONING" });
  });
  const question = "计算21*2";
  const session = createChatToolSession({ scope, cfg: CFG, task: "group_chat", mentioned: true, userMessage: question });
  const outcome = await invoke(session, question);
  assert.equal(outcome.kind, "reply");
  assert.equal(outcome.text, "结果是42。");
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_REASONING/);
  assert.equal(bodies.length, 2);
  assert.equal(session.snapshot().modelRounds, 2);
  assert.equal(session.snapshot().transportAttempts, 2);
  assert.equal(session.snapshot().toolCalls, 1);
  assert.ok(bodies[0].tools.some(entry => entry.function.name === "calculate"));
});

test("search then source read reaches the same provider's final round with bounded untrusted evidence", async t => {
  const bodies = [];
  const question = "搜索 Debian release";
  const session = createChatToolSession({ scope, cfg: CFG, task: "group_chat", mentioned: true, userMessage: question,
    webSearchResults: async () => ({ status: "ok", sources: [{ url: "https://example.com/release", title: "Release", snippet: "Version details" }] }),
    readPublicPage: async url => ({ ok: true, url: new globalThis.URL(url),
      response: new globalThis.Response("Confirmed synthetic version 12", { headers: { "content-type": "text/plain" } }) }) });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) return modelResponse({ content: null, tool_calls: [toolCall("web_search", { query: "Debian release" }, "search")] });
    if (bodies.length === 2) {
      const source = JSON.parse(body.messages.find(message => message.role === "tool").content).sources[0];
      return modelResponse({ content: null, tool_calls: [toolCall("read_public_page", { source_ref: source.source_ref }, "read")] });
    }
    const evidence = JSON.parse(body.messages.filter(message => message.role === "tool").at(-1).content);
    assert.equal(evidence.untrusted, true);
    assert.equal(evidence.coverage, "excerpt");
    assert.equal(body.tool_choice, undefined);
    assert.ok(!body.tools?.length);
    return modelResponse({ content: "节选显示合成版本12。https://example.com/release" });
  });
  const outcome = await invoke(session, question);
  assert.equal(outcome.kind, "reply");
  assert.equal(bodies.length, 3);
  assert.equal(session.snapshot().modelRounds, 3);
  assert.equal(session.snapshot().toolCalls, 2);
  assert.equal(session.remainingModels(), 1);
});

test("fallback regenerates a final answer with shared evidence but cannot gain a new budget", async t => {
  const question = "计算21*2";
  const session = createChatToolSession({ scope, cfg: CFG, task: "group_chat", mentioned: true, userMessage: question });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length < 3) return modelResponse({ content: null, reasoning_content: "PRIMARY_PRIVATE",
      tool_calls: [toolCall("calculate", { expression: "21*2" }, `calc-${calls.length}`)] });
    if (calls.length === 3) return modelResponse({ content: "" });
    assert.doesNotMatch(JSON.stringify(body), /PRIMARY_PRIVATE/);
    assert.match(JSON.stringify(body), /calculate/);
    assert.equal(body.tool_choice, undefined);
    return modelResponse({ content: "结果是42。" });
  });
  assert.equal((await invoke(session, question)).kind, "error");
  assert.equal((await invoke(session, question, "fallback")).kind, "reply");
  assert.equal(calls.length, 4);
  assert.equal(session.remainingModels(), 0);
  assert.equal(session.snapshot().toolCalls, 2);
  assert.equal((await invoke(session, question, "fallback")).kind, "error");
  assert.equal(calls.length, 4);
});
