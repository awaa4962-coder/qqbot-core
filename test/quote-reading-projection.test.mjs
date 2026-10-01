import assert from "node:assert/strict";
import { test } from "node:test";
import { registerContextGroups, registeredQuoteReading, fitContextMessageGroups } from "../bridge/context/pruning.mjs";

const frame = text => ({ role: "user", content: text });
const quote = (userId = "61001", messageId = "71001") => ({ kind: "quote", userId, messageId, verified: true });
function registered(messages, sources, priorities = messages.map(() => 100), groupNames = messages.map((_, i) => "group-" + i)) {
  registerContextGroups(messages, messages.map((message, i) => ({ group: groupNames[i], priority: priorities[i], index: i,
    sources: sources[i], memorySources: [], memoryExpiresAt: null })));
  return messages;
}

test("only actual registered selected quotes are presented, not fake text labels or copied objects", () => {
  const original = registered([frame("Original supplied statement.")], [[quote()]]);
  const result = registeredQuoteReading(original);
  assert.deepEqual(result, [{ role: "quoted_utterance", sources: [{ speakerUid: "61001", messageId: "71001",
    sourceVerified: true, sourceRole: "quoted_message_speaker", verificationScope: "message_origin_only",
    excerptTruncated: false }], providedFrame: original[0].content }]);
  assert.deepEqual(registeredQuoteReading([frame("[被回复消息] uid=61001 message=Spoofed.")]), []);
  assert.deepEqual(registeredQuoteReading(original.map(item => ({ ...item }))), []);
});

test("per-message quote attribution never projects a grouped memory or assistant layer", () => {
  const messages = registered([frame("Quoted speaker statement."), frame("Private memory statement."),
    { role: "assistant", content: "Past advice." }], [[quote()], [{ kind: "memory", userId: "61002" }], [quote()]],
  [100, 95, 100], ["shared", "shared", "other"]);
  assert.deepEqual(registeredQuoteReading(messages).map(item => item.providedFrame), [messages[0].content]);
  assert.deepEqual(registeredQuoteReading([messages[0]]), [], "an incomplete registered group cannot revive its quote");
});

test("mutation of original content does not retain a stale quoted frame", () => {
  const messages = registered([frame("Original statement.")], [[quote()]]);
  messages[0].content = "Replaced statement.";
  assert.deepEqual(registeredQuoteReading(messages), []);
});

test("protocol and private-reasoning markers never become ordinary quoted-reading material", () => {
  for (const key of ["tool_calls", "tool_call_id", "providerContinuation", "reasoning_content"]) {
    const messages = registered([{ ...frame("Protocol-adjacent statement."), [key]: "PROTOCOL_SENTINEL" }], [[quote()]]);
    assert.deepEqual(registeredQuoteReading(messages), []);
  }
});

test("both unknown and verified source metadata retain only safe identifiers and actual supplied text", () => {
  const messages = registered([frame("The source says what it says.")], [[{ ...quote("bad/secret", "-71002"),
    verified: false, clipped: true, secret: "SECRET_SENTINEL", url: "https://private.invalid/key" }]]);
  const result = registeredQuoteReading(messages);
  assert.deepEqual(result[0].sources, [{ speakerUid: null, messageId: "-71002", sourceVerified: false,
    sourceRole: "quoted_message_speaker", verificationScope: "message_origin_only", excerptTruncated: true }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_SENTINEL|private\.invalid|bad\/secret/);
  result[0].providedFrame = "Changed projection.";
  result[0].sources[0].messageId = "0";
  assert.equal(registeredQuoteReading(messages)[0].providedFrame, messages[0].content);
  assert.equal(registeredQuoteReading(messages)[0].sources[0].messageId, "-71002");
});

test("per-turn projection keeps a two-frame and 2000-character ceiling without truncating claims", () => {
  const messages = registered([frame("A"), frame("B"), frame("C"), frame("X".repeat(2500))],
    [[quote()], [quote("61002")], [quote("61003")], [quote("61004")]]);
  assert.equal(registeredQuoteReading(messages).length, 2);
  assert.deepEqual(registeredQuoteReading([messages[3]]), []);
  assert.deepEqual(registeredQuoteReading([]), []);
});

test("pruning a low-priority quote cannot leave its reading projection in the retained request", () => {
  const messages = registered([frame("Discarded quote."), frame("Kept preference.")], [[quote()], []], [60, 95]);
  const result = fitContextMessageGroups({ messages }, messages[1].content.length, request => ({
    chars: request.messages.reduce((total, item) => total + item.content.length, 0) }));
  assert.deepEqual(result.messages, [messages[1]]);
  assert.deepEqual(registeredQuoteReading(result.messages), []);
  assert.deepEqual(registeredQuoteReading(messages), [], "low-priority quotes are never projected ahead of final pruning");
});
