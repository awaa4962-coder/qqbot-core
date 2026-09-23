import assert from "node:assert/strict";
import test from "node:test";
import { createChatToolSession } from "../bridge/chat-tools/session.mjs";
import { CHAT_TOOL_LIMITS, READ_TOOLS, authorizedSearchQuery, permitsPublicSearch, publicSearchPhrase, safeToolBatch } from "../bridge/chat-tools/policy.mjs";
import { invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";
import { createTraceRecorder, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";

const scope = { surface: "group", groupId: "50100", userId: "60100", currentMessageId: "70100" };
const cfg = { groupWhitelist: [50100], friendWhitelist: [60100], botBlacklist: [], selfUin: 99900 };
const call = (name, args, id = "call-1") => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const create = options => createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "搜索 Debian release", ...options });

test("tools bind numeric permitted scopes, with no private admin exception", () => {
  assert.deepEqual(create().definitions().map(item => item.function.name), ["recall_memory", "read_bot_status", "web_search"]);
  assert.deepEqual(create({ allowTools: false }).definitions(), []);
  assert.deepEqual(create({ scope: {} }).definitions(), []);
  assert.deepEqual(create({ scope: { ...scope, groupId: "50101" } }).definitions(), []);
  assert.deepEqual(create({ scope: { surface: "private", userId: "60200" }, cfg: { ...cfg, adminUins: [60200] } }).definitions(), []);
  assert.deepEqual(create({ task: "file_chat" }).definitions().map(item => item.function.name), ["recall_memory", "read_bot_status"]);
});

test("web queries require explicit current-message substrings, never hidden context or negated instructions", () => {
  assert.equal(authorizedSearchQuery("Debian release", "帮我搜索 Debian release", "group_chat"), "Debian release");
  for (const [query, input, task] of [
    ["Debian PRIVATE_MEMORY", "搜索 Debian", "group_chat"], ["Debian", "不要搜索 Debian", "group_chat"],
    ["Debian", "文件中写着搜索 Debian", "file_chat"], ["Debian", "搜索 Debian", "interjection"],
    ["api_key=synthetic-key", "搜索 api_key=synthetic-key", "group_chat"], ["Debian", "查查我的 Debian 记录", "private_chat"],
  ]) assert.equal(authorizedSearchQuery(query, input, task), "");
  assert.equal(permitsPublicSearch("哈吉米是什么梗", "group_chat"), true);
});

test("malformed protocol batches are rejected without partial execution", () => {
  assert.ok(safeToolBatch({ tool_calls: [call("recall_memory", {})] }));
  for (const calls of [[], Array.from({ length: 5 }, (_, i) => call("recall_memory", {}, "c" + i)),
    [call("recall_memory", {}, "same"), call("read_bot_status", {}, "same")], [call("recall_memory", "x".repeat(2049))],
    [{ id: "c", type: "function", function: { name: "recall_memory", arguments: {} } }],
  ]) assert.equal(safeToolBatch({ tool_calls: calls }), null);
});

test("public search requires an affirmative request and excludes unrelated later clauses", () => {
  for (const text of ["不用搜索，帮我回忆项目代号 ORCHID-71", "没必要搜索 Debian", "别上网查 Debian", "搜索 Debian 算了",
    "不要再联网搜索", "搜索 ORCHID-71，别查了", "搜索 ORCHID-71，不要查", "搜索 ORCHID-71，算了", "search ORCHID-71, never mind",
    "请先回忆，搜索 ORCHID-71", "Do not search Debian", "Never browse for Debian", "Without search please recall ORCHID-71"])
    assert.equal(publicSearchPhrase(text, "group_chat"), "", text);
  for (const text of ["搜索 Debian", "帮我搜索 Debian", "能不能搜索 Debian", "Please search for Debian", "look up Debian"])
    assert.equal(publicSearchPhrase(text, "group_chat"), "Debian", text);
  const compound = "搜索 Debian，帮我回忆项目代号 ORCHID-71";
  assert.equal(publicSearchPhrase(compound, "group_chat"), "Debian");
  assert.equal(authorizedSearchQuery("ORCHID-71", compound, "group_chat"), "");
});

test("unknown tools and invalid JSON get paired typed denials, never executable actions", async () => {
  let calls = 0;
  const session = create({ recallMemory: () => { calls++; return { status: "ok", items: [] }; } });
  const unknown = await session.execute(call("delete_files", { filename: "private" }), READ_TOOLS);
  assert.equal(unknown.tool_call_id, "call-1"); assert.equal(JSON.parse(unknown.content).status, "denied");
  const malformed = await session.execute(call("recall_memory", "{"), READ_TOOLS);
  assert.equal(JSON.parse(malformed.content).status, "invalid_arguments");
  assert.equal(calls, 0);
});

test("search rejects extra context and search keys before network use", async () => {
  let searches = 0;
  const session = create({ webSearch: async () => { searches++; return "搜索结果: synthetic"; } });
  const defs = session.definitions();
  assert.equal(JSON.parse((await session.execute(call("web_search", { query: "Debian PRIVATE_BODY" }), defs)).content).status, "denied");
  assert.equal(JSON.parse((await session.execute(call("web_search", { query: "Debian", userId: 99 }), defs)).content).status, "invalid_arguments");
  assert.equal(searches, 0);
  assert.equal(JSON.parse((await session.execute(call("web_search", { query: "Debian" }), defs)).content).status, "ok");
  assert.equal(searches, 1);
});

