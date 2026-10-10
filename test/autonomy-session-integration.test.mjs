import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const temporaryParent = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, "qqfriend-autonomy-audit-"));
Object.assign(process.env, { NODE_ENV: "test", CI: "1", QQBOT_CONFIG_ROOT: path.join(root, "config"),
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  LOCALAPPDATA: root, TEMP: path.join(root, "temp"), TMP: path.join(root, "temp") });
for (const directory of ["config", "data", "logs", "temp"]) fs.mkdirSync(path.join(root, directory), { recursive: true });

const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { runScopedChat } = await import("../bridge/chat-tools/runner.mjs");
const { registeredTool, registerToolSource } = await import("../bridge/chat-tools/registry.mjs");
const { createMcpServices } = await import("../bridge/mcp/services.mjs");
const { hash } = await import("../bridge/mcp/policy.mjs");
const { getToolSettingsSnapshot, applyToolSettingsAction } = await import("../bridge/chat-tools/settings.mjs");
const { registerContextGroups, registeredContextSources, registeredContextMemorySources } = await import("../bridge/context/pruning.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { buildPreferenceContextBlock, buildMinimalPreferenceContextBlock } = await import("../bridge/user-preferences.mjs");
const { users } = await import("../bridge/storage.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { saveApiProvider } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");

after(() => {
  assert.equal(path.dirname(root), temporaryParent);
  fs.rmSync(root, { recursive: true, force: true });
});

const scope = Object.freeze({ surface: "group", groupId: "2000000001", userId: "3000000001", currentMessageId: "700000001" });
const question = "Why does the Moon look larger near the horizon?";
const rewrite = "lunar horizon apparent size illusion explanation";
const found = () => ({ status: "ok", answer: "Synthetic public lunar evidence", sources: [{ url: "https://example.com/moon", title: "Moon", snippet: "Public text" }] });
const privateResult = () => ({ status: "ok", items: [{ text: "ORCHID-71", source: { messageId: "800000001" } }], memorySources: [] });
const call = (name, args = {}, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const unpack = receipt => JSON.parse(receipt.content);
const names = session => session.definitions().map(tool => tool.function.name);

function fixture() {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const cfg = { configRoot: directory, dataRoot: directory, toolSettingsFile: path.join(directory, "tools.json"),
    mcpConfigFile: path.join(directory, "mcp.json"), memoryFile: path.join(directory, "users.json"),
    memoryProfileFile: path.join(directory, "profiles.json"), chatLogFile: path.join(directory, "groups.json"),
    groupWhitelist: [2000000001], friendWhitelist: [3000000001], botBlacklist: [], agentGroupWhitelist: [],
    agentDraftGroupWhitelist: [], agentMaterialGroupWhitelist: [], toolAutonomyEnabled: true };
  const create = options => createChatToolSession({ cfg, scope, task: "group_chat", userMessage: question, mentioned: true, ...options });
  const settings = patch => {
    const before = getToolSettingsSnapshot({ cfg });
    return applyToolSettingsAction({ action: "save", expectedRevision: before.revision, settings: { ...before.settings, ...patch } }, { cfg });
  };
  return { cfg, create, settings };
}

function privateContext() {
  const messages = [{ role: "user", content: "ORCHID-71 is an unpublished navigation prototype." }];
  registerContextGroups(messages, [{ group: "audit-private", priority: 90, index: 0,
    sources: [{ kind: "group", userId: scope.userId, messageId: "800000001" }], memorySources: [], memoryExpiresAt: null }]);
  return messages;
}

async function mcpFixture(t, { schema, result, onCall } = {}) {
  const f = fixture();
  const inputSchema = schema || { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 160 } }, required: ["query"], additionalProperties: false };
  const remote = { name: "lookup", inputSchema };
  const calls = [];
  let changed;
  const client = { connect: async () => {}, listTools: async () => ({ tools: [remote] }),
    callTool: async (params, options) => {
      calls.push({ params, options });
      if (onCall) return onCall(params, options);
      return result || { content: [{ type: "text", text: "Synthetic external data" }] };
    }, onToolsChanged: fn => { changed = fn; }, abort: async () => {} };
  const services = createMcpServices({ cfg: f.cfg, createClient: async () => client });
  t.after(() => services.close());
  const action = (actionName, fields = {}) => services.action({ action: actionName, expectedRevision: services.snapshot().revision, ...fields });
  const bindings = Object.hasOwn(inputSchema.properties, "group_id") ? { group_id: "groupId", user_id: "userId" } : {};
  const tool = { name: "lookup", label: "Audit lookup", enabled: true, mode: "read", scope: Object.keys(bindings).length ? "current" : "public",
    bindings, schemaHash: hash(inputSchema) };
  assert.equal((await action("save", { configuration: { servers: [{ id: "audit", label: "Audit", url: "https://example.test/mcp", enabled: true, tools: [tool] }] } })).ok, true);
  const connected = await action("connect", { serverId: "audit" });
  assert.equal(connected.ok, true);
  const name = connected.servers[0].tools.find(item => item.available)?.publicName;
  assert.ok(name, "approved real MCP entry must be published");
  assert.ok(registeredTool(name));
  return { ...f, services, client, calls, name, action, changed: () => changed?.() };
}

