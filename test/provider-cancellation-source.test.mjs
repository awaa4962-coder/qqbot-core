import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { postProviderJson } from "../bridge/api-providers/transport.mjs";
import { callApiProvider } from "../bridge/api-providers/gateway.mjs";
import { createTraceRecorder, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";
import { chatRunSignal, chatRunStopReason, withChatRun } from "../bridge/cognition/chat-run.mjs";
import { CFG } from "../bridge/config.mjs";

const SECRET = "CANCEL_PRIVATE_SENTINEL";
const provider = { id: "source-test", name: "Source test", endpoint: "https://example.com/v1/chat", auth: "none",
  protocol: "openai-chat", model: "test-model", capabilities: ["chat"] };
const ctx = { message_type: "private", message_id: 987, user_id: 876 };
const scope = { surface: "private", userId: 876 };
const config = () => ({ ...CFG, friendWhitelist: [876], botBlacklist: [] });
const response = (status = 200, data = {}) => ({ status, ok: status < 400, text: async () => JSON.stringify(data) });
const secretReason = () => ({ get message() { throw new Error("reason text read"); },
  toString() { assert.fail("reason coerced"); }, toJSON() { assert.fail("reason stored"); } });
const abortError = () => Object.assign(new Error(SECRET), { name: "AbortError" });

async function capture(t, fetcher, options = {}) {
  let calls = 0;
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls++; return fetcher(...args); });
  const recorder = createTraceRecorder();
  const result = await withMessageTrace(ctx, () => postProviderJson(provider, "", { input: "hello" }, {
    retryDelayMs: 0, ...options, onUsageAttempt: attempt => {
      attempts.push({ ...attempt });
      options.onUsageAttempt?.(attempt);
    },
  }), recorder);
  const traces = recorder.list().items[0].stages.filter(item => item.stage === "model");
  assert.equal(traces.length, result.ok ? 0 : 1);
  if (!result.ok) assert.equal(traces[0].cancellationSource, result.cancellationSource);
  assert.doesNotMatch(JSON.stringify({ result, attempts, traces }), new RegExp(SECRET));
  return { result, attempts, traces, calls };
}

function observeListeners(t) {
  const originalAny = globalThis.AbortSignal.any;
  const tracked = [];
  t.mock.method(globalThis.AbortSignal, "any", signals => {
    const signal = originalAny(signals);
    const add = t.mock.method(signal, "addEventListener");
    const remove = t.mock.method(signal, "removeEventListener");
    const upstream = [...new Set(signals)].map(source => t.mock.method(source, "addEventListener"));
    tracked.push({ signal, add, remove, upstream });
    return signal;
  });
  return () => {
    assert.equal(tracked.length, 1);
    const { add, remove, upstream } = tracked[0];
    assert.ok(upstream.every(listener => listener.mock.callCount() === 0));
    if (add.mock.callCount()) {
      // Backoff's existing timer also listens; check our observer's exact identity.
      const observer = add.mock.calls[0].arguments[1];
      assert.equal(add.mock.calls[0].arguments[0], "abort");
      assert.equal(add.mock.calls.filter(call => call.arguments[1] === observer).length, 1);
      assert.equal(remove.mock.calls.filter(call => call.arguments[1] === observer).length, 1);
    } else assert.equal(remove.mock.callCount(), 1);
  };
}

for (const preAborted of [true, false]) {
  test("NaN caller reason retains observed source: pre-aborted " + preAborted, async t => {
    const caller = new globalThis.AbortController();
    if (preAborted) caller.abort(NaN);
    const { result, attempts, calls } = await capture(t, () => {
      caller.abort(NaN);
      throw abortError();
    }, { signal: caller.signal });
    assert.equal(result.cancellationSource, "caller");
    assert.equal(result.cancelled, true);
    assert.equal(calls, preAborted ? 0 : 1);
    if (!preAborted) assert.equal(attempts[0].cancellationSource, "caller");
  });
}

