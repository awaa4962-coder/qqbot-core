import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { postProviderJson, buildProviderHeaders } from "../bridge/api-providers/transport.mjs";
import { createTraceRecorder, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";

const SECRET = "DIAG_PRIVATE_SENTINEL_8af6";
const provider = { name: "Test " + SECRET, endpoint: "https://example.com/v1/chat?private=" + SECRET, auth: "bearer" };
const ctx = { message_type: "private", message_id: 123, user_id: 456 };
const stages = ["fetch", "response_read", "json_parse", "http_status", "cancelled"];
const categories = ["network", "http", "invalid_json", "response_limit", "aborted", "unknown"];

function metadata(value) {
  const result = { httpStatus: value.httpStatus };
  for (const key of ["failureStage", "failureCategory"]) if (Object.hasOwn(value, key)) result[key] = value[key];
  return result;
}

function response(status, data = {}) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) };
}

async function capture(t, fetcher, options = {}, body = {}) {
  const attempts = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (...args) => { calls++; return fetcher(...args); });
  const recorder = createTraceRecorder();
  const result = await withMessageTrace(ctx, () => postProviderJson(provider, SECRET, body, {
    retryDelayMs: 0, ...options,
    onUsageAttempt: attempt => { attempts.push(attempt); options.onUsageAttempt?.(attempt); },
  }), recorder);
  const trace = recorder.list().items[0].stages.filter(item => item.stage === "model");
  assert.equal(trace.length, result.ok ? 0 : 1);
  if (!result.ok) {
    assert.deepEqual(metadata(trace[0]), metadata(result));
    assert.equal(trace[0].transportAttempts, result.transportAttempts);
  }
  assert.doesNotMatch(JSON.stringify(trace), new RegExp(SECRET));
  return { result, attempts, trace, calls };
}

function assertMetadata(value, httpStatus, failureStage, failureCategory) {
  const expected = failureStage ? { httpStatus, failureStage, failureCategory } : { httpStatus };
  assert.deepEqual(metadata(value), expected);
  assert.doesNotMatch(JSON.stringify(metadata(value)), new RegExp(SECRET));
}

for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) {
  test("HTTP " + status + " exposes only fixed metadata and keeps the retry decision", async t => {
    const retryable = [429, 500, 502, 503, 504].includes(status);
    const { result, attempts, calls } = await capture(t, () => response(status, {
      error: { message: SECRET, type: "invalid_request_error" }, reasoning_content: SECRET,
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }));
    assertMetadata(result, status, "http_status", "http");
    assert.equal(result.error, provider.name + " HTTP " + status + ": 请求参数无效");
    assert.equal(result.ok, false);
    assert.equal(calls, retryable ? 2 : 1);
    assert.equal(result.transportAttempts, calls);
    assert.equal(attempts.length, calls);
    for (const attempt of attempts) {
      assertMetadata(attempt, status, "http_status", "http");
      assert.equal(attempt.status, "error");
      assert.equal(attempt.usage.prompt_tokens, 7);
      assert.equal(attempt.usage.completion_tokens, 3);
      assert.ok(attempt.durationMs >= 0);
    }
  });
}

for (const text of ["", SECRET, "null", "[]", "3", '"' + SECRET + '"']) {
  test("invalid JSON or shape remains retryable with parsing metadata: " + text.length, async t => {
    const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true, text: async () => text }));
    assert.equal(calls, 2);
    assert.equal(result.transportAttempts, 2);
    assert.equal(result.invalidResponse, true);
    assert.equal(result.error, "接口未返回有效 JSON 对象");
    assertMetadata(result, 200, "json_parse", "invalid_json");
    for (const attempt of attempts) assertMetadata(attempt, 200, "json_parse", "invalid_json");
  });
}

test("an invalid JSON 503 is a parse failure, not a proven HTTP body error", async t => {
  const { result, calls } = await capture(t, () => ({ status: 503, ok: false, text: async () => SECRET }));
  assertMetadata(result, 503, "json_parse", "invalid_json");
  assert.equal(result.invalidResponse, true);
  assert.equal(calls, 2);
});

test("stream parsing records parsing only after all bytes have been read", async t => {
  let released = 0;
  const { result, calls } = await capture(t, () => {
    let read = false;
    return { status: 200, ok: true, body: { getReader: () => ({
      read: async () => read ? { done: true } : (read = true, { value: Buffer.from(SECRET), done: false }),
      releaseLock: () => { released++; },
    }) } };
  });
  assertMetadata(result, 200, "json_parse", "invalid_json");
  assert.equal(calls, 2);
  assert.equal(released, 2);
});

