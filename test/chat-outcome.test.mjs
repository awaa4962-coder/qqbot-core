import assert from "node:assert/strict";
import test from "node:test";
import { callChatSlot, chatError, normalizeChatOutcome, parseChatOutcome } from "../bridge/chat-outcome.mjs";

const passive = { replyMode: "interjection" };

test("only an explicit empty interjection reply is intentional silence", () => {
  for (const content of ['{"reply":""}', '```json\n{"reply":"  "}\n```']) {
    assert.deepEqual(parseChatOutcome({ content }, passive), { kind: "silence", text: null, reason: "intentional_silence" });
  }
  for (const content of ["", '{"reply":"', '{"reply":null}', '{}', '{"reply":false}']) {
    assert.equal(parseChatOutcome({ content }, passive).kind, "error", content);
  }
});

test("private reasoning cannot become a reply or intentional silence", () => {
  for (const content of ["", "<think>hidden</think>", "让我分析一下用户的意思是需要回答"]) {
    const result = parseChatOutcome({ content, reasoning_content: "hidden reasoning" }, passive);
    assert.equal(result.kind, "error");
    assert.equal(result.text, null);
    assert.doesNotMatch(JSON.stringify(result), /hidden/);
  }
  assert.equal(parseChatOutcome({ content: "final answer", reasoning_content: "hidden" }).text, "final answer");
});

test("interjections preserve valid text and reject malformed or truncated JSON", () => {
  assert.equal(parseChatOutcome({ content: '{"reply":"接上这句话。"}' }, passive).text, "接上这句话。");
  assert.equal(parseChatOutcome({ content: "接上这句话。" }, passive).text, "接上这句话。");
  assert.equal(parseChatOutcome({ content: '{"reply":""}' }, { ...passive, finishReason: "length" }).kind, "error");
  assert.equal(parseChatOutcome({ content: '{"reply":"hello"' }, passive).kind, "error");
});

test("slot normalization keeps fixed error codes and drops arbitrary raw fields", async () => {
  assert.deepEqual(chatError("private upstream error"), chatError());
  assert.deepEqual(normalizeChatOutcome({ kind: "reply", text: "hello", reasoning_content: "hidden" }), { kind: "reply", text: "hello", reason: "reply" });
  assert.equal(normalizeChatOutcome({ content: "raw API payload" }).kind, "error");
  assert.equal(normalizeChatOutcome("<think>hidden</think>").kind, "error");
  assert.deepEqual(await callChatSlot(async () => { throw new Error("private error"); }, {}), chatError("request_failed"));
});