for (const stage of ["fetch", "response_read"]) {
  for (const source of ["caller", "request_timeout", "chat_run"]) {
    test(source + " abort during " + stage + " records the observed source", async t => {
      const controller = new globalThis.AbortController();
      const cfg = config();
      if (source === "request_timeout") t.mock.method(globalThis.AbortSignal, "timeout", () => controller.signal);
      const cleanup = observeListeners(t);
      let captured;
      const run = async () => {
        const abort = async () => {
          if (source === "chat_run") { cfg.friendWhitelist = []; chatRunStopReason(); }
          else controller.abort(secretReason());
          throw abortError();
        };
        captured = await capture(t, stage === "fetch" ? abort : () => ({ status: 200, ok: true, text: abort }), {
          ...(source === "caller" ? { signal: controller.signal } : {}),
        });
      };
      if (source === "chat_run") await withChatRun(scope, run, { cfg });
      else await run();
      const { result, attempts, calls } = captured;
      assert.equal(result.cancellationSource, source);
      assert.equal(result.cancelled, true);
      assert.equal(result.failureStage, stage);
      assert.equal(result.failureCategory, "aborted");
      assert.equal(result.httpStatus, stage === "fetch" ? 0 : 200);
      assert.equal(attempts[0].cancellationSource, source);
      assert.equal(calls, 1);
      cleanup();
    });
  }
}

for (const source of ["caller", "request_timeout", "chat_run"]) {
  test("already aborted " + source + " makes no attempt", async t => {
    const controller = new globalThis.AbortController();
    controller.abort(secretReason());
    const cfg = config();
    if (source === "request_timeout") t.mock.method(globalThis.AbortSignal, "timeout", () => controller.signal);
    const cleanup = observeListeners(t);
    let captured;
    const run = async () => {
      if (source === "chat_run") { cfg.friendWhitelist = []; chatRunStopReason(); }
      captured = await capture(t, () => assert.fail("pre-aborted fetch"), {
        ...(source === "caller" ? { signal: controller.signal } : {}),
      });
    };
    if (source === "chat_run") await withChatRun(scope, run, { cfg });
    else await run();
    assert.equal(captured.result.cancellationSource, source);
    assert.equal(captured.result.transportAttempts, 0);
    assert.equal(captured.calls, 0);
    assert.equal(captured.attempts.length, 0);
    cleanup();
  });
}

test("one signal shared by chat and caller is deduplicated in merge order", async t => {
  const cfg = config();
  let captured;
  await withChatRun(scope, async () => {
    const shared = chatRunSignal();
    captured = await capture(t, async () => {
      cfg.friendWhitelist = [];
      chatRunStopReason();
      throw abortError();
    }, { signal: shared });
  }, { cfg });
  assert.equal(captured.result.cancellationSource, "chat_run");
});

for (const matching of ["both", "caller", "neither"]) {
  test("merged abort snapshot with two aborted upstreams: " + matching, async t => {
    const timeout = new globalThis.AbortController();
    const caller = new globalThis.AbortController();
    const merged = new globalThis.AbortController();
    const reason = secretReason();
    t.mock.method(globalThis.AbortSignal, "timeout", () => timeout.signal);
    t.mock.method(globalThis.AbortSignal, "any", signals => {
      assert.deepEqual(signals, [timeout.signal, caller.signal]);
      return merged.signal;
    });
    const { result, attempts } = await capture(t, async () => {
      timeout.abort(matching === "both" ? reason : secretReason());
      caller.abort(matching === "neither" ? secretReason() : reason);
      merged.abort(reason);
      throw abortError();
    }, { signal: caller.signal });
    const expected = matching === "both" ? "ambiguous" : matching === "caller" ? "caller" : "unknown";
    assert.equal(result.cancellationSource, expected);
    assert.equal(attempts[0].cancellationSource, expected);
  });
}

test("unknown merged-only abortion is never guessed from reason keywords", async t => {
  const merged = new globalThis.AbortController();
  t.mock.method(globalThis.AbortSignal, "any", () => merged.signal);
  const { result } = await capture(t, async () => { merged.abort(secretReason()); throw abortError(); });
  assert.equal(result.cancellationSource, "unknown");
});