for (const type of ["stream", "text", "json"]) {
  test(type + " read failure remains legacy invalid JSON but its cause is unknown", async t => {
    let released = 0;
    const fail = async () => { throw new Error(SECRET + " timeout aborted redirect invalid JSON"); };
    const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true,
      ...(type === "stream" ? { body: { getReader: () => ({ read: fail, releaseLock: () => { released++; } }) } }
        : { [type]: fail }),
    }));
    assertMetadata(result, 200, "response_read", "unknown");
    assert.equal(result.invalidResponse, true);
    assert.equal(result.error, "接口未返回有效 JSON 对象");
    assert.equal(calls, 2);
    assert.equal(released, type === "stream" ? 2 : 0);
    for (const attempt of attempts) assertMetadata(attempt, 200, "response_read", "unknown");
  });
}

test("JSON-only rejection cannot distinguish body reading from native parsing", async t => {
  const { result } = await capture(t, () => ({ status: 200, ok: true,
    json: async () => { throw new SyntaxError(SECRET); },
  }), { maxAttempts: 1 });
  assertMetadata(result, 200, "response_read", "unknown");
  assert.equal(result.invalidResponse, true);
});

test("a synthetic 30007ms read failure proves neither timeout nor abortion", async t => {
  let now = 0;
  const deadline = new globalThis.AbortController();
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis.AbortSignal, "timeout", duration => {
    assert.equal(duration, 30000);
    return deadline.signal;
  });
  const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true,
    text: async () => { now = 30007; throw new Error(SECRET); },
  }), { maxAttempts: 1 });
  assert.equal(result.durationMs, 30007);
  assert.equal(attempts[0].durationMs, 30007);
  assertMetadata(result, 200, "response_read", "unknown");
  assert.equal(result.error, "接口未返回有效 JSON 对象");
  assert.equal(result.cancelled, undefined);
  assert.equal(calls, 1);
});

test("an own fixed socket code can identify a network read failure without parsing", async t => {
  const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true,
    text: async () => { throw Object.assign(new Error(SECRET), { code: "ECONNRESET" }); },
  }), { maxAttempts: 1 });
  assertMetadata(result, 200, "response_read", "network");
  assertMetadata(attempts[0], 200, "response_read", "network");
  assert.equal(result.invalidResponse, true);
  assert.equal(result.error, "接口未返回有效 JSON 对象");
  assert.equal(calls, 1);
});

test("fetch failures do not classify secret exception keywords", async t => {
  const { result, attempts, calls } = await capture(t, async () => { throw new Error(SECRET + " timeout aborted"); });
  assertMetadata(result, 0, "fetch", "network");
  assert.equal(result.error, "API 请求超时", "legacy string classification is intentionally unchanged");
  assert.equal(calls, 2);
  for (const attempt of attempts) assertMetadata(attempt, 0, "fetch", "network");
});

for (const maxAttempts of [1, 2, 3, 99]) {
  test("maxAttempts " + maxAttempts + " still caps actual requests exactly", async t => {
    const { result, attempts, calls } = await capture(t, async () => { throw new Error(SECRET); }, { maxAttempts });
    assert.equal(calls, Math.min(maxAttempts, 3));
    assert.equal(result.transportAttempts, calls);
    assert.equal(attempts.length, calls);
    assert.equal(result.error, "API 网络请求失败");
    assertMetadata(result, 0, "fetch", "network");
  });
}

test("retry recovery keeps one shared deadline and emits no failure on final success", async t => {
  const deadline = new globalThis.AbortController();
  let timeouts = 0;
  let count = 0;
  const signals = [];
  t.mock.method(globalThis.AbortSignal, "timeout", duration => {
    timeouts++;
    assert.equal(duration, 300000);
    return deadline.signal;
  });
  const { result, attempts, calls } = await capture(t, (_url, request) => {
    signals.push(request.signal);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.body, '{"input":"hello"}');
    assert.deepEqual(request.headers, buildProviderHeaders(provider, SECRET));
    return ++count === 1 ? response(503) : response(200, { usage: { prompt_tokens: 4 } });
  }, { timeoutMs: Number.MAX_SAFE_INTEGER }, { input: "hello" });
  assert.equal(timeouts, 1);
  assert.equal(signals[0], signals[1]);
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assertMetadata(result, 200);
  assertMetadata(attempts[0], 503, "http_status", "http");
  assertMetadata(attempts[1], 200);
  assert.equal(attempts[1].status, "ok");
  assert.equal(attempts[1].usage.prompt_tokens, 4);
});

test("premature signal cancellation reports zero attempts and no usage callback", async t => {
  const controller = new globalThis.AbortController();
  controller.abort(SECRET);
  const { result, attempts, calls } = await capture(t, () => response(200), { signal: controller.signal });
  assertMetadata(result, 0, "cancelled", "aborted");
  assert.equal(calls, 0);
  assert.equal(result.transportAttempts, 0);
  assert.equal(attempts.length, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, "API 请求超时");
});

