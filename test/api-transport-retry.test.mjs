import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";

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

test("provider retries share one bounded total deadline signal", async t => {
  const deadline = new globalThis.AbortController();
  const signals = []; let timeouts = 0;
  t.mock.method(globalThis.AbortSignal, "timeout", duration => {
    timeouts++;
    assert.equal(duration, 5 * 60 * 1000);
    return deadline.signal;
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signals.push(options.signal);
    return response(signals.length === 1 ? 503 : 200, { ok: true });
  });
  const result = await postProviderJson(provider, "test-key", {}, { timeoutMs: Number.MAX_SAFE_INTEGER, retryDelayMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(timeouts, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test("pre-cancelled provider requests never start a transport attempt", async t => {
  const controller = new globalThis.AbortController();
  controller.abort(new Error("private cancellation detail"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(200, { ok: true }); });
  const result = await postProviderJson(provider, "test-key", {}, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.transportAttempts, 0);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private cancellation detail/);
});

test("cancellation during retry backoff stops without a second request", { timeout: 1000 }, async t => {
  const controller = new globalThis.AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(503, { error: { type: "busy" } }); });
  const pending = postProviderJson(provider, "test-key", {}, { signal: controller.signal, retryDelayMs: 10000 });
  await setImmediate();
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.transportAttempts, 1);
  assert.equal(calls, 1);
});

test("a response completed after cancellation is not success and retains no body", async t => {
  const controller = new globalThis.AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return { ok: true, status: 200, text: async () => {
      controller.abort();
      return JSON.stringify({ content: "late private model body" });
    } };
  });
  const result = await postProviderJson(provider, "test-key", {}, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /late private model body/);
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

test("provider responses remain bounded when a task omits or raises its receive cap", async t => {
  for (const maxResponseBytes of [undefined, 0, 2 * 1024 * 1024]) {
    let requests = 0; let chunks = 0; let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new globalThis.Response(new globalThis.ReadableStream({
        pull(controller) { chunks++; controller.enqueue(new Uint8Array(65536)); if (chunks === 64) controller.close(); },
        cancel() { cancelled = true; },
      }), { status: 200 });
    });
    const result = await postProviderJson(provider, "test-key", {}, { maxResponseBytes, retryDelayMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.responseTooLarge, true);
    assert.equal(requests, 1);
    assert.equal(cancelled, true);
    assert.ok(chunks < 32);
    t.mock.restoreAll();
  }
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
