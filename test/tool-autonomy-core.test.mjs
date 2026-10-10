import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveToolLimits, CHAT_TOOL_LIMITS } from "../bridge/chat-tools/limits.mjs";
import { applyToolSettingsAction, getToolSettingsSnapshot } from "../bridge/chat-tools/settings.mjs";
import { registerToolSource, registeredTool, registeredTools, getToolSourceRevision } from "../bridge/chat-tools/registry.mjs";
import { createChatToolSession } from "../bridge/chat-tools/session.mjs";

const scope = { surface: "group", groupId: "50117", userId: "60117" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-autonomy-core-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { groupWhitelist: [50117], friendWhitelist: [60117], botBlacklist: [],
    agentGroupWhitelist: [], toolAutonomyEnabled: true, toolSettingsFile: path.join(root, "tools.json") };
  return { root, cfg };
}
const call = (name, args = {}) => ({ id: "synthetic-" + name, type: "function",
  function: { name, arguments: JSON.stringify(args) } });
const names = session => session.definitions().map(tool => tool.function.name);
const result = receipt => JSON.parse(receipt.content);

test("standard proof defaults stay unchanged while extended and light budgets are independent", () => {
  assert.deepEqual(resolveToolLimits(), CHAT_TOOL_LIMITS);
  assert.equal(resolveToolLimits("extended").toolCalls, 12);
  assert.equal(resolveToolLimits("light").modelRounds, 3);
  assert.equal(resolveToolLimits("standard", { modelRounds: 6, transportAttempts: 12 }).slotRounds, 5);
  for (const overrides of [{ toString: 4 }, { toolCalls: 0 }, { modelRounds: 99 },
    { modelRounds: 6, transportAttempts: 4 }, { modelRounds: 2 }, { slotRounds: 4 }, { transportAttempts: 7 }, { totalResultChars: 1000 }]) {
    assert.throws(() => resolveToolLimits("standard", overrides), /tool_limits_invalid/);
  }
  assert.throws(() => resolveToolLimits("other"), /tool_profile_invalid/);
});

test("tool settings use durable CAS and reject stale or unknown fields", t => {
  const { cfg } = fixture(t);
  const before = getToolSettingsSnapshot({ cfg });
  const saved = applyToolSettingsAction({ action: "save", expectedRevision: before.revision,
    settings: { ...before.settings, profile: "extended" } }, { cfg });
  assert.equal(saved.effective.chat.toolCalls, 12);
  assert.equal(saved.effective.interjection.toolCalls, 2);
  assert.equal(JSON.parse(fs.readFileSync(cfg.toolSettingsFile, "utf8")).profile, "extended");
  assert.throws(() => applyToolSettingsAction({ action: "save", expectedRevision: before.revision,
    settings: before.settings }, { cfg }), /tool_settings_conflict/);
  assert.throws(() => applyToolSettingsAction({ action: "save", expectedRevision: saved.revision,
    settings: { ...saved.settings, arbitrary: true } }, { cfg }), /tool_settings_invalid/);
});

test("damaged settings are not silently replaced with defaults", t => {
  const { cfg } = fixture(t);
  fs.writeFileSync(cfg.toolSettingsFile, "{broken", "utf8");
  assert.throws(() => getToolSettingsSnapshot({ cfg }), /tool_settings_unavailable/);
  assert.throws(() => applyToolSettingsAction({ action: "save", expectedRevision: "unknown", settings: {} }, { cfg }), /tool_settings_unavailable/);
  assert.equal(fs.readFileSync(cfg.toolSettingsFile, "utf8"), "{broken");
});

test("ordinary natural language sees available local and public tools without fixed keywords", t => {
  const { cfg } = fixture(t);
  const session = createChatToolSession({ scope, cfg, task: "group_chat", mentioned: true,
    userMessage: "这个公开项目的新版本有什么变化？" });
  for (const name of ["recall_memory", "read_bot_status", "calculate", "web_search", "read_public_page"]) assert.ok(names(session).includes(name), name);
  assert.equal(names(session).includes("prepare_reminder"), false);
  assert.equal(names(session).includes("read_current_attachment"), false);
});

