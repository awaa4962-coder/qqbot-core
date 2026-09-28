import assert from "node:assert/strict";
import test from "node:test";
import { createModelTaskBudget } from "../bridge/api-providers/task-budget.mjs";
import { createDefaultApiConfig } from "../bridge/api-providers/store.mjs";
import { callTaskProviderResult } from "../bridge/model-router.mjs";
import { generateGroupSummaryResult } from "../bridge/group-summary/providers.mjs";
import { generateConversationSummary } from "../bridge/features/conversation-summary/prompt.mjs";

const request = maxTokens => ({ systemPrompt: "rules", messages: [{ role: "user", content: "synthetic data" }], maxTokens, timeoutMs: 120000 });
const raw = text => ({ choices: [{ message: { content: text } }] });

test("summary task reservations bound both slots and all physical attempts", () => {
  const budget = createModelTaskBudget("group_summary", { now: () => 0 });
  const primary = budget.prepare(request(8192));
  assert.equal(primary.beforeAttempt(), "");
  assert.equal(primary.beforeAttempt(), "");
  const fallback = budget.prepare(request(3072));
  assert.equal(fallback.beforeAttempt(), "");
  assert.equal(fallback.beforeAttempt(), "");
  assert.equal(fallback.beforeAttempt(), "task_budget");
  assert.deepEqual(budget.snapshot(), { calls: 2, transportAttempts: 4, requestedInputChars: 76, requestedCompletionTokens: 22528 });
  assert.throws(() => budget.prepare(request(1)), /task_budget/);
});

test("task input and output limits reject rather than mutate or truncate evidence", () => {
  const budget = createModelTaskBudget("conversation_summary", { now: () => 0 });
  const oversized = { ...request(4096), messages: [{ role: "user", content: "x".repeat(24001) }] };
  const before = JSON.stringify(oversized);
  assert.throws(() => budget.prepare(oversized), /task_input_budget/);
  assert.equal(JSON.stringify(oversized), before);
  assert.equal(budget.snapshot().calls, 0);
  assert.throws(() => budget.prepare(request(4097)), /task_output_budget/);
  assert.throws(() => createModelTaskBudget("admin_command"), /unsupported_model_task_budget/);
});

test("both model slots share deadline and cancellation with shrinking time", () => {
  let now = 0;
  const controller = new globalThis.AbortController();
  const budget = createModelTaskBudget("conversation_summary", { now: () => now, signal: controller.signal });
  const primary = budget.prepare({ ...request(4096), timeoutMs: 45000, maxResponseBytes: -1 });
  now = 70000;
  const fallback = budget.prepare({ ...request(4096), timeoutMs: 45000 });
  assert.equal(primary.signal, fallback.signal);
  assert.equal(primary.timeoutMs, 45000);
  assert.equal(fallback.timeoutMs, 20000);
  assert.equal(primary.maxResponseBytes, 262144);
  controller.abort();
  assert.equal(fallback.beforeAttempt(), "task_cancelled");
  assert.throws(budget.assertCurrent, /task_cancelled/);
});

test("task facade forwards attempt guards so rejected budgets make no network request", async t => {
  const config = createDefaultApiConfig();
  config.providers.deepseek.auth = "none";
  config.providers.deepseek.endpoint = "https://example.com/task-budget";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not fetch"); });
  const result = await callTaskProviderResult("group_summary", "primary", {
    ...request(8192), beforeAttempt: () => "task_budget",
  }, { config });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("daily summary discards late primary text and never starts fallback after task deadline", async () => {
  let now = 0; let primary = 0; let fallback = 0;
  const messages = Array.from({ length: 8 }, (_, index) => ({ uid: "123456", nickname: "合成用户", messageId: String(index + 1),
    text: "文件下载进展 " + index, ts: Date.parse("2026-09-28T12:00:00+08:00") + index * 1000 }));
  const result = await generateGroupSummaryResult(messages, { structured: true, lowMessageLimit: 0,
    dateText: "2026-09-28", budgetClock: () => now,
    callPrimarySummary: async (_prompt, prepared) => { primary++; assert.equal(prepared.maxTokens, 8192); now = 240000; return raw("late body"); },
    callFallbackSummary: async () => { fallback++; return raw("unexpected"); },
  });
  assert.equal(result.kind, "unavailable");
  assert.equal(result.reason, "task_deadline");
  assert.equal(primary, 1); assert.equal(fallback, 0);
  assert.equal(result.text, null);
});

test("member summary discards late primary text and never starts fallback after task deadline", async () => {
  let now = 0; let calls = 0;
  const bundle = { targets: [{ uid: "123456", alias: "P1", name: "合成用户", count: 1 }],
    transcript: [{ messageId: "1", evidenceId: "M1", alias: "P1", name: "合成用户", target: true,
      text: "换线后仍然黑屏", ts: Date.parse("2026-09-28T12:00:00+08:00") }] };
  const result = await generateConversationSummary(bundle, { budgetClock: () => now,
    callProvider: async (_task, position, prepared) => {
      calls++; assert.equal(position, "primary"); assert.equal(prepared.timeoutMs, 45000);
      now = 90000; return { ok: true, provider: "synthetic", raw: raw("late body") };
    } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "task_deadline");
  assert.equal(calls, 1);
  assert.doesNotMatch(result.text, /late body/);
});