test("beforeAttempt cancellation is not evidence of signal abortion", async t => {
  const { result, attempts, calls } = await capture(t, () => response(200), { beforeAttempt: () => "tool_budget" });
  assertMetadata(result, 0, "cancelled", "unknown");
  assert.equal(calls, 0);
  assert.equal(result.transportAttempts, 0);
  assert.equal(attempts.length, 0);
  assert.equal(result.error, "tool_budget");
});

test("beforeAttempt throwing keeps the legacy tool_budget stop and zero attempts", async t => {
  const { result, attempts, calls } = await capture(t, () => response(200), {
    beforeAttempt: () => { throw new Error(SECRET); },
  });
  assertMetadata(result, 0, "cancelled", "unknown");
  assert.equal(result.error, "tool_budget");
  assert.equal(result.transportAttempts, 0);
  assert.equal(calls, 0);
  assert.equal(attempts.length, 0);
});

for (const type of ["fetch", "stream"]) {
  test(type + " abortion preserves observed stage without inferring its source", async t => {
    const controller = new globalThis.AbortController();
    const abort = async () => {
      controller.abort(SECRET);
      throw new globalThis.DOMException(SECRET, "AbortError");
    };
    const { result, attempts, calls } = await capture(t, type === "fetch" ? abort : () => ({ status: 200, ok: true,
      body: { getReader: () => ({ read: abort, releaseLock() {} }) },
    }), { signal: controller.signal });
    assertMetadata(result, type === "fetch" ? 0 : 200, type === "fetch" ? "fetch" : "response_read", "aborted");
    assert.deepEqual(metadata(attempts[0]), metadata(result));
    assert.equal(result.cancelled, true);
    assert.equal(result.error, "API 请求超时");
    assert.equal(calls, 1);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "error");
  });
}

test("cancellation in backoff does not manufacture another attempt", async t => {
  const controller = new globalThis.AbortController();
  const pending = capture(t, () => response(503), { signal: controller.signal, retryDelayMs: 10000 });
  await setImmediate();
  controller.abort(SECRET);
  const { result, attempts, calls } = await pending;
  assertMetadata(result, 503, "http_status", "aborted");
  assertMetadata(attempts[0], 503, "http_status", "http");
  assert.equal(calls, 1);
  assert.equal(result.transportAttempts, 1);
});

test("late successful body after cancellation remains cancelled without retaining body", async t => {
  const controller = new globalThis.AbortController();
  const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true,
    text: async () => { controller.abort(SECRET); return JSON.stringify({ content: SECRET }); },
  }), { signal: controller.signal });
  assertMetadata(result, 200, "cancelled", "aborted");
  assertMetadata(attempts[0], 200);
  assert.equal(attempts[0].status, "ok", "legacy completed-attempt callback status is unchanged");
  assert.equal(result.data, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.equal(calls, 1);
});

for (const type of ["stream", "text", "json"]) {
  test(type + " response limit keeps the same cap and never retries", async t => {
    let cancelled = 0;
    let released = 0;
    const data = { content: SECRET.repeat(30) };
    const { result, attempts, calls } = await capture(t, () => ({ status: 200, ok: true,
      ...(type === "stream" ? { body: { getReader: () => ({
        read: async () => ({ done: false, value: Buffer.from(JSON.stringify(data)) }),
        cancel: () => { cancelled++; return Promise.reject(new Error(SECRET)); },
        releaseLock: () => { released++; },
      }) } } : { [type]: async () => type === "text" ? JSON.stringify(data) : data }),
    }), { maxResponseBytes: 32 });
    assertMetadata(result, 200, "response_read", "response_limit");
    assert.equal(result.responseTooLarge, true);
    assert.equal(result.invalidResponse, false);
    assert.equal(result.error, "模型接口响应超过接收大小上限");
    assert.equal(result.data, undefined);
    assert.equal(calls, 1);
    assert.equal(attempts.length, 1);
    assert.equal(cancelled, type === "stream" ? 1 : 0);
    assert.equal(released, type === "stream" ? 1 : 0);
  });
}

test("callback mutation and throwing cannot alter retries, return values or trace", async t => {
  const { result, calls } = await capture(t, () => response(503), { onUsageAttempt: attempt => {
    attempt.httpStatus = SECRET;
    attempt.failureStage = SECRET;
    attempt.failureCategory = SECRET;
    throw new Error(SECRET);
  } });
  assertMetadata(result, 503, "http_status", "http");
  assert.equal(calls, 2);
});

test("trace append failure cannot alter delivery or callback accounting", async t => {
  let calls = 0;
  let callbacks = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(400); });
  const recorder = createTraceRecorder();
  const append = recorder.append;
  recorder.append = (record, stage, details) => {
    if (stage === "model") throw new Error(SECRET);
    return append(record, stage, details);
  };
  const result = await withMessageTrace(ctx, () => postProviderJson(provider, SECRET, {}, {
    onUsageAttempt: () => { callbacks++; throw new Error(SECRET); },
  }), recorder);
  assert.equal(result.ok, false);
  assertMetadata(result, 400, "http_status", "http");
  assert.equal(calls, 1);
  assert.equal(callbacks, 1);
});