test("source freezes at merged abort even if another upstream aborts later", async t => {
  const timeout = new globalThis.AbortController();
  const caller = new globalThis.AbortController();
  const reason = secretReason();
  t.mock.method(globalThis.AbortSignal, "timeout", () => timeout.signal);
  const { result, attempts } = await capture(t, async () => {
    caller.abort(reason);
    timeout.abort(reason);
    throw abortError();
  }, { signal: caller.signal });
  assert.equal(result.cancellationSource, "caller");
  assert.equal(attempts[0].cancellationSource, "caller");
});

test("remote AbortError without local abort has no cancellation source and still retries", async t => {
  const cleanup = observeListeners(t);
  const { result, attempts, calls } = await capture(t, async () => { throw abortError(); });
  assert.equal(result.failureCategory, "aborted");
  assert.equal(Object.hasOwn(result, "cancellationSource"), false);
  assert.equal(result.cancelled, undefined);
  assert.equal(calls, 2);
  assert.ok(attempts.every(item => !Object.hasOwn(item, "cancellationSource")));
  cleanup();
});

test("retry delay cancellation preserves previous usage and never manufactures an attempt", async t => {
  const caller = new globalThis.AbortController();
  const cleanup = observeListeners(t);
  const pending = capture(t, () => response(503, { usage: { prompt_tokens: 7, completion_tokens: 3 } }), {
    signal: caller.signal, retryDelayMs: 10000,
  });
  await setImmediate();
  caller.abort(secretReason());
  const { result, attempts, calls } = await pending;
  assert.equal(result.cancellationSource, "caller");
  assert.equal(result.httpStatus, 503);
  assert.equal(result.failureStage, "http_status");
  assert.equal(calls, 1);
  assert.equal(attempts[0].usage.prompt_tokens, 7);
  assert.equal(attempts[0].usage.completion_tokens, 3);
  assert.equal(Object.hasOwn(attempts[0], "cancellationSource"), false);
  cleanup();
});

test("late successful body retains old callback status but final outcome is cancelled", async t => {
  const caller = new globalThis.AbortController();
  const { result, attempts } = await capture(t, () => ({ status: 200, ok: true, text: async () => {
    caller.abort(secretReason());
    return JSON.stringify({ content: SECRET, usage: { prompt_tokens: 11 } });
  } }), { signal: caller.signal });
  assert.equal(result.cancellationSource, "caller");
  assert.equal(result.failureStage, "cancelled");
  assert.equal(result.data, undefined);
  assert.equal(attempts[0].status, "ok");
  assert.equal(attempts[0].cancellationSource, "caller");
  assert.equal(attempts[0].usage.prompt_tokens, 11);
});

test("callback mutation and throwing do not alter source or old outcomes", async t => {
  const caller = new globalThis.AbortController();
  const cleanup = observeListeners(t);
  const { result, attempts } = await capture(t, async () => {
    caller.abort(secretReason());
    throw abortError();
  }, { signal: caller.signal, onUsageAttempt: attempt => {
    attempt.cancellationSource = SECRET;
    throw new Error(SECRET);
  } });
  assert.equal(result.cancellationSource, "caller");
  assert.equal(attempts[0].cancellationSource, "caller");
  cleanup();
});

test("callback-triggered abort is observed only by the final cancellation", async t => {
  const caller = new globalThis.AbortController();
  const { result, attempts } = await capture(t, () => response(), {
    signal: caller.signal, onUsageAttempt: () => { caller.abort(secretReason()); throw new Error(SECRET); },
  });
  assert.equal(result.cancellationSource, "caller");
  assert.equal(attempts[0].status, "ok");
  assert.equal(Object.hasOwn(attempts[0], "cancellationSource"), false);
});

for (const guard of [() => "task_budget", () => { throw new Error(SECRET); }]) {
  test("non-signal stop guard has no source and disposes the observer", async t => {
    const cleanup = observeListeners(t);
    const { result, calls } = await capture(t, () => assert.fail("guard fetch"), { beforeAttempt: guard });
    assert.equal(Object.hasOwn(result, "cancellationSource"), false);
    assert.equal(result.failureCategory, "unknown");
    assert.equal(calls, 0);
    cleanup();
  });
}

