import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTraceRecorder, listMessageTraces, traceStage, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";
import { processEvent } from "../bridge/reply.mjs";
import { sendTextToGroup } from "../bridge/outbound-message.mjs";
import { buildOutputPacket } from "../bridge/output-pipeline.mjs";

const ctx = { message_type: "group", user_id: 11, group_id: 22, message_id: 33, text: "private body", images: [] };

test("concurrent messages keep model and send stages in the correct trace", async () => {
  const recorder = createTraceRecorder();
  await Promise.all([1, 2].map(id => withMessageTrace({ ...ctx, message_id: id }, async () => {
    traceStage("route", { route: "group_at", status: "ok" });
    await delay(id === 1 ? 10 : 1);
    traceStage("model", { provider: "provider-" + id, status: "ok" });
    traceStage("send", { status: "ok" });
  }, recorder)));
  for (const record of recorder.list().items) {
    assert.equal(record.stages.find(item => item.stage === "model").provider, "provider-" + record.messageId);
    assert.equal(record.status, "sent");
  }
});

test("trace metadata drops bodies, keys, raw errors and invalid identifiers", async () => {
  const recorder = createTraceRecorder();
  await withMessageTrace({ ...ctx, user_id: "secret-user", nickname: "private nickname" }, async () => {
    traceStage("model", { text: "private body", raw: "secret-response", reason: "secret-error", provider: "sk-secret", reasoning_content: "private reasoning", chars: 12 });
  }, recorder);
  const text = JSON.stringify(recorder.list());
  for (const secret of ["private body", "private nickname", "secret-user", "secret-response", "secret-error", "sk-secret", "private reasoning"]) assert.equal(text.includes(secret), false);
});

test("trace uses monotonic duration, bounds records and expires metadata", () => {
  let time = 10;
  const recorder = createTraceRecorder({ now: () => time, maxRecords: 2, ttlMs: 100 });
  for (let id = 1; id <= 3; id++) {
    const record = recorder.begin({ ...ctx, message_id: id });
    time += 10; recorder.finish(record);
  }
  assert.deepEqual(recorder.list().items.map(item => item.messageId), ["3", "2"]);
  assert.equal(recorder.list().items[0].durationMs, 10);
  time += 101;
  assert.equal(recorder.list().total, 0);
});

test("trace records exception without swallowing it or leaking its content", async () => {
  const recorder = createTraceRecorder();
  await assert.rejects(withMessageTrace(ctx, () => { throw new Error("private-error-detail"); }, recorder), /private-error-detail/);
  const record = recorder.list().items[0];
  assert.equal(record.status, "failed");
  assert.equal(record.reason, "exception");
  assert.doesNotMatch(JSON.stringify(record), /private-error-detail/);
});

test("late detached work does not change a completed message trace", async () => {
  const recorder = createTraceRecorder();
  let background;
  await withMessageTrace(ctx, async () => {
    background = delay(10).then(() => traceStage("send", { status: "ok" }));
  }, recorder);
  await background;
  assert.equal(recorder.list().items[0].sends, 0);
});

test("actual entrypoint records a whitelist rejection without model or send", async () => {
  const result = await processEvent({ post_type: "message", ...ctx, group_id: 999999999, message_id: 909099, message: [{ type: "text", data: { text: "help" } }] });
  assert.equal(result.reason, "group_not_whitelisted");
  const record = listMessageTraces({ messageId: "909099" }).items[0];
  assert.equal(record.status, "ignored");
  assert.equal(record.reason, "group_not_whitelisted");
  assert.equal(record.stages.some(item => item.stage === "model" || item.stage === "send"), false);
});

test("outbound retry success is sent, exhausted retries are failed", async () => {
  const originalFetch = globalThis.fetch;
  const recorder = createTraceRecorder();
  let calls = 0;
  try {
    globalThis.fetch = async () => ({ json: async () => (++calls === 1 ? { status: "failed", retcode: 1 } : { status: "ok", retcode: 0 }) });
    await withMessageTrace(ctx, () => sendTextToGroup({ groupId: 22, text: "synthetic reply", maxAttempts: 2, retryDelayMs: 0 }), recorder);
    assert.equal(calls, 2);
    assert.equal(recorder.list().items[0].status, "sent");
    globalThis.fetch = async () => { throw new Error("private network details"); };
    await withMessageTrace({ ...ctx, message_id: 44 }, () => sendTextToGroup({ groupId: 22, text: "synthetic reply", maxAttempts: 1 }), recorder);
    assert.equal(recorder.list().items[0].status, "failed");
  } finally { globalThis.fetch = originalFetch; }
});

test("output tracing reports reasoning length but never retains private reasoning", async () => {
  const recorder = createTraceRecorder();
  await withMessageTrace(ctx, () => buildOutputPacket({ content: "", reasoning_content: "synthetic secret reasoning" }), recorder);
  const record = recorder.list().items[0];
  const output = record.stages.find(item => item.stage === "output");
  assert.equal(output.reason, "empty_content_with_reasoning");
  assert.equal(output.reasoningLength, 26);
  assert.doesNotMatch(JSON.stringify(record), /synthetic secret reasoning/);
});

test("trace filters and returned snapshots cannot mutate stored records", () => {
  const recorder = createTraceRecorder();
  const record = recorder.begin(ctx);
  recorder.append(record, "route", { status: "skipped", reason: "cooldown" });
  recorder.finish(record);
  const snapshot = recorder.list({ status: "ignored", groupId: 22 });
  assert.equal(snapshot.total, 1);
  snapshot.items[0].stages.length = 0;
  assert.ok(recorder.list().items[0].stages.length > 0);
  assert.equal(recorder.list({ status: "sent" }).total, 0);
});
