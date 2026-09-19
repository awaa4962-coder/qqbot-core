import assert from "node:assert/strict";
import test from "node:test";

import { postProviderJson } from "../bridge/api-providers/transport.mjs";

const provider = {
  name: "Test API",
  endpoint: "https://example.com/v1/chat",
  auth: "bearer",
};

test("provider transport retries one transient server failure", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response(calls === 1 ? 503 : 200, calls === 1 ? { error: { message: "busy" } } : { ok: true });
  };
  try {
    const result = await postProviderJson(provider, "test-key", { input: "hello" }, { retryDelayMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.ok(result.durationMs >= 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider transport does not retry authentication failures", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response(401, { error: { message: "unauthorized" } });
  };
  try {
    const result = await postProviderJson(provider, "test-key", {}, { retryDelayMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider transport retries invalid JSON 200 responses without reporting success", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "<html>not JSON</html>" };
  };
  try {
    const result = await postProviderJson(provider, "test-key", {}, { retryDelayMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.invalidResponse, true);
    assert.match(result.error, /JSON/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("provider transport rejects empty and scalar JSON bodies, but can recover", async () => {
  const original = globalThis.fetch;
  try {
    for (const text of ["", "null", "[]", '"text"']) {
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => text });
      assert.equal((await postProviderJson(provider, "test-key", {}, { maxAttempts: 1 })).ok, false);
    }
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1
      ? { ok: true, status: 200, text: async () => "invalid" }
      : response(200, { choices: [{ message: { content: "recovered" } }] });
    assert.equal((await postProviderJson(provider, "test-key", {}, { retryDelayMs: 0 })).ok, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}