for (const duration of [undefined, 0, 17, 900000]) {
  test("merge ordering, shared deadline and timeout duration remain unchanged: " + duration, async t => {
    const timeout = new globalThis.AbortController();
    const caller = new globalThis.AbortController();
    let timeouts = 0;
    const originalAny = globalThis.AbortSignal.any;
    let merged;
    t.mock.method(globalThis.AbortSignal, "timeout", ms => {
      timeouts++;
      assert.equal(ms, duration === 17 ? 17 : duration === 900000 ? 300000 : 30000);
      return timeout.signal;
    });
    t.mock.method(globalThis.AbortSignal, "any", signals => {
      assert.deepEqual(signals, [timeout.signal, caller.signal]);
      merged = originalAny(signals);
      return merged;
    });
    let fetched = 0;
    const { result, attempts, calls } = await capture(t, (_url, request) => {
      assert.equal(request.signal, merged);
      assert.equal(request.body, '{"input":"hello"}');
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "error");
      assert.deepEqual(request.headers, { "Content-Type": "application/json" });
      return response(++fetched === 1 ? 503 : 200, { usage: { prompt_tokens: 9 } });
    }, { timeoutMs: duration, signal: caller.signal });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(timeouts, 1);
    assert.equal(attempts[0].usage.prompt_tokens, 9);
    assert.equal(Object.hasOwn(result, "cancellationSource"), false);
  });
}

for (const status of [200, 400]) {
  test("terminal HTTP " + status + " disposes the merged observer", async t => {
    const cleanup = observeListeners(t);
    const { result } = await capture(t, () => response(status));
    assert.equal(result.ok, status === 200);
    cleanup();
  });
}

test("trace cancellationSource accepts only own fixed enum without getters or coercion", () => {
  const recorder = createTraceRecorder();
  const record = recorder.begin(ctx);
  const allowed = ["request_timeout", "chat_run", "caller", "ambiguous", "unknown"];
  for (const cancellationSource of allowed) {
    recorder.append(record, "model", { cancellationSource, error: SECRET, code: SECRET, path: SECRET, text: SECRET });
    assert.equal(recorder.list().items[0].stages.at(-1).cancellationSource, cancellationSource);
  }
  const getter = Object.defineProperty({}, "cancellationSource", { get() { throw new Error("getter read"); } });
  for (const details of [getter, Object.create({ cancellationSource: "caller" }),
    ...[SECRET, "AbortError", "ETIMEDOUT", "request_timeout/secret", 1, null, secretReason()].map(cancellationSource => ({ cancellationSource })),
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } })]) {
    recorder.append(record, "model", details);
    assert.equal(Object.hasOwn(recorder.list().items[0].stages.at(-1), "cancellationSource"), false);
  }
  assert.doesNotMatch(JSON.stringify(recorder.list()), new RegExp(SECRET));
});

test("gateway success keeps its rich usage record and adds no bare model record", async t => {
  t.mock.method(globalThis, "fetch", async () => response(200, {
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
  }));
  const recorder = createTraceRecorder();
  const result = await withMessageTrace(ctx, () => callApiProvider(provider.id, {
    messages: [{ role: "user", content: "hello" }],
  }, { provider, key: "", usageTask: "private_chat", usagePosition: "primary" }), recorder);
  assert.equal(result.ok, true);
  const models = recorder.list().items[0].stages.filter(item => item.stage === "model");
  const successes = models.filter(item => item.status === "ok");
  assert.equal(successes.length, 1);
  assert.equal(successes[0].provider, provider.id);
  assert.equal(successes[0].promptTokens, 13);
  assert.equal(successes[0].completionTokens, 5);
  assert.equal(successes[0].usageReported, true);
  assert.ok(models.every(item => !Object.hasOwn(item, "cancellationSource")));
});