test("metadata never invokes exception name getters or trusts prototype names", async t => {
  let getters = 0;
  const error = new Error(SECRET);
  Object.defineProperty(error, "name", { get() { getters++; throw new Error(SECRET); } });
  const first = await capture(t, async () => { throw error; }, { maxAttempts: 1 });
  assertMetadata(first.result, 0, "fetch", "network");
  assert.equal(getters, 0);
  const inherited = Object.create({ name: "AbortError", message: SECRET });
  const second = await capture(t, async () => { throw inherited; }, { maxAttempts: 1 });
  assertMetadata(second.result, 0, "fetch", "network");
});

for (const marker of [{ code: "ABORT_ERR" }, { name: "AbortError" }, { name: "TimeoutError" }]) {
  test("own fixed abortion marker is recorded without changing retries: " + JSON.stringify(marker), async t => {
    const { result, calls } = await capture(t, async () => { throw Object.assign(new Error(SECRET), marker); });
    assertMetadata(result, 0, "fetch", "aborted");
    assert.equal(result.cancelled, undefined);
    assert.equal(calls, 2);
  });
}

test("trace accepts only fixed stages/categories and safe integer HTTP statuses", () => {
  const recorder = createTraceRecorder();
  const record = recorder.begin(ctx);
  for (const failureStage of stages) for (const failureCategory of categories) {
    recorder.append(record, "model", { failureStage, failureCategory, httpStatus: 599,
      error: SECRET, headers: { Authorization: SECRET }, body: SECRET, url: SECRET, reasoning_content: SECRET });
  }
  const projected = recorder.list().items[0].stages.filter(item => item.stage === "model");
  assert.equal(projected.length, stages.length * categories.length);
  for (const item of projected) {
    assert.ok(stages.includes(item.failureStage));
    assert.ok(categories.includes(item.failureCategory));
    assert.equal(item.httpStatus, 599);
    assert.deepEqual(Object.keys(item).sort(), ["stage", "elapsedMs", "failureStage", "failureCategory", "httpStatus"].sort());
  }
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(SECRET));
});

test("trace new metadata ignores prototype values/getters and performs no coercion", () => {
  let getters = 0;
  const poison = { toString() { throw new Error(SECRET); }, valueOf() { throw new Error(SECRET); } };
  const recorder = createTraceRecorder();
  const record = recorder.begin(ctx);
  const details = Object.create({ failureStage: "fetch", failureCategory: "network", httpStatus: 200 });
  recorder.append(record, "model", details);
  assert.deepEqual(metadata(recorder.list().items[0].stages.at(-1)), { httpStatus: undefined });
  for (const key of ["failureStage", "failureCategory", "httpStatus"]) {
    Object.defineProperty(details, key, { get() { getters++; throw new Error(SECRET); } });
  }
  recorder.append(record, "model", details);
  assert.equal(getters, 0);
  recorder.append(record, "model", { failureStage: poison, failureCategory: poison, httpStatus: poison });
  assert.deepEqual(metadata(recorder.list().items[0].stages.at(-1)), { httpStatus: 0 });
  recorder.append(record, "model", { failureStage: "constructor", failureCategory: "__proto__", httpStatus: 200 });
  assert.deepEqual(metadata(recorder.list().items[0].stages.at(-1)), { httpStatus: 200 });
  recorder.append(record, "model", { failureStage: SECRET, failureCategory: SECRET, httpStatus: SECRET });
  recorder.append(record, "model", { httpStatus: "200" });
  assert.deepEqual(metadata(recorder.list().items[0].stages.at(-1)), { httpStatus: 0 });
  recorder.append(record, "model", new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }));
  assert.deepEqual(metadata(recorder.list().items[0].stages.at(-1)), { httpStatus: undefined });
  assert.doesNotMatch(JSON.stringify(recorder.list()), new RegExp(SECRET));
});

test("HTTP metadata normalizes unsafe values to zero without changing legacy status", async t => {
  for (const status of [0, 99, 100, 200.5, 599, 600, NaN, Infinity]) {
    const { result, attempts } = await capture(t, () => ({ status, ok: true, text: async () => "{}" }), { maxAttempts: 1 });
    assertMetadata(result, Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0);
    assert.equal(result.status, status);
    assert.deepEqual(metadata(attempts[0]), metadata(result));
    const recorder = createTraceRecorder();
    const record = recorder.begin(ctx);
    recorder.append(record, "model", { httpStatus: status });
    assert.equal(recorder.list().items[0].stages.at(-1).httpStatus, result.httpStatus);
  }
});
