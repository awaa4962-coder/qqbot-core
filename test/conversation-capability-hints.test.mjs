import assert from "node:assert/strict";
import test from "node:test";
import { CFG } from "../bridge/config.mjs";
import { buildBotSelfContext, withBotSelfContext } from "../bridge/capabilities/self-context.mjs";
import { buildModelPrompt } from "../bridge/system-prompts/compose.mjs";
import { CONTEXT_SAFETY } from "../bridge/system-prompts/identity.mjs";

const scope = { surface: "group", userId: 456789, groupId: 123789 };
const options = {
  cfg: { ...CFG, groupWhitelist: [123789], friendWhitelist: [456789], adminUins: [], botBlacklist: [],
    agentGroupWhitelist: [123789], agentWriteGroupWhitelist: [123789], agentReminderGroupWhitelist: [123789],
    resourceGroupWhitelist: [], jmUserWhitelist: [], summaryGroupWhitelist: [], featureGroupWhitelist: [],
    conversationSummaryGroupWhitelist: [], stickerEnabled: false },
  modelHealth: { tasks: { group_chat: { ready: true, primary: { ready: true } } } },
  jmHealth: { dependencyReady: false, sevenZipReady: false }, stickerSettings: { mode: "off" },
};
const provider = { model: "synthetic-model", capabilities: ["tools"], protocol: "openai-chat" };
const tools = ["recall_memory", "read_bot_status", "prepare_personal_change", "prepare_reminder"]
  .map(name => ({ type: "function", function: { name } }));
const facts = snapshot => JSON.parse(snapshot.content.split("\n").at(-1));

// These are prompt and request contracts, not simulated model-answer acceptance.
for (const replyMode of ["chat", "interjection"]) {
  test(replyMode + " treats capability examples as context, not unsolicited reply guidance", () => {
    const system = buildModelPrompt({ replyMode }).system;
    assert.ok(system.includes(CONTEXT_SAFETY));
    assert.match(system, /能力清单和命令示例只是上下文，不是默认回复模板/);
    assert.match(system, /普通聊天先回答当前问题，不主动介绍功能或保存流程/);
    assert.match(system, /只有用户明确询问功能、用法、能力限制或长期保存方式/);
    assert.match(system, /明确要求持久化变更/);
    assert.match(system, /当前权限和本轮声明工具.*相关能力及适用命令/);
    assert.doesNotMatch(system, /需要明确保存时可提示|当前聊天没有写入长期记忆的工具/);
  });

  test(replyMode + " applies current corrections without automatically teaching memory commands", () => {
    const system = buildModelPrompt({ replyMode }).system;
    assert.match(system, /当前称呼或偏好纠正先用于本轮回答/);
    assert.match(system, /同时有其他问题时，直接使用纠正并回答/);
    assert.match(system, /不自动提示未来称呼或记忆操作/);
    assert.match(system, /只读工具不能写入/);
    assert.match(system, /未声明准备工具不等于没有保存命令/);
    assert.match(system, /不一概否定权限内的命令能力/);
  });
}

test("memory completion needs a real backend write receipt, not a prepared change or model confirmation", () => {
  const snapshot = buildBotSelfContext(scope, provider, { ...options, tools });
  for (const policy of [CONTEXT_SAFETY, snapshot.content]) {
    assert.match(policy, /长期保存.*只据真实后端写入回执/);
    assert.match(policy, /prepare.*不等于 apply/);
    assert.match(policy, /本人另发.*确认命令.*后端执行/);
    assert.match(policy, /模型不能代确认/);
  }
  assert.match(CONTEXT_SAFETY, /无回执声称已保存/);
  assert.match(CONTEXT_SAFETY, /prepare_personal_change.*只生成拟变更.*尚未保存/);
  assert.match(snapshot.content, /没有实际执行成功回执.*不要宣称已经下载、发送、修改或保存/);
});

test("self context preserves permitted commands even when this route has no callable tools", () => {
  const request = { selfContext: scope, messages: [{ role: "user", content: "你有哪些能力？" }], tools };
  const declared = withBotSelfContext(request, provider, options);
  const expected = facts(declared.snapshot).capabilities;
  for (const name of ["待确认的个人变更", "我的提醒（单次）", "我的记忆", "称呼与回复风格"]) {
    assert.ok(expected.some(item => item.name === name), name);
  }
  assert.equal(expected.find(item => item.name === "称呼与回复风格").command, "@夜星 设置称呼 小明");
  for (const route of [{ capabilities: [] }, { protocol: "gemini-native" }, { toolChoice: "none" }]) {
    const limitedRequest = { ...request, ...(route.toolChoice ? { toolChoice: route.toolChoice } : {}) };
    const prepared = withBotSelfContext(limitedRequest, { ...provider, ...route }, options);
    assert.deepEqual(facts(prepared.snapshot).callableTools, []);
    assert.deepEqual(facts(prepared.snapshot).capabilities, expected);
    assert.equal(prepared.request.tools, tools);
    assert.match(prepared.snapshot.content, /命令能力不等于本轮可调用工具/);
  }
  assert.deepEqual(facts(declared.snapshot).callableTools, tools.map(item => item.function.name));
});