test("actual MCP service is declared and executed by an autonomous session", async t => {
  const f = await mcpFixture(t);
  const session = f.create();
  assert.ok(names(session).includes(f.name));
  const output = unpack(await session.execute(call(f.name, { query: rewrite }), session.definitions(), {}));
  assert.equal(output.status, "ok");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.name, "lookup");
  assert.equal(f.calls[0].params.arguments.query, rewrite);
  assert.ok(f.calls[0].options.signal instanceof globalThis.AbortSignal);
  assert.equal(session.snapshot().toolCalls, 1);
});

test("interjection/file_chat/explicit off and unapproved scopes cannot declare or execute MCP", async t => {
  const f = await mcpFixture(t);
  const declared = f.create().definitions();
  for (const options of [{ task: "interjection" }, { task: "file_chat" }, { allowTools: false }, { scope: { ...scope, groupId: "2000000099" } }]) {
    const session = f.create(options);
    assert.equal(names(session).includes(f.name), false);
    assert.equal(unpack(await session.execute(call(f.name, { query: rewrite }), declared, {})).status, "denied");
  }
  assert.equal(f.calls.length, 0);
});

test("registered private context blocks semantic MCP/search rewrites while current fragments still work", async t => {
  const f = await mcpFixture(t);
  let searches = 0;
  const session = f.create({ webSearchResults: async () => { searches++; return found(); } });
  const declared = session.definitions();
  session.trackContext(privateContext());
  assert.equal(unpack(await session.execute(call(f.name, { query: "unpublished wayfinding device" }), declared, {})).status, "denied");
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), declared, {})).status, "denied");
  assert.equal(unpack(await session.execute(call(f.name, { query: "Moon look larger" }), declared, {})).status, "ok");
  assert.equal(searches, 0);
  assert.equal(f.calls.length, 1);
});

test("private memory tool results taint subsequent calls and do not permit stale cached query reuse", async () => {
  const f = fixture();
  let searches = 0;
  const session = f.create({ recallMemory: privateResult, webSearchResults: async () => { searches++; return found(); } });
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), declared, {})).status, "ok");
  assert.equal(unpack(await session.execute(call("recall_memory", { query: "project" }), declared, {})).status, "ok");
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }, "cached-search"), declared, {})).status, "denied");
  assert.equal(searches, 1);
});

test("empty memory results do not taint actual session public queries", async () => {
  const f = fixture();
  let searches = 0;
  const session = f.create({ recallMemory: () => ({ status: "empty", items: [], memorySources: [] }),
    webSearchResults: async () => { searches++; return found(); } });
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call("recall_memory", { query: "project" }), declared, {})).status, "empty");
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), declared, {})).status, "ok");
  assert.equal(searches, 1);
});