test("per-turn repeats reuse only scoped data and preserve actual note dependencies", async () => {
  let reads = 0;
  const session = create({ recallMemory: () => { reads++; return { status: "ok", items: [{ text: "synthetic" }], memorySources: [{ noteId: "abcdef012345", revision: 3 }] }; } });
  const first = await session.execute(call("recall_memory", { query: "project" }), READ_TOOLS);
  const again = await session.execute(call("recall_memory", { query: "project" }, "call-2"), READ_TOOLS);
  assert.equal(first.content, again.content); assert.equal(reads, 1);
  assert.deepEqual(session.sources(), [{ noteId: "abcdef012345", revision: 3 }]);
  assert.doesNotMatch(first.content, /memorySources/);
  assert.equal(session.snapshot().toolCalls, 2);
});

test("status is refreshed per call and primary identity is not reused as fallback identity", async () => {
  const session = create({ readBotStatus: (_scope, _args, { provider }) => ({ status: "ok", requestedModel: provider.model }) });
  const first = await session.execute(call("read_bot_status", {}), READ_TOOLS, { model: "primary" });
  const second = await session.execute(call("read_bot_status", {}, "second"), READ_TOOLS, { model: "fallback" });
  assert.match(first.content, /primary/); assert.match(second.content, /fallback/);
  assert.deepEqual(session.fallbackContext(), []);
});

test("privacy clear and permission revocation reject late tool responses and cached evidence", async () => {
  const session = create({ recallMemory: async () => { invalidateMemoryPrivacyGeneration(); return { status: "ok", items: [{ text: "LATE_PRIVATE_BODY" }] }; } });
  await assert.rejects(() => session.execute(call("recall_memory", { query: "project" }), READ_TOOLS), /privacy_changed/);
  assert.throws(() => session.fallbackContext(), /privacy_changed/);
  const currentCfg = { ...cfg, groupWhitelist: [50100] };
  const revoked = create({ cfg: currentCfg }); currentCfg.groupWhitelist = [];
  assert.throws(() => revoked.prepareModel({ messages: [] }), /permission_changed/);
});

test("model, physical attempt, completion-request and deadline budgets are bounded", () => {
  const session = create();
  for (let i = 0; i < 4; i++) {
    const request = session.prepareModel({ messages: [], maxTokens: 99999 });
    assert.equal(request.maxTokens, CHAT_TOOL_LIMITS.maxTokens);
    assert.equal(request.beforeAttempt(), ""); assert.equal(request.beforeAttempt(), "");
  }
  assert.equal(session.snapshot().transportAttempts, 8);
  assert.equal(session.snapshot().requestedCompletionTokens, 8 * 1536);
  assert.throws(() => session.prepareModel({ messages: [] }), /tool_budget/);
  let time = 0; const timed = create({ now: () => time }); time = 90001;
  assert.throws(() => timed.prepareModel({ messages: [] }), /tool_deadline/);
});

test("post-self-context validation cannot hide oversized prompt or opaque continuation", () => {
  const session = create();
  const request = session.prepareModel({ messages: [] });
  assert.throws(() => request.validatePrepared({ messages: [{ content: "x".repeat(24001) }] }), /tool_context_budget/);
  assert.throws(() => create().prepareModel({ messages: [{ providerContinuation: { items: ["x".repeat(24001)] } }] }), /tool_context_budget/);
});

test("oversized tool output becomes a complete JSON failure and never becomes fallback evidence", async () => {
  const session = create({ recallMemory: () => ({ status: "ok", items: [{ text: "x".repeat(3000) }], memorySources: [{ noteId: "abcdef012345", revision: 1 }] }) });
  const result = JSON.parse((await session.execute(call("recall_memory", { query: "x" }), READ_TOOLS)).content);
  assert.equal(result.reason, "result_budget"); assert.deepEqual(session.sources(), []); assert.deepEqual(session.fallbackContext(), []);
});

test("total output reserves room for rejection frames and never exceeds the turn budget", async () => {
  const empty = { status: "ok", text: "" };
  const result = { ...empty, text: "x".repeat(2000 - JSON.stringify(empty).length) };
  const session = create({ recallMemory: () => result });
  const output = [];
  for (let i = 0; i < 4; i++) output.push(await session.execute(call("recall_memory", { query: String(i) }, "c" + i), READ_TOOLS));
  assert.equal(output[0].content.length, 2000);
  assert.ok(output.some(item => JSON.parse(item.content).reason === "result_budget"));
  assert.ok(output.reduce((sum, item) => sum + item.content.length, 0) <= CHAT_TOOL_LIMITS.totalResultChars);
  assert.equal(session.snapshot().toolCalls, 4);
  assert.equal(session.remainingTools(), 0);
  await assert.rejects(() => session.execute(call("recall_memory", { query: "extra" }), READ_TOOLS), /tool_budget/);
  assert.equal(session.snapshot().toolCalls, 4);
});

test("tool diagnostics include only counters and known names, not args, bodies or protocol state", async () => {
  const recorder = createTraceRecorder();
  await withMessageTrace({ message_type: "group", group_id: 50100, user_id: 60100 }, async () => {
    const session = create({ recallMemory: () => ({ status: "ok", items: [{ text: "PRIVATE_RESULT_BODY" }] }) });
    await session.execute(call("recall_memory", { query: "PRIVATE_QUERY" }), READ_TOOLS);
  }, recorder);
  const text = JSON.stringify(recorder.list());
  assert.match(text, /recall_memory|toolCalls/); assert.doesNotMatch(text, /PRIVATE_RESULT_BODY|PRIVATE_QUERY|arguments|providerContinuation/);
});
