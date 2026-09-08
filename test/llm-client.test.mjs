import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { deepseekChat } from "../bridge/clients/providers/deepseek.mjs";
import { mimoVision } from "../bridge/clients/providers/mimo.mjs";
import { llmCall } from "../bridge/clients/llm-client.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchBody() {
  let body = null;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    };
  };
  return () => body;
}

describe("llm client provider token fields", () => {
  it("shares safe transport without adding retries to legacy calls", async () => {
    const calls = [];
    globalThis.fetch = async (_url, options) => { calls.push(options); return { ok: false, status: 503, json: async () => ({}) }; };
    const result = await llmCall({ provider: "test", apiKey: "test-only", endpoint: "https://example.com/v1/chat/completions", model: "synthetic", messages: [] });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, "error");
    assert.equal(calls[0].headers.Authorization, "Bearer test-only");
  });

  it("legacy endpoint validation rejects private URLs before network access", async () => {
    globalThis.fetch = () => assert.fail("must not fetch an unapproved local endpoint");
    const result = await llmCall({ provider: "test", apiKey: "test-only", endpoint: "http://127.0.0.1/v1/chat/completions", model: "synthetic", messages: [] });
    assert.equal(result.ok, false);
  });

  it("uses max_completion_tokens for MiMo requests", async () => {
    const readBody = mockFetchBody();
    await mimoVision([], { maxTokens: 123 });
    const body = readBody();

    assert.equal(body.model, "mimo-v2.5");
    assert.equal(body.max_completion_tokens, 123);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.match(body.messages[0].content[0].text, /主体、可见文字、表情或动作/);
    assert.match(body.messages[0].content[0].text, /不要强行认人/);
  });

  it("keeps max_tokens for DeepSeek requests", async () => {
    const readBody = mockFetchBody();
    await deepseekChat([{ role: "user", content: "hi" }], { maxTokens: 456 });
    const body = readBody();

    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.max_tokens, 456);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  });
});
