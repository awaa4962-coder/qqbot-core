import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeOutboundText,
  sendTextToGroup,
  sendTextToPrivate,
  splitLongText,
} from "../bridge/outbound-message.mjs";

async function withMockFetch(assertions, fn) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function(url, options) {
    calls.push({ url, body: JSON.parse(options.body) });
    return { json: async () => ({ status: "ok" }) };
  };
  try {
    const result = await fn(calls);
    assertions(calls, result);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

describe("outbound message", () => {
  it("normalizes outbound text", () => {
    assert.equal(normalizeOutboundText(" a\r\nb "), "a\nb");
  });

  it("splits 3000 chars into bounded chunks", () => {
    const parts = splitLongText("甲。".repeat(1500));
    assert.ok(parts.length > 1);
    assert.ok(parts.every(part => part.length <= 900));
  });

  it("caps configured maxLen at 1200", () => {
    const parts = splitLongText("乙".repeat(2500), 5000);
    assert.ok(parts.every(part => part.length <= 1200));
  });

  it("sendTextToGroup sends multiple chunks and only first replyTo", async () => {
    await withMockFetch((calls, result) => {
      assert.ok(Array.isArray(result));
      assert.ok(calls.length > 1);
      assert.equal(calls[0].body.message[0].type, "reply");
      assert.equal(calls[1].body.message[0].type, "text");
    }, () => sendTextToGroup({ groupId: 123, text: "丙。".repeat(1500), replyTo: 999 }));
  });

  it("sendTextToPrivate sends multiple chunks", async () => {
    await withMockFetch(calls => {
      assert.ok(calls.length > 1);
      assert.ok(calls.every(call => call.body.user_id === 456));
    }, () => sendTextToPrivate({ userId: 456, text: "丁。".repeat(1500) }));
  });
});