test("R1 search adapter must not bypass unsafe query URL checks", async t => {
  const f = fixture();
  const sent = [];
  const session = f.create({ webSearch: async query => { sent.push(query); return "Synthetic public text"; } });
  const output = unpack(await session.execute(call("web_search", { query: "http://127.0.0.1/private" }), session.definitions(), {}));
  t.diagnostic("adapter dispatch count=" + sent.length + ", status=" + output.status);
  assert.equal(sent.length, 0, "unsafe query URL must not be dispatched through the legacy adapter");
  assert.equal(output.status, "denied");
});

test("R1 search adapter must recheck taint immediately before dispatch", async t => {
  const f = fixture();
  let searches = 0;
  const session = f.create({ webSearch: async () => { searches++; return "Synthetic public text"; } });
  const pending = session.execute(call("web_search", { query: rewrite }), session.definitions(), {});
  session.trackContext(privateContext());
  const output = unpack(await pending);
  t.diagnostic("post-taint adapter dispatch count=" + searches + ", status=" + output.status);
  assert.equal(searches, 0, "a rewrite admitted before private evidence must not be sent afterward");
  assert.equal(output.status, "denied");
});

test("R1 search adapter receives per-tool timeout cancellation, not only turn cancellation", async t => {
  const originalTimeout = globalThis.AbortSignal.timeout.bind(globalThis.AbortSignal);
  t.mock.method(globalThis.AbortSignal, "timeout", duration => originalTimeout(duration === 23000 ? 10 : duration));
  const f = fixture();
  let providedSignal;
  let finish;
  const session = f.create({ webSearch: (_query, options) => {
    providedSignal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = session.execute(call("web_search", { query: "Moon" }), session.definitions(), {});
  await delay(30);
  const output = unpack(await pending);
  finish("Late synthetic result");
  assert.equal(output.status, "unavailable");
  t.diagnostic("per-tool timeout adapter signal aborted=" + providedSignal.aborted);
  assert.equal(providedSignal.aborted, true, "underlying search must receive the per-tool timeout signal");
});

test("R1 public ref cache must not outlive its 90-second source session", async t => {
  const f = fixture();
  f.settings({ profile: "extended" });
  let time = 0;
  let reads = 0;
  const session = f.create({ now: () => time, userMessage: "read https://example.com/moon",
    readPublicPage: async url => { reads++; return { ok: true, url, response: new globalThis.Response("Synthetic page", { headers: { "content-type": "text/plain" } }) }; } });
  const declared = session.definitions();
  const ref = JSON.parse(session.sourceContext()[0].content.split("\n").at(-1))[0].source_ref;
  assert.equal(unpack(await session.execute(call("read_public_page", { source_ref: ref }), declared, {})).status, "ok");
  time = 90001;
  assert.deepEqual(session.sourceContext(), [], "source helper itself has expired");
  const output = unpack(await session.execute(call("read_public_page", { source_ref: ref }, "expired-ref"), declared, {}));
  t.diagnostic("expired cached status=" + output.status + ", physical reads=" + reads);
  assert.equal(output.status, "denied", "expired source references must not be revived by the generic cache");
  assert.equal(reads, 1);
});

test("R1 MCP auxiliary enum arguments must not export normalized protected private strings", async t => {
  const schema = { type: "object", properties: { query: { type: "string", maxLength: 160 },
    category: { type: "string", enum: ["general", "orchid-71"] } }, required: ["query", "category"], additionalProperties: false };
  const f = await mcpFixture(t, { schema });
  const session = f.create({ recallMemory: privateResult });
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call("recall_memory", { query: "project" }), declared, {})).status, "ok");
  const output = unpack(await session.execute(call(f.name, { query: "Moon", category: "orchid-71" }), declared, {}));
  t.diagnostic("protected enum remote dispatch count=" + f.calls.length + ", status=" + output.status);
  assert.equal(f.calls.length, 0, "non-query string arguments must obey normalized private-value protection too");
  assert.equal(output.status, "denied");
});