test("light interjection actually executes local tools but never declares network or preparation tools", async t => {
  const { cfg } = fixture(t);
  const session = createChatToolSession({ scope, cfg, task: "interjection", mentioned: false,
    userMessage: "今天这个计算结果有点意思。" });
  assert.deepEqual(names(session), ["recall_memory", "read_bot_status", "calculate"]);
  const declared = session.definitions();
  assert.equal(result(await session.execute(call("calculate", { expression: "21*2" }), declared, {})).result, 42);
  assert.equal(session.limits.toolCalls, 2);
  assert.equal(result(await session.execute(call("web_search", { query: "public project" }), declared, {})).status, "denied");
  assert.equal(session.remainingTools(), 0);
});

test("private read-only calculation retains the real friend whitelist", async t => {
  const { cfg } = fixture(t);
  const privateScope = { surface: "private", userId: "60117", groupId: null };
  const allowed = createChatToolSession({ scope: privateScope, cfg, task: "private_chat", userMessage: "这个数值是多少？" });
  assert.ok(names(allowed).includes("calculate"));
  assert.equal(result(await allowed.execute(call("calculate", { expression: "6*7" }), allowed.definitions(), {})).result, 42);
  const denied = createChatToolSession({ scope: { ...privateScope, userId: "60118" }, cfg,
    task: "private_chat", userMessage: "这个数值是多少？" });
  assert.deepEqual(names(denied), []);
});

test("explicit off and legacy mode still prevent passive tool use", t => {
  const { cfg } = fixture(t);
  assert.deepEqual(names(createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "public topic", allowTools: false })), []);
  assert.deepEqual(names(createChatToolSession({ scope, cfg: { ...cfg, toolAutonomyEnabled: false },
    task: "interjection", userMessage: "public topic" })), []);
});

test("saving policy changes invalidates a running shared session without expanding its budget", t => {
  const { cfg } = fixture(t);
  const session = createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "public topic" });
  const before = getToolSettingsSnapshot({ cfg });
  applyToolSettingsAction({ action: "save", expectedRevision: before.revision,
    settings: { ...before.settings, profile: "extended" } }, { cfg });
  assert.throws(() => session.assertCurrent(), /tool_configuration_changed/);
  assert.equal(session.limits.toolCalls, 4);
});

function externalEntry(overrides = {}) {
  return { label: "Synthetic readonly tool", mode: "read", access: "mcp_read", configured: true, timeoutMs: 1000, resultChars: 1000,
    definition: { type: "function", function: { name: "mcp_fixture_echo", description: "Synthetic readonly data",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
    validateArguments: args => Object.keys(args).length === 1 && typeof args.query === "string",
    available: context => context.scope?.surface === "group",
    execute: async () => ({ status: "ok", text: "Synthetic public result", untrusted: true }), ...overrides };
}

test("MCP readonly entries share discovery and execution while unvalidated or write entries stay hidden", async t => {
  const { cfg } = fixture(t);
  const start = getToolSourceRevision();
  const dispose = registerToolSource("fixture", { entries: () => [externalEntry(),
    externalEntry({ mode: "write", definition: { type: "function", function: { name: "mcp_fixture_write" } } })] });
  t.after(dispose);
  assert.ok(getToolSourceRevision() > start);
  assert.ok(registeredTool("mcp_fixture_echo"));
  assert.equal(registeredTool("mcp_fixture_write"), undefined);
  const session = createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "public topic" });
  const declared = session.definitions();
  assert.ok(declared.some(entry => entry.function.name === "mcp_fixture_echo"));
  assert.equal(result(await session.execute(call("mcp_fixture_echo", { query: "public" }), declared, {})).text, "Synthetic public result");
  assert.equal(result(await session.execute(call("mcp_fixture_echo", { query: "public", userId: "other" }), declared, {})).status, "invalid_arguments");
  assert.equal(names(createChatToolSession({ scope, cfg, task: "interjection", userMessage: "public topic" })).includes("mcp_fixture_echo"), false);
});

test("old disposers cannot remove a newer tool source and registry changes invalidate stale sessions", t => {
  const { cfg } = fixture(t);
  const first = registerToolSource("replaceable", { entries: () => [externalEntry()] });
  const session = createChatToolSession({ scope, cfg, task: "group_chat", userMessage: "public topic" });
  const second = registerToolSource("replaceable", { entries: () => [externalEntry({ label: "New label" })] });
  t.after(second);
  first();
  assert.equal(registeredTools().find(entry => entry.definition.function.name === "mcp_fixture_echo").label, "New label");
  assert.throws(() => session.assertCurrent(), /tool_configuration_changed/);
});
