import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";

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

test("provider receive cap cancels a stream early and does not retry oversized data", async t => {
  let requests = 0; let chunks = 0; let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new globalThis.Response(new globalThis.ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(4096)); if (chunks === 512) controller.close(); },
      cancel() { cancelled = true; },
    }), { status: 200 });
  });
  const result = await postProviderJson(provider, "test-key", {}, { maxResponseBytes: 8192, retryDelayMs: 0 });
  assert.equal(result.ok, false); assert.equal(result.responseTooLarge, true);
  assert.equal(requests, 1); assert.equal(cancelled, true); assert.ok(chunks < 10);
  assert.equal(result.data, undefined);
});

test("provider receive cap counts UTF-8 bytes for text and JSON-only transports", async t => {
  for (const type of ["text", "json"]) {
    let calls = 0;
    const payload = { content: "测试".repeat(100) };
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return { ok: true, status: 200, [type]: async () => type === "text" ? JSON.stringify(payload) : payload };
    });
    const result = await postProviderJson(provider, "test-key", {}, { maxResponseBytes: 300, retryDelayMs: 0 });
    assert.equal(result.responseTooLarge, true); assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test("bounded stream preserves UTF-8 split across chunks and accepts exact byte limit", async t => {
  const payload = { content: "正常回复" };
  const bytes = Buffer.from(JSON.stringify(payload));
  t.mock.method(globalThis, "fetch", async () => new globalThis.Response(new globalThis.ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  })));
  const result = await postProviderJson(provider, "test-key", {}, { maxResponseBytes: bytes.length });
  assert.equal(result.ok, true); assert.deepEqual(result.data, payload);
});

test("provider failures expose only allowlisted metadata, not echoed image chunks or URLs", async t => {
  const fragment = "/9j/" + "A".repeat(100);
  const url = "https://example.com/private-user-image.png?identity=private";
  t.mock.method(globalThis, "fetch", async () => response(400, { error: { type: "invalid_request_error", message: fragment + " " + url } }));
  const result = await postProviderJson(provider, "test-key", {}, { maxAttempts: 1 });
  assert.equal(result.ok, false); assert.match(result.error, /HTTP 400.*请求参数无效/);
  assert.doesNotMatch(result.error, /AAAA|private|https/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error(url + " " + fragment); });
  const failure = await postProviderJson(provider, "test-key", {}, { maxAttempts: 1 });
  assert.equal(failure.error, "API 网络请求失败");
});
