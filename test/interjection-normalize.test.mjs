import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeInterjectionReply } from "../bridge/thinking.mjs";

describe("normalizeInterjectionReply", () => {
  it("parses fenced json reply", () => {
    assert.equal(normalizeInterjectionReply('```json\n{"reply":"ok"}\n```'), "ok");
  });

  it("parses plain json reply", () => {
    assert.equal(normalizeInterjectionReply('{"reply":"ok"}'), "ok");
  });

  it("accepts short plain text", () => {
    assert.equal(normalizeInterjectionReply("ok"), "ok");
  });

  it("accepts a longer one-line reply", () => {
    const reply = "这段可以稍微多说一点，用一到两句话把态度接住，但还是不要变成分析过程或者长篇解释。";
    assert.equal(normalizeInterjectionReply(reply), reply);
  });

  it("rejects multiline analysis", () => {
    assert.equal(normalizeInterjectionReply("The user seems upset.\nI should answer."), null);
  });

  it("rejects overlong text", () => {
    assert.equal(normalizeInterjectionReply("a".repeat(161)), null);
  });
});
