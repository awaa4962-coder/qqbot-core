import assert from "node:assert/strict";
import test from "node:test";
import { enforceContextBudget } from "../bridge/context/budget.mjs";
import { fitContextMessageGroups, registeredContextSources } from "../bridge/context/pruning.mjs";

const source = id => ({ kind: "group", reason: "reply_chain", messageId: String(id), userId: "60100" });
const frame = (id, content, group, priority = 70) => ({ role: "user", content, contextSources: [source(id)],
  contextGroup: group, contextPriority: priority });
const measure = request => ({ chars: request.messages.reduce((count, item) => count + item.content.length, 0) });

test("related frames are kept or dropped together for both character and message limits", () => {
  const frames = [frame(1, "A".repeat(50), "pair", 100), frame(2, "B".repeat(50), "pair", 10), frame(3, "C", "other", 30)];
  for (const limits of [{ maxChars: 100 }, { maxMessages: 1 }]) {
    const result = enforceContextBudget(frames, "current", limits);
    assert.deepEqual(result.sources.map(item => item.messageId), ["3"]);
    assert.equal(result.budget.selectedGroupCount, 1); assert.equal(result.budget.prunedGroupCount, 1);
  }
  const full = enforceContextBudget(frames, "current");
  assert.deepEqual(full.messages.map(item => item.content), frames.map(item => item.content));
  assert.deepEqual(Object.keys(full.messages[0]).sort(), ["content", "role"]);
});

test("source-bearing units never use the legacy generic-text clipping path", () => {
  const result = enforceContextBudget([frame(1, "[history]\n" + "x".repeat(1000))], "current", { maxChars: 240, maxMessageChars: 200 });
  assert.deepEqual(result.messages, []); assert.deepEqual(result.sources, []);
  assert.equal(result.budget.truncatedMessageCount, 0);
  assert.equal(result.budget.prunedMessageCount, 1);
});

test("an empty member cannot silently split an explicitly grouped unit", () => {
  const result = enforceContextBudget([frame(1, "parent", "pair"), frame(2, " ", "pair")], "current");
  assert.equal(result.messages.length, 0); assert.equal(result.sources.length, 0);
  assert.equal(result.budget.prunedGroupCount, 1);
});

test("complete source references survive the former per-layer and aggregate display caps", () => {
  const sources = Array.from({ length: 40 }, (_, i) => source(i + 1));
  const result = enforceContextBudget([{ role: "user", content: "whole aggregate fixture", contextSources: sources }], "current");
  assert.deepEqual(result.sources, sources); assert.equal(result.budget.selectedSourceCount, 40);
  assert.deepEqual(registeredContextSources(result.messages), sources);
});

test("the source capacity rejects a whole group instead of dropping only its attribution", () => {
  const result = enforceContextBudget([
    { ...frame(1, "first", "first", 80), contextSources: Array.from({ length: 100 }, (_, i) => source(i)) },
    { ...frame(2, "second", "second", 70), contextSources: Array.from({ length: 40 }, (_, i) => source(100 + i)) },
  ], "current");
  assert.deepEqual(result.messages.map(item => item.content), ["first"]);
  assert.equal(result.sources.length, 100); assert.equal(result.budget.rejectedSourceGroups, 1);
});

test("current input and malformed or unbounded layer structures are explicit failures", () => {
  assert.throws(() => enforceContextBudget([], "x".repeat(6501)), { code: "context_current_input_limit" });
  assert.throws(() => enforceContextBudget(Array.from({ length: 129 }, () => ({ content: "x" }))), { code: "context_layer_limit" });
  assert.throws(() => enforceContextBudget([{ content: "x", contextGroup: { toString: null } }]), { code: "context_group_invalid" });
  assert.throws(() => enforceContextBudget([{ content: [{ type: "image_url" }] }]), { code: "context_nontext_layer" });
});

test("the history budget cannot silently strip protocol continuations or orphan tool results", () => {
  for (const row of [
    { role: "assistant", content: "x", tool_calls: [] }, { role: "tool", tool_call_id: "a", content: "x" },
    { content: "x", providerContinuation: {} }, { content: "x", reasoning_content: "private" },
  ]) assert.throws(() => enforceContextBudget([row]), { code: "context_protocol_transcript" });
});

test("late fitting removes only whole historical groups, never protected evidence or current input", () => {
  const initial = enforceContextBudget([frame(1, "old-parent", "old", 70), frame(2, "old-child", "old", 70), frame(3, "quote", "quote", 100)], "current");
  const current = { role: "user", content: "current" };
  const request = { messages: [...initial.messages, current] };
  const fitted = fitContextMessageGroups(request, 12, measure);
  assert.deepEqual(fitted.messages.map(item => item.content), ["quote", "current"]);
  assert.equal(fitted.removed.length, 1);
  assert.deepEqual(registeredContextSources(fitted.messages).map(item => item.messageId), ["3"]);
  assert.equal(request.messages.length, 4); assert.equal(fitted.messages.at(-1), current);
  assert.throws(() => fitContextMessageGroups(request, 11, measure), /tool_context_budget/);
});

test("partial known groups are rejected while equal text in another request shares no metadata", () => {
  const grouped = enforceContextBudget([frame(1, "one", "g"), frame(2, "two", "g")], "current");
  assert.throws(() => fitContextMessageGroups({ messages: [grouped.messages[0]] }, 99, measure), /context_group_incomplete/);
  const copy = grouped.messages.map(item => ({ ...item }));
  assert.deepEqual(registeredContextSources(copy), []);
  assert.throws(() => fitContextMessageGroups({ messages: copy }, 1, measure), /tool_context_budget/);
});

test("contradictory inherited dependencies reject the complete group", () => {
  const noteId = "abcdefabcdef";
  const result = enforceContextBudget([
    { ...frame(1, "one", "g"), contextMemorySources: [{ noteId, revision: 1 }] },
    { ...frame(2, "two", "g"), contextMemorySources: [{ noteId, revision: 2 }] },
  ], "current");
  assert.deepEqual(result.messages, []); assert.deepEqual(result.memorySources, []);
  assert.equal(result.budget.rejectedDependencyGroups, 1);
});