test("R1 attachment metadata provided by sourceContext must taint queries before file reads", async t => {
  const f = fixture();
  f.cfg.agentGroupWhitelist = [2000000001];
  f.cfg.agentMaterialGroupWhitelist = [2000000001];
  let searches = 0;
  await withChatRun({ surface: "group", userId: scope.userId, groupId: scope.groupId, messageId: scope.currentMessageId }, async () => {
    const session = f.create({ currentMessageId: scope.currentMessageId, attachments: [{ name: "ORCHID-71-navigation-prototype.txt", size: 40 }],
      webSearchResults: async () => { searches++; return found(); } });
    const material = session.sourceContext();
    assert.equal(material.length, 1);
    assert.match(material[0].content, /ORCHID-71/);
    session.trackContext([...material, { role: "user", content: question }]);
    const output = unpack(await session.execute(call("web_search", { query: "unpublished navigation prototype ORCHID-71" }), session.definitions(), {}));
    t.diagnostic("attachment-metadata search dispatch count=" + searches + ", status=" + output.status);
    assert.equal(searches, 0, "model-visible private file metadata must not remain public-only");
    assert.equal(output.status, "denied");
  }, { cfg: f.cfg, ledger: { claim: () => ({ ok: true, key: "audit" }), finish() {} } });
});

test("MCP current-scope identities are bound by backend and cannot be provided by model", async t => {
  const schema = { type: "object", properties: { query: { type: "string", maxLength: 160 }, group_id: { type: "string" }, user_id: { type: "string" } },
    required: ["query", "group_id", "user_id"], additionalProperties: false };
  const f = await mcpFixture(t, { schema });
  const session = f.create();
  const declared = session.definitions();
  const definition = declared.find(item => item.function.name === f.name);
  assert.equal(Object.hasOwn(definition.function.parameters.properties, "user_id"), false);
  assert.equal(unpack(await session.execute(call(f.name, { query: "Moon", user_id: "3999999999" }), declared, {})).status, "invalid_arguments");
  assert.equal(unpack(await session.execute(call(f.name, { query: "Moon" }), declared, {})).status, "ok");
  assert.deepEqual(f.calls[0].params.arguments, { query: "Moon", group_id: scope.groupId, user_id: scope.userId });
});

test("network veto prevents declaration/execution of an otherwise approved zero-argument MCP tool", async t => {
  const f = await mcpFixture(t, { schema: { type: "object", properties: {}, additionalProperties: false } });
  const declared = f.create().definitions();
  assert.ok(declared.some(entry => entry.function.name === f.name));
  for (const veto of ["do not browse", "\u4e0d\u8981\u8054\u7f51"]) {
    const session = f.create({ userMessage: question + "; " + veto });
    assert.equal(names(session).includes(f.name), false);
    assert.equal(unpack(await session.execute(call(f.name), declared, {})).status, "denied");
  }
  assert.equal(f.calls.length, 0);
});

test("MCP same-query repeat rechecks private evidence instead of using the session cache", async t => {
  const f = await mcpFixture(t);
  const session = f.create();
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call(f.name, { query: rewrite }), declared, {})).status, "ok");
  session.trackContext(privateContext());
  const repeat = unpack(await session.execute(call(f.name, { query: rewrite }, "after-private"), declared, {}));
  assert.equal(repeat.status, "denied");
  assert.equal(f.calls.length, 1);
});

test("dynamic MCP permission denial blocks cached reuse before execution", async t => {
  const f = await mcpFixture(t);
  let permitted = true;
  const session = f.create({ isMcpPermitted: () => permitted });
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call(f.name, { query: "Moon" }), declared, {})).status, "ok");
  permitted = false;
  assert.equal(names(session).includes(f.name), false);
  assert.equal(unpack(await session.execute(call(f.name, { query: "Moon" }, "cached"), declared, {})).status, "denied");
  assert.equal(f.calls.length, 1);
});

test("MCP disconnection/schema invalidation stops old-session cached entries", async t => {
  const f = await mcpFixture(t);
  const session = f.create();
  const declared = session.definitions();
  await session.execute(call(f.name, { query: "Moon" }), declared, {});
  await f.action("disconnect", { serverId: "audit" });
  await assert.rejects(session.execute(call(f.name, { query: "Moon" }, "stale"), declared, {}), /tool_configuration_changed/);
  assert.equal(f.calls.length, 1);
  assert.equal(names(f.create()).includes(f.name), false);
});