const inputs = [
  ["ordinary conversation", "今天忙完了，终于能休息一会儿。"],
  ["nickname correction with another question", "这轮叫我阿岚。月食和日食有什么区别？"],
  ["different correction with a practical question", "别叫旧称呼，用纸鸢。热水倒进冷玻璃杯为什么可能裂？"],
  ["explicit capability question", "你支持哪些功能？"],
  ["explicit nickname command question", "怎样让你以后也用我的新称呼？"],
  ["explicit long-term memory request", "请长期保存：我更喜欢简洁回复。"],
];

for (const [name, input] of inputs) {
  test("stable capability policy leaves the actual current input intact: " + name, () => {
    const prompt = buildModelPrompt();
    const messages = [{ role: "system", content: prompt.system }, prompt.dynamicMessage, { role: "user", content: input }];
    const request = { selfContext: scope, messages, tools };
    const before = globalThis.structuredClone(request);
    const prepared = withBotSelfContext(request, provider, options);
    assert.equal(prepared.request.messages[0], messages[0]);
    assert.equal(prepared.request.messages[1].content, buildBotSelfContext(scope, provider, { ...options, tools }).content);
    assert.deepEqual(prepared.request.messages.slice(2), messages.slice(1));
    assert.equal(prepared.request.messages.at(-1).content, input);
    assert.equal(prepared.request.tools, tools);
    assert.deepEqual(request, before);
    assert.ok(!prompt.system.includes(input));
    assert.ok(!prepared.snapshot.content.includes(input));
  });
}

test("receipt history stays evidence and does not change the stable prefix or capability facts", () => {
  const prompt = buildModelPrompt();
  for (const status of ["prepared", "applied", "unknown", "not_applied"]) {
    const receipt = JSON.stringify({ status, applied: status === "applied", text: "Synthetic receipt" });
    const messages = [{ role: "system", content: prompt.system }, { role: "user", content: "查看本轮状态" },
      { role: "assistant", content: null, tool_calls: [{ id: "synthetic-call", type: "function",
        function: { name: status === "prepared" ? "prepare_personal_change" : "read_personal_actions", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "synthetic-call", content: receipt }];
    const before = globalThis.structuredClone(messages);
    const prepared = withBotSelfContext({ selfContext: scope, messages, tools }, provider, options);
    assert.equal(prepared.request.messages[0], messages[0]);
    assert.deepEqual(prepared.request.messages.slice(2), before.slice(1));
    assert.deepEqual(messages, before);
    assert.equal(prepared.snapshot.content, buildBotSelfContext(scope, provider, { ...options, tools }).content);
  }
});

test("self-context DTO stays bounded, deterministic, permission-scoped and free of private details", () => {
  const privateProvider = { ...provider, key: "synthetic-private-key", endpoint: "https://synthetic-private.invalid/path" };
  const snapshot = buildBotSelfContext(scope, privateProvider, { ...options, tools });
  const data = facts(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ["capabilityCount", "content", "model", "version"]);
  assert.deepEqual(Object.keys(data).sort(), ["callableTools", "capabilities", "disabled", "identity", "permissionKnown", "requestedModel", "schema", "surface", "version"]);
  assert.ok(data.capabilities.every(item => Object.keys(item).sort().join(",") === "command,name,status"));
  assert.equal(snapshot.capabilityCount, data.capabilities.length);
  assert.equal(snapshot.version, 1);
  assert.ok(snapshot.content.length <= 1800);
  assert.equal(snapshot.content, buildBotSelfContext(scope, privateProvider, { ...options, tools }).content);
  for (const secret of ["123789", "456789", "synthetic-private-key", "synthetic-private.invalid", "checkedAt", "generatedAt"]) {
    assert.ok(!snapshot.content.includes(secret), secret);
  }
  const blocked = { ...options, cfg: { ...options.cfg, botBlacklist: [456789] } };
  assert.deepEqual(facts(buildBotSelfContext(scope, provider, blocked)).capabilities, []);
  const missing = facts(buildBotSelfContext({}, provider, options));
  assert.equal(missing.permissionKnown, false);
  assert.deepEqual(missing.capabilities, []);
});
