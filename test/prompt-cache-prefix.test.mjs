import test from "node:test";
import assert from "node:assert/strict";
import { buildModelPrompt, composeModelMessages } from "../bridge/system-prompts/compose.mjs";
import { tryMiMoResult } from "../bridge/model-mimo.mjs";
import { tryDeepSeekResult } from "../bridge/model-ds.mjs";
import { registerContextGroups, registeredContextSources } from "../bridge/context/pruning.mjs";

const history = Object.freeze([
  Object.freeze({ role: "user", content: "SYNTHETIC_HISTORY_QUESTION" }),
  Object.freeze({ role: "assistant", content: "SYNTHETIC_HISTORY_ANSWER" }),
]);

test("per-turn expression changes preserve the fixed system and complete history prefix", () => {
  const current = Object.freeze({ role: "user", content: "SYNTHETIC_CURRENT_INPUT" });
  const plain = buildModelPrompt({ groupId: "909090909", mood: "正常", personaCue: "none" });
  const styled = buildModelPrompt({ groupId: "909090909", mood: "开心", personaCue: "hiss" });
  const first = composeModelMessages(plain, [...history, current]);
  const second = composeModelMessages(styled, [...history, current]);
  assert.deepEqual(first.slice(0, 3), second.slice(0, 3));
  assert.notEqual(first[3].content, second[3].content);
  assert.equal(first[1], history[0]);
  assert.equal(first[2], history[1]);
  assert.equal(first.at(-1), current);
  assert.deepEqual(history.map(item => item.content), ["SYNTHETIC_HISTORY_QUESTION", "SYNTHETIC_HISTORY_ANSWER"]);
});

test("empty history keeps the current user question last and rejects missing current input", () => {
  const prompt = buildModelPrompt({});
  const current = { role: "user", content: "SYNTHETIC_CURRENT_INPUT" };
  const messages = composeModelMessages(prompt, [current]);
  assert.equal(messages.length, 3);
  assert.equal(messages.at(-1), current);
  assert.throws(() => composeModelMessages(prompt, []), /current_input_required/);
  assert.throws(() => composeModelMessages(prompt, history), /current_input_required/);
});

test("composition preserves registered source groups and paired native history objects", () => {
  const assistant = { role: "assistant", content: null,
    tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "calculate", arguments: '{"expression":"21*2"}' } }],
    providerContinuation: { protocol: "openai-responses", items: [{ type: "function_call", call_id: "synthetic-call" }] } };
  const tool = { role: "tool", tool_call_id: "synthetic-call", content: '{"result":42}' };
  const registered = [assistant, tool];
  const source = { kind: "thread", userId: "42", messageId: "50001" };
  registerContextGroups(registered, registered.map((_, index) => ({
    group: "synthetic-complete-turn", sources: [source], memorySources: [], memoryExpiresAt: null, priority: 50, index,
  })));
  const before = JSON.stringify(registered);
  const expectedSources = registeredContextSources(registered);
  const current = { role: "user", content: "SYNTHETIC_CURRENT_INPUT" };
  const messages = composeModelMessages(buildModelPrompt({}), [...registered, current]);
  assert.equal(messages[1], assistant);
  assert.equal(messages[2], tool);
  assert.equal(messages[2].tool_call_id, messages[1].tool_calls[0].id);
  assert.deepEqual(registeredContextSources(messages), expectedSources);
  assert.equal(messages.at(-1), current);
  assert.equal(JSON.stringify(registered), before);
});

for (const [name, run] of [
  ["MiMo", (mood, personaCue) => tryMiMoResult("SYNTHETIC_CURRENT_INPUT", "fixture", history, [], 909090909, true, mood,
    { currentUserId: "42", personaCue, allowTools: false })],
  ["DeepSeek", (mood, personaCue) => tryDeepSeekResult("SYNTHETIC_CURRENT_INPUT", "fixture", history, 909090909, true, mood,
    { currentUserId: "42", personaCue, allowTools: false })],
]) {
  test(name + " wire keeps stable history before changing expression settings", async () => {
    const previous = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "SYNTHETIC_FINAL" } }] }) };
    };
    try {
      assert.equal((await run("正常", "none")).text, "SYNTHETIC_FINAL");
      assert.equal((await run("开心", "hiss")).text, "SYNTHETIC_FINAL");
      assert.equal(bodies.length, 2);
      const [first, second] = bodies.map(body => body.messages);
      const historyStart = first.findIndex(item => item.content === history[0].content);
      const styleIndex = first.findIndex(item => item.content?.startsWith?.("[本轮表达设置]"));
      assert.ok(historyStart >= 1);
      assert.ok(styleIndex > historyStart + 1);
      assert.deepEqual(first.slice(0, styleIndex), second.slice(0, styleIndex));
      assert.equal(first[historyStart + 1].content, history[1].content);
      assert.equal(first.filter(item => item.content?.startsWith?.("[本轮表达设置]")).length, 1);
      assert.equal(second.filter(item => item.content?.startsWith?.("[本轮表达设置]")).length, 1);
      assert.notEqual(first[styleIndex].content, second[styleIndex].content);
      assert.match(first.at(-1).content, /SYNTHETIC_CURRENT_INPUT/);
      assert.match(second.at(-1).content, /SYNTHETIC_CURRENT_INPUT/);
    } finally { globalThis.fetch = previous; }
  });
}
