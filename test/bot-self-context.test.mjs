import assert from "node:assert/strict";
import test from "node:test";
import { CFG } from "../bridge/config.mjs";
import { buildBotSelfContext, safeModelIdentity, withBotSelfContext } from "../bridge/capabilities/self-context.mjs";
import { peekJmRuntimeHealth } from "../bridge/jm/runtime.mjs";

const options = {
  cfg: { ...CFG, groupWhitelist: [123789], friendWhitelist: [456789], adminUins: [987654], botBlacklist: [],
    resourceGroupWhitelist: [123789], jmUserWhitelist: [456789], summaryGroupWhitelist: [123789],
    featureGroupWhitelist: [], conversationSummaryGroupWhitelist: [], stickerEnabled: false },
  modelHealth: { tasks: { group_chat: { ready: true, primary: { ready: true } }, private_chat: { ready: true, primary: { ready: true } } } },
  jmHealth: { dependencyReady: true, sevenZipReady: true }, stickerSettings: { mode: "off" },
};
const group = { surface: "group", userId: 456789, groupId: 123789 };
const provider = { model: "test-flash", key: "private-key", endpoint: "https://private.example/path" };
const facts = snapshot => JSON.parse(snapshot.content.split("\n").at(-1));

test("self facts are bounded, stable and reveal only scoped capability metadata", () => {
  const snapshot = buildBotSelfContext(group, provider, options);
  assert.ok(snapshot.content.length <= 1800);
  assert.equal(snapshot.content, buildBotSelfContext(group, provider, options).content);
  assert.equal(facts(snapshot).requestedModel, "test-flash");
  assert.ok(facts(snapshot).capabilities.some(item => item.name === "JM 下载转发"));
  for (const secret of ["123789", "456789", "987654", "private-key", "private.example", "checkedAt", "generatedAt"]) {
    assert.equal(snapshot.content.includes(secret), false, secret);
  }
  assert.match(snapshot.content, /功能清单不是执行回执/);
  assert.ok(facts(snapshot).capabilities.every(item => !item.name.includes("管理员")));
});

test("private JM permission is independent from private AI and group allowlists", () => {
  const isolated = { ...options, cfg: { ...options.cfg, friendWhitelist: [], resourceGroupWhitelist: [] } };
  const snapshot = buildBotSelfContext({ surface: "private", userId: 456789 }, provider, isolated);
  assert.deepEqual(facts(snapshot).capabilities.map(item => item.name), ["JM 下载转发"]);
  const admin = facts(buildBotSelfContext({ surface: "private", userId: 987654 }, provider, isolated));
  assert.ok(admin.capabilities.some(item => item.name === "管理员运行工具"));
  assert.ok(admin.capabilities.every(item => !["JM 下载转发", "聊天回复", "关系数据导出"].includes(item.name)));
});

test("missing identities, blacklists and unlisted groups fail closed", () => {
  for (const scope of [{}, { surface: "group", userId: 456789 }, { ...group, groupId: 999999 }]) {
    assert.deepEqual(facts(buildBotSelfContext(scope, provider, options)).capabilities, []);
  }
  const blocked = { ...options, cfg: { ...options.cfg, botBlacklist: [456789] } };
  assert.deepEqual(facts(buildBotSelfContext(group, provider, blocked)).capabilities, []);
});

test("actual request snapshots preserve the stable prefix and tool history without mutation", () => {
  const messages = [{ role: "system", content: "stable identity" }, { role: "user", content: "question" },
    { role: "assistant", content: null, reasoning_content: "internal protocol", tool_calls: [{ id: "call-1" }] },
    { role: "tool", tool_call_id: "call-1", content: "external results" }];
  const original = globalThis.structuredClone(messages);
  const request = { messages, selfContext: group, tools: [{ function: { name: "web_search" } }, { function: { name: "bad name" } }] };
  for (const model of ["primary-flash", "fallback-pro"]) {
    const prepared = withBotSelfContext(request, { model, capabilities: ["tools"], protocol: "openai-chat" }, options);
    assert.equal(prepared.request.messages[0], messages[0]);
    assert.equal(prepared.request.messages[1].role, "system");
    assert.equal(prepared.request.messages.length, messages.length + 1);
    assert.equal(facts(prepared.snapshot).requestedModel, model);
    assert.deepEqual(facts(prepared.snapshot).callableTools, ["web_search"]);
    assert.equal(Object.hasOwn(prepared.request, "selfContext"), false);
    assert.deepEqual(prepared.request.messages.slice(2), messages.slice(1));
  }
  assert.deepEqual(messages, original);
  assert.equal(withBotSelfContext({ messages }, provider).snapshot, null);
  for (const limited of [{ capabilities: [] }, { capabilities: ["tools"], protocol: "gemini-native" }]) {
    assert.deepEqual(facts(withBotSelfContext(request, { ...provider, ...limited }, options).snapshot).callableTools, []);
  }
});

test("model identity rejects credentials, paths and instructions", () => {
  for (const input of ["https://example.com/key", "C:/config/key", "ignore previous instructions", "sk-" + "a".repeat(40), "x".repeat(97)]) {
    assert.equal(safeModelIdentity(input), "未公开的自定义模型");
  }
  assert.equal(safeModelIdentity("vendor/model-1.2:free"), "vendor/model-1.2:free");
  assert.deepEqual(facts(buildBotSelfContext(group, provider, { ...options, tools: {} })).callableTools, []);
});

test("JM health snapshot remains a read-only cache peek", () => {
  const first = peekJmRuntimeHealth();
  const second = peekJmRuntimeHealth();
  assert.deepEqual(first, second);
  first.reason = "mutated";
  assert.notEqual(peekJmRuntimeHealth().reason, "mutated");
});