test("noncooperative remote MCP calls are cancelled and cannot become cached success", async t => {
  let started;
  let finish;
  const remoteStarted = new Promise(resolve => { started = resolve; });
  const f = await mcpFixture(t, { onCall: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const controller = new globalThis.AbortController();
  const session = f.create({ signal: controller.signal });
  const declared = session.definitions();
  const pending = session.execute(call(f.name, { query: "Moon" }), declared, {});
  await remoteStarted;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finish({ content: [{ type: "text", text: "Late response must not be accepted" }] });
  await assert.rejects(session.execute(call(f.name, { query: "Moon" }, "after-cancel"), declared, {}));
  assert.equal(f.calls.length, 1);
});

test("MCP calls share the actual global tool-call budget without session cache reuse", async t => {
  const f = await mcpFixture(t);
  const session = f.create();
  const declared = session.definitions();
  for (let index = 0; index < session.limits.toolCalls; index++)
    assert.equal(unpack(await session.execute(call(f.name, { query: "Moon" }, "repeat-" + index), declared, {})).status, "ok");
  assert.equal(session.snapshot().toolCalls, 4);
  assert.equal(f.calls.length, 4, "each MCP call must pass service checks rather than reuse a session cache");
  await assert.rejects(session.execute(call(f.name, { query: "Moon" }, "over-budget"), declared, {}), /tool_budget/);
  assert.deepEqual(session.definitions(), []);
});

test("saving autonomy settings invalidates existing cached sessions and new passive sessions stay off", async () => {
  const f = fixture();
  const session = f.create();
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call("calculate", { expression: "6*7" }), declared, {})).result, 42);
  f.settings({ autonomyEnabled: false });
  await assert.rejects(session.execute(call("calculate", { expression: "6*7" }, "cached"), declared, {}), /tool_configuration_changed/);
  assert.deepEqual(f.create({ task: "interjection" }).definitions(), []);
});

test("memory privacy revocation invalidates actual session cached public evidence", async () => {
  const f = fixture();
  const session = f.create({ webSearchResults: async () => found() });
  const declared = session.definitions();
  await session.execute(call("web_search", { query: "Moon" }), declared, {});
  invalidateMemoryPrivacyGeneration();
  await assert.rejects(session.execute(call("web_search", { query: "Moon" }, "cached"), declared, {}), /privacy_changed/);
});

test("runner declares a real MCP capability and consumes native model/tool continuation budgets", async t => {
  const f = await mcpFixture(t);
  saveApiProvider({ id: "audit-native", protocol: "openai-chat", presetId: "custom-openai-chat", auth: "none", model: "synthetic-audit",
    endpoint: "https://example.com/audit-provider", capabilities: ["text", "tools"], enabled: true }, { root: process.env.QQBOT_CONFIG_ROOT });
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://example.com/audit-provider");
    const body = JSON.parse(options.body);
    attempts++;
    const message = attempts === 1 ? { content: null, tool_calls: [call(f.name, { query: rewrite }, "native-mcp")] } : { content: "Synthetic final reply" };
    if (attempts === 1) assert.ok(body.tools.some(tool => tool.function.name === f.name));
    else assert.equal(JSON.parse(body.messages.find(item => item.role === "tool").content).status, "ok");
    return new globalThis.Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
  });
  const session = f.create();
  const outcome = await runScopedChat({ messages: [{ role: "system", content: "Use tools as needed." }, { role: "user", content: question }], selfContext: scope, maxTokens: 128 },
    { providerId: "audit-native", task: "group_chat", userMessage: question, toolSession: session, allowTools: true });
  assert.equal(outcome.kind, "reply");
  assert.equal(attempts, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(session.snapshot().modelRounds, 2);
  assert.equal(session.snapshot().transportAttempts, 2);
  assert.equal(session.snapshot().toolCalls, 1);
});

test("real primary/fallback caller shares one session without resetting budgets", async () => {
  let shared;
  const request = { userMsg: question, groupId: scope.groupId, isAtMe: true, history: [], imageUrls: [], options: { currentUserId: scope.userId, allowTools: true } };
  const outcome = await executeChatTask(request, {
    primaryChat: async input => {
      shared = input.options.toolSession;
      for (let index = 0; index < 2; index++) {
        const prepared = shared.prepareModel({ messages: [{ role: "user", content: question }], maxTokens: 128 });
        assert.equal(prepared.beforeAttempt(), "");
      }
      return { kind: "error", text: null, reason: "synthetic" };
    }, fallbackChat: async input => {
      assert.equal(input.options.toolSession, shared);
      assert.equal(shared.remainingModels(), 2);
      const prepared = shared.prepareModel({ messages: [{ role: "user", content: question }], maxTokens: 128 });
      assert.equal(prepared.beforeAttempt(), "");
      return { kind: "reply", text: "Synthetic fallback" };
    },
  });
  assert.equal(outcome.kind, "reply");
  assert.equal(shared.snapshot().modelRounds, 3);
  assert.equal(shared.snapshot().transportAttempts, 3);
});

test("real file-chat caller creates network-disabled scope policy for both slots", async () => {
  let shared;
  const outcome = await executePrivateChatTask({ task: "file_chat", userMsg: question, history: [], options: { currentUserId: scope.userId, allowTools: true } }, {
    callSlot: async input => {
      shared ||= input.options.toolSession;
      assert.equal(input.options.toolSession, shared);
      assert.equal(shared.policy.network, false);
      assert.equal(names(shared).includes("web_search"), false);
      return input.position === "primary" ? { kind: "error", text: null, reason: "synthetic" } : { kind: "reply", text: "Synthetic file reply" };
    },
  });
  assert.equal(outcome.kind, "reply");
});

test("real interjection caller enables local tools but never network tools in either slot", async () => {
  let shared;
  const outcome = await executeChatTask({ userMsg: question, groupId: scope.groupId, isAtMe: false, history: [], imageUrls: [],
    options: { currentUserId: scope.userId, allowTools: true, replyMode: "interjection" } }, {
    primaryChat: async input => {
      shared = input.options.toolSession;
      assert.equal(shared.policy.network, false);
      assert.equal(shared.limits.toolCalls, 2);
      assert.deepEqual(names(shared), ["recall_memory", "read_bot_status", "calculate"]);
      assert.equal(unpack(await shared.execute(call("calculate", { expression: "6*7" }), shared.definitions(), {})).result, 42);
      return { kind: "error", text: null, reason: "synthetic" };
    }, interjectionFallback: async input => {
      assert.equal(input.options.toolSession, shared);
      assert.equal(shared.remainingTools(), 1);
      assert.equal(names(shared).includes("web_search"), false);
      return { kind: "reply", text: "Synthetic passive reply" };
    },
  });
  assert.equal(outcome.kind, "reply");
});

test("actual prepareModel sees media provenance before allowing a public-query continuation", async () => {
  const f = fixture();
  let searches = 0;
  const session = f.create({ webSearchResults: async () => { searches++; return found(); } });
  const image = "data:image/jpeg;base64,AAAA";
  session.prepareModel({ messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: image } }] }],
    trustedImageUrls: [image] });
  const declared = session.definitions();
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), declared, {})).status, "denied");
  assert.equal(unpack(await session.execute(call("web_search", { query: "Moon look larger" }), declared, {})).status, "ok");
  assert.equal(searches, 1);
});

test("real full/minimal preference layers taint actual session without fake note dependencies", async t => {
  const original = Object.getOwnPropertyDescriptor(users, scope.userId);
  users[scope.userId] = { chats: [], preferences: { displayName: "ORCHID-71", style: { tone: "technical", updatedAt: 1 } } };
  t.after(() => { if (original) Object.defineProperty(users, scope.userId, original); else delete users[scope.userId]; });
  for (const mode of ["group-at", "interjection"]) {
    const block = mode === "interjection" ? buildMinimalPreferenceContextBlock(scope.userId) : buildPreferenceContextBlock(scope.userId);
    assert.ok(block);
    const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userName: "Synthetic", userMsg: question,
      currentMessageId: scope.currentMessageId, mode });
    assert.ok(packet.messages.some(message => message.content === block), "actual preference builder output must reach the retained packet");
    assert.equal(registeredContextMemorySources(packet.messages).length, 0, "a preference is not an explicit note dependency");
    const sources = registeredContextSources(packet.messages);
    assert.ok(sources.some(source => source.kind === "memory" && source.reason === "personal_preferences" && source.userId === scope.userId));
    const f = fixture();
    let searches = 0;
    const session = f.create({ webSearchResults: async () => { searches++; return found(); } });
    session.trackContext(packet.messages);
    assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), session.definitions(), {})).status, "denied");
    assert.equal(unpack(await session.execute(call("web_search", { query: "Moon look larger" }), session.definitions(), {})).status, "ok");
    assert.equal(searches, 1);
  }
});

test("nested primary/fallback model calls share actual session budget and preserve final-round reserve", async () => {
  const f = fixture();
  f.cfg.agentGroupWhitelist = [2000000001]; f.cfg.agentDraftGroupWhitelist = [2000000001];
  const positions = [];
  const session = f.create({ currentMessageId: scope.currentMessageId,
    callNestedModel: async (_task, position, prepared) => {
      positions.push(position);
      assert.equal(prepared.beforeAttempt(), "");
      return { ok: true, raw: { choices: [{ message: { content: "Synthetic draft" } }] } };
    }, draftTaskService: { initialReferences: () => [], generate: async (_args, runtime) => {
      for (const position of ["primary", "fallback", "primary"]) await runtime.callModel("group_summary", position, { messages: [{ role: "user", content: "Synthetic draft input" }] }, {});
      await assert.rejects(runtime.callModel("group_summary", "fallback", { messages: [{ role: "user", content: "Over budget" }] }, {}), /tool_budget/);
      return { status: "ok", text: "Synthetic private draft" };
    } } });
  const output = unpack(await session.execute(call("draft_chat_summary", { kind: "daily" }), session.definitions(), {}));
  assert.equal(output.status, "ok");
  assert.deepEqual(positions, ["primary", "fallback", "primary"]);
  assert.equal(session.snapshot().modelRounds, 3);
  assert.equal(session.snapshot().transportAttempts, 3);
  const final = session.prepareModel({ messages: [{ role: "user", content: question }] });
  assert.equal(final.beforeAttempt(), "");
  assert.equal(session.remainingModels(), 0);
});

test("mentioned identities without topic history are private provenance, not public-query material", async t => {
  const target = "3000000002";
  const original = Object.getOwnPropertyDescriptor(users, target);
  users[target] = { name: "ORCHID-71", chats: [] };
  t.after(() => { if (original) Object.defineProperty(users, target, original); else delete users[target]; });
  const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userName: "Synthetic", userMsg: question,
    currentMessageId: scope.currentMessageId, mode: "group-at", mentions: [{ qq: target, name: "ORCHID-71", isBot: false, isAll: false }] });
  assert.ok(registeredContextSources(packet.messages).some(source => source.reason === "mentioned_identity" && source.userId === target));
  assert.equal(registeredContextMemorySources(packet.messages).length, 0);
  const f = fixture(); let searches = 0;
  const session = f.create({ webSearchResults: async () => { searches++; return found(); } });
  session.trackContext(packet.messages);
  assert.equal(unpack(await session.execute(call("web_search", { query: "ORCHID-71 lunar research" }), session.definitions(), {})).status, "denied");
  assert.equal(unpack(await session.execute(call("web_search", { query: "Moon look larger" }), session.definitions(), {})).status, "ok");
  assert.equal(searches, 1);
});

test("registry source revocation prevents execution of a formerly declared capability", async t => {
  const dispose = registerToolSource("audit_external", { entries: () => [{ label: "Synthetic", mode: "read", access: "mcp_read", timeoutMs: 1000, resultChars: 1000,
    definition: { type: "function", function: { name: "mcp_audit_external", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    validateArguments: () => true, available: () => true, execute: () => assert.fail("revoked source must not run") }] });
  t.after(dispose);
  const session = fixture().create();
  const declared = session.definitions();
  assert.ok(names(session).includes("mcp_audit_external"));
  dispose();
  await assert.rejects(session.execute(call("mcp_audit_external"), declared, {}), /tool_configuration_changed/);
});

test("backend speaker display names are protected without blocking a fresh public-question rewrite", async () => {
  const f = fixture(); let searches = 0;
  const session = f.create({ userName: "ProjectZephyrAlias", webSearchResults: async () => { searches++; return found(); } });
  assert.equal(unpack(await session.execute(call("web_search", { query: "ProjectZephyrAlias" }), session.definitions(), {})).status, "denied");
  assert.equal(unpack(await session.execute(call("web_search", { query: rewrite }), session.definitions(), {})).status, "ok");
  assert.equal(searches, 1);
});

test("text-only vision descriptions retain private provenance before native search decisions", async t => {
  const f = fixture(); let searches = 0, attempts = 0;
  saveApiProvider({ id: "audit-vision-text", protocol: "openai-chat", presetId: "custom-openai-chat", auth: "none", model: "synthetic-vision-text",
    endpoint: "https://example.com/audit-vision-text", capabilities: ["text", "tools"], enabled: true }, { root: process.env.QQBOT_CONFIG_ROOT });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); attempts++;
    if (attempts === 2) assert.equal(JSON.parse(body.messages.find(message => message.role === "tool").content).status, "denied");
    const message = attempts === 1 ? { content: null, tool_calls: [call("web_search", { query: rewrite }, "vision-query")] } : { content: "Synthetic scoped answer" };
    return new globalThis.Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
  });
  const session = f.create({ webSearchResults: async () => { searches++; return found(); } });
  const outcome = await runScopedChat({ messages: [{ role: "user", content: question }], selfContext: scope },
    { providerId: "audit-vision-text", task: "group_chat", userMessage: question, toolSession: session, imagePolicy: "evidence-v5",
      visionSession: { message: async () => ({ message: { role: "user", content: "Private image description ORCHID-71" }, trustedImageUrls: [] }) } });
  assert.equal(outcome.kind, "reply"); assert.equal(searches, 0); assert.equal(attempts, 2);
});

test("light primary tool loop keeps a fallback model round and two transport attempts", async t => {
  const f = fixture();
  for (const id of ["audit-light-primary", "audit-light-fallback"]) saveApiProvider({ id, protocol: "openai-chat", presetId: "custom-openai-chat",
    auth: "none", model: id, endpoint: "https://example.com/" + id, capabilities: ["text", "tools"], enabled: true }, { root: process.env.QQBOT_CONFIG_ROOT });
  const session = f.create({ task: "interjection" }); let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    attempts++;
    const body = JSON.parse(options.body);
    assert.equal(String(url), "https://example.com/" + (attempts <= 4 ? "audit-light-primary" : "audit-light-fallback"));
    if ([1, 3, 4, 5].includes(attempts)) return new globalThis.Response("temporary error", { status: 503 });
    const message = attempts === 2 ? { content: null, tool_calls: [call("calculate", { expression: "6*7" }, "local-calc")] } : { content: "Fallback computed 42" };
    if (attempts === 6) assert.ok(body.messages.some(item => item.content?.includes('"result":42')));
    return new globalThis.Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
  });
  const request = { messages: [{ role: "user", content: question }], selfContext: scope };
  const primary = await runScopedChat(request, { providerId: "audit-light-primary", task: "interjection", userMessage: question, toolSession: session });
  assert.equal(primary.kind, "error");
  const fallback = await runScopedChat(request, { providerId: "audit-light-fallback", position: "fallback", task: "interjection", userMessage: question, toolSession: session });
  assert.equal(fallback.kind, "reply"); assert.equal(attempts, 6);
  assert.equal(session.snapshot().modelRounds, 3); assert.equal(session.snapshot().transportAttempts, 6);
});
