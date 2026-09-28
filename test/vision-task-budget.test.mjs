import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { buildObjectiveVisionMessages, VISION_PROMPT_VERSION } from "../bridge/system-prompts/vision.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-vision-task-budget-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { callVisionText } = await import("../bridge/vision-provider.mjs");
const { describeVisionImages } = await import("../bridge/vision.mjs");
const { createModelTaskBudget } = await import("../bridge/api-providers/task-budget.mjs");
const { clearVisionDescriptionCache, getVisionDescriptionCacheStatus } = await import("../bridge/vision/description-cache.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { withChatRun, assertChatRunCurrent, chatRunSignal } = await import("../bridge/cognition/chat-run.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");

const DESCRIPTION = "A red rectangle with no visible text.";
const SCOPE = { surface: "private", userId: 601 };
const raw = text => ({ choices: [{ message: { content: text } }] });
const result = text => ({ ok: true, provider: "synthetic-vision", raw: raw(text) });
const request = () => ({ messages: [{ role: "user", content: "pixel facts" }],
  maxTokens: 512, timeoutMs: 20000, maxAttempts: 1, maxResponseBytes: 262144 });
const provider = id => ({ id, model: id, protocol: "openai-chat", auth: "none",
  endpoint: "https://vision.invalid/" + id, enabled: true, capabilities: ["text", "vision"] });
const config = () => ({ providers: { "vision-primary": provider("vision-primary"), "vision-fallback": provider("vision-fallback") },
  routes: { vision: { primary: "vision-primary", fallback: "vision-fallback", reasoning: "economy" } } });
const images = () => ({ images: [{ index: 1, width: 8, height: 4, animated: false, digest: "ab".repeat(32),
  content: { type: "image_url", image_url: { url: "data:image/jpeg;base64,c3ludGhldGlj" } } }], requested: 1, failed: 0, omitted: 0 });
const options = extra => ({ config: config(), scope: SCOPE, budgetClock: () => 0, assertCurrent: () => {}, ...extra });

test.before(t => t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request")));
test.beforeEach(() => clearVisionDescriptionCache());
test.afterEach(() => clearVisionDescriptionCache());

test("vision budget admits two logical calls, two physical attempts and 512 tokens each", () => {
  const budget = createModelTaskBudget("vision", { now: () => 0 });
  for (let slot = 0; slot < 2; slot++) {
    const prepared = budget.prepare(request());
    assert.equal(prepared.maxAttempts, 1);
    assert.equal(prepared.maxTokens, 512);
    assert.equal(prepared.maxResponseBytes, 262144);
    assert.equal(prepared.beforeAttempt(), "");
    if (slot === 1) assert.equal(prepared.beforeAttempt(), "task_budget");
  }
  assert.deepEqual(budget.snapshot(), { calls: 2, transportAttempts: 2,
    requestedInputChars: 22, requestedCompletionTokens: 1024 });
  assert.throws(() => budget.prepare(request()), { code: "MODEL_TASK_BUDGET", message: "task_budget" });
  const oversized = createModelTaskBudget("vision", { now: () => 0 });
  assert.throws(() => oversized.prepare({ ...request(), maxTokens: 513 }),
    { code: "MODEL_TASK_BUDGET", message: "task_output_budget" });
  assert.equal(oversized.prepare({ ...request(), maxResponseBytes: 524288 }).maxResponseBytes, 262144);
});

test("sticker vision budget admits two calls and four attempts with bounded input and output", () => {
  const budget = createModelTaskBudget("sticker_vision", { now: () => 0 });
  const input = { ...request(), maxAttempts: 2, messages: [{ role: "user", content: "x".repeat(14000) }] };
  for (let slot = 0; slot < 2; slot++) {
    const prepared = budget.prepare(input);
    assert.equal(prepared.maxAttempts, 2);
    assert.equal(prepared.beforeAttempt(), "");
    assert.equal(prepared.beforeAttempt(), "");
    if (slot === 1) assert.equal(prepared.beforeAttempt(), "task_budget");
  }
  assert.deepEqual(budget.snapshot(), { calls: 2, transportAttempts: 4,
    requestedInputChars: 56000, requestedCompletionTokens: 2048 });
  assert.throws(() => budget.prepare(input), { code: "MODEL_TASK_BUDGET", message: "task_budget" });
});

test("uncached sticker callers share the default deadline, signal and retry reservations", async () => {
  let now = 0;
  const calls = [];
  const controller = new globalThis.AbortController();
  const input = { ...request(), signal: controller.signal, timeoutMs: 30000,
    maxAttempts: undefined, maxResponseBytes: undefined };
  const original = JSON.stringify(input);
  const output = await callVisionText(input, { budgetClock: () => now,
    callSlot: async (task, position, prepared) => {
      calls.push({ position, prepared });
      assert.equal(task, "vision");
      assert.equal(prepared.maxTokens, 512);
      assert.equal(prepared.maxAttempts, 2);
      assert.equal(prepared.maxResponseBytes, 262144);
      assert.equal(prepared.beforeAttempt(), "");
      assert.equal(prepared.beforeAttempt(), "");
      assert.doesNotMatch(JSON.stringify(prepared.messages), /PRIVATE_REASONING/);
      if (position === "primary") {
        assert.equal(prepared.timeoutMs, 30000);
        now = 59000;
        return { ok: true, raw: { choices: [{ message: { reasoning_content: "PRIVATE_REASONING" } }] } };
      }
      assert.equal(prepared.timeoutMs, 1000);
      assert.equal(prepared.signal, calls[0].prepared.signal);
      assert.equal(prepared.beforeAttempt(), "task_budget");
      return result(DESCRIPTION);
    } });
  assert.equal(output.ok, true);
  assert.equal(output.position, "fallback");
  assert.equal(output.text, DESCRIPTION);
  assert.deepEqual(calls.map(call => call.position), ["primary", "fallback"]);
  assert.equal(JSON.stringify(input), original);
  controller.abort();
  assert.ok(calls.every(call => call.prepared.signal.aborted));
});

for (const maxTokens of [220, 240]) {
  test("sticker caller output allowance remains " + maxTokens + " tokens", async () => {
    const output = await callVisionText({ ...request(), maxTokens }, { budgetClock: () => 0,
      callSlot: async (_task, _position, prepared) => {
        assert.equal(prepared.maxTokens, maxTokens);
        assert.equal(prepared.beforeAttempt(), "");
        return result(DESCRIPTION);
      } });
    assert.equal(output.ok, true);
  });
}

for (const [changes, reason] of [[{ maxTokens: undefined }, "task_output_budget"],
  [{ maxTokens: 513 }, "task_output_budget"],
  [{ messages: [{ role: "user", content: "x".repeat(14001) }] }, "task_input_budget"]]) {
  test("default sticker budget rejects " + reason + " before any provider call", async () => {
    const output = await callVisionText({ ...request(), ...changes }, { budgetClock: () => 0,
      callSlot: () => assert.fail("called a provider for an inadmissible request") });
    assert.equal(output.ok, false);
    assert.equal(output.text, "");
    assert.equal(output.reason, reason);
    assert.deepEqual(output.failures, [{ position: "primary", reason }]);
  });
}

for (const position of ["primary", "fallback"]) {
  test("default sticker budget discards late " + position + " output without cache writes", async () => {
    let now = 0;
    const calls = [];
    let stores = 0;
    const output = await callVisionText(request(), { budgetClock: () => now,
      callSlot: async (_task, slot, prepared) => {
        calls.push(slot);
        assert.equal(prepared.beforeAttempt(), "");
        if (slot !== position) { now = 30000; return { ok: false, error: "synthetic_unavailable" }; }
        now = 60000;
        return result("late sticker text");
      }, cache: { get: () => "", set: () => { stores++; } } });
    assert.deepEqual(calls, position === "primary" ? ["primary"] : ["primary", "fallback"]);
    assert.equal(output.ok, false);
    assert.equal(output.reason, "task_deadline");
    assert.equal(output.text, "");
    assert.deepEqual(output.failures.at(-1), { position, reason: "task_deadline" });
    assert.equal(stores, 0);
  });
}

test("default sticker budget rechecks its deadline after output parsing and before caching", async () => {
  let now = 0;
  let calls = 0;
  const output = await callVisionText(request(), { budgetClock: () => now,
    callSlot: async () => {
      calls++;
      return { ok: true, raw: { choices: [{ message: { get content() { now = 60000; return DESCRIPTION; } } }] } };
    }, cache: { get: () => "", set: () => assert.fail("cached an output parsed after deadline") } });
  assert.equal(calls, 1);
  assert.equal(output.reason, "task_deadline");
  assert.equal(output.text, "");
});

for (const location of ["options", "request"]) {
  test("default sticker budget respects an aborted " + location + " signal even when both callers supply signals", async () => {
    const controllers = { options: new globalThis.AbortController(), request: new globalThis.AbortController() };
    controllers[location].abort();
    const output = await callVisionText({ ...request(), signal: controllers.request.signal }, {
      budgetClock: () => 0, signal: controllers.options.signal,
      callSlot: () => assert.fail("called a provider after cancellation") });
    assert.equal(output.reason, "task_cancelled");
    assert.equal(output.text, "");
  });

  test("default sticker budget propagates in-flight " + location + " cancellation with both caller signals", async () => {
    const controllers = { options: new globalThis.AbortController(), request: new globalThis.AbortController() };
    let calls = 0;
    const output = await callVisionText({ ...request(), signal: controllers.request.signal }, {
      budgetClock: () => 0, signal: controllers.options.signal,
      callSlot: async (_task, position, prepared) => {
        calls++;
        assert.equal(position, "primary");
        assert.equal(prepared.beforeAttempt(), "");
        controllers[location].abort();
        assert.equal(prepared.signal.aborted, true);
        return result("cancelled sticker text");
      }, cache: { get: () => "", set: () => assert.fail("cached a cancelled sticker description") } });
    assert.equal(calls, 1);
    assert.equal(output.reason, "task_cancelled");
    assert.equal(output.text, "");
  });
}

test("default sticker budget does not swallow caller privacy guards at the deadline", async () => {
  let now = 0;
  let calls = 0;
  const error = Object.assign(new Error("privacy_changed"), { code: "STICKER_PRIVACY_CHANGED" });
  await assert.rejects(callVisionText(request(), { budgetClock: () => now,
    assertCurrent: () => { if (now) throw error; },
    callSlot: async () => { calls++; now = 60000; return result("private sticker text"); } }),
  caught => caught === error);
  assert.equal(calls, 1);
});

test("cache hits skip request preparation and reserve no model budget", async () => {
  const budget = createModelTaskBudget("vision", { now: () => 0 });
  const output = await callVisionText(request(), { assertCurrent: budget.assertCurrent,
    prepareRequest: () => assert.fail("prepared a cache hit"),
    callSlot: () => assert.fail("called a provider on a cache hit"),
    cache: { get: () => DESCRIPTION, set: () => assert.fail("rewrote a cache hit") } });
  assert.equal(output.cached, true);
  assert.equal(output.text, DESCRIPTION);
  assert.deepEqual(budget.snapshot(), { calls: 0, transportAttempts: 0,
    requestedInputChars: 0, requestedCompletionTokens: 0 });
});

test("a fallback cache hit skips its reservation after one primary miss", async () => {
  const budget = createModelTaskBudget("vision", { now: () => 0 });
  const events = [];
  const input = request();
  const original = JSON.stringify(input);
  const output = await callVisionText(input, { assertCurrent: budget.assertCurrent,
    prepareRequest: (source, position) => { events.push("prepare:" + position); return budget.prepare(source); },
    callSlot: async (task, position, prepared) => {
      events.push("call:" + position);
      assert.equal(task, "vision");
      assert.equal(prepared.beforeAttempt(), "");
      return { ok: false, error: "synthetic_unavailable" };
    },
    cache: { get: position => { events.push("get:" + position); return position === "fallback" ? DESCRIPTION : ""; },
      set: () => assert.fail("cached a failure") } });
  assert.deepEqual(events, ["get:primary", "prepare:primary", "call:primary", "get:fallback"]);
  assert.equal(output.cached, true);
  assert.equal(output.position, "fallback");
  assert.equal(budget.snapshot().calls, 1);
  assert.equal(budget.snapshot().transportAttempts, 1);
  assert.equal(JSON.stringify(input), original);
});

test("objective primary and fallback share one shrinking deadline and preserve the request evidence", async () => {
  let now = 0;
  const calls = [];
  const controller = new globalThis.AbortController();
  const prepared = images();
  const original = JSON.stringify(prepared);
  const cfg = config();
  const output = await describeVisionImages(prepared, options({ config: cfg, signal: controller.signal, budgetClock: () => now,
    callSlot: async (task, position, input, settings) => {
      calls.push({ position, input });
      assert.equal(task, "vision");
      assert.equal(settings.config, cfg);
      assert.equal(input.maxTokens, 512);
      assert.equal(input.maxAttempts, 1);
      assert.equal(input.maxResponseBytes, 262144);
      assert.equal(input.beforeAttempt(), "");
      assert.deepEqual(input.messages.map(message => message.role), ["system", "user"]);
      assert.deepEqual(input.messages, buildObjectiveVisionMessages(prepared));
      assert.deepEqual(input.messages[1].content.slice(1), [prepared.images[0].content]);
      assert.equal(input.promptMetadata.promptVersion, VISION_PROMPT_VERSION);
      assert.equal(VISION_PROMPT_VERSION, "objective-image-v3");
      assert.doesNotMatch(JSON.stringify(input.messages), /PRIVATE_REASONING/);
      if (position === "primary") {
        assert.equal(input.timeoutMs, 20000);
        now = 39000;
        return { ok: true, provider: "vision-primary", raw: { choices: [{ message: { reasoning_content: "PRIVATE_REASONING" } }] } };
      }
      assert.equal(input.timeoutMs, 1000);
      assert.equal(input.signal, calls[0].input.signal);
      return result(DESCRIPTION);
    } }));
  assert.deepEqual(calls.map(call => call.position), ["primary", "fallback"]);
  assert.deepEqual(output, { ok: true, text: DESCRIPTION, cached: false, reason: "ready" });
  assert.equal(JSON.stringify(prepared), original);
  assert.equal(getVisionDescriptionCacheStatus().entries, 1);
  controller.abort();
  assert.ok(calls.every(call => call.input.signal.aborted));
});

test("objective cache reuse makes no call and preserves scope and image-layout isolation", async () => {
  let calls = 0;
  const callSlot = async (_task, _position, input) => {
    calls++;
    assert.equal(input.beforeAttempt(), "");
    return result(DESCRIPTION);
  };
  const prepared = images();
  assert.equal((await describeVisionImages(prepared, options({ callSlot }))).cached, false);
  assert.equal((await describeVisionImages(prepared, options({ callSlot }))).cached, true);
  assert.equal(calls, 1);
  assert.equal(getVisionDescriptionCacheStatus().hits, 1);
  await describeVisionImages(prepared, options({ callSlot, scope: { ...SCOPE, userId: 602 } }));
  await describeVisionImages({ ...prepared, images: [{ ...prepared.images[0], index: 2 }] }, options({ callSlot }));
  assert.equal(calls, 3);
});

for (const position of ["primary", "fallback"]) {
  test("late " + position + " objective output is neither returned nor cached", async () => {
    let now = 0;
    const calls = [];
    const prepared = images();
    const output = await describeVisionImages(prepared, options({ budgetClock: () => now,
      callSlot: async (_task, slot, input) => {
        calls.push(slot);
        assert.equal(input.beforeAttempt(), "");
        if (slot !== position) { now = 20000; return { ok: false, error: "synthetic_unavailable" }; }
        now = 40000;
        return result("late objective text");
      } }));
    assert.deepEqual(calls, position === "primary" ? ["primary"] : ["primary", "fallback"]);
    assert.deepEqual(output, { ok: false, text: "", cached: false, reason: "task_deadline" });
    assert.equal(getVisionDescriptionCacheStatus().entries, 0);
    let retries = 0;
    await describeVisionImages(prepared, options({ callSlot: async () => { retries++; return result(DESCRIPTION); } }));
    assert.equal(retries, 1);
  });
}

test("a primary failure at the deadline cannot start fallback", async () => {
  let now = 0;
  const calls = [];
  const output = await describeVisionImages(images(), options({ budgetClock: () => now,
    callSlot: async (_task, position, input) => {
      calls.push(position);
      assert.equal(input.beforeAttempt(), "");
      now = 40000;
      return { ok: false, error: "synthetic_unavailable" };
    } }));
  assert.deepEqual(calls, ["primary"]);
  assert.equal(output.reason, "task_deadline");
  assert.equal(output.text, "");
  assert.equal(getVisionDescriptionCacheStatus().entries, 0);
});

test("abort during a model call discards its output and skips fallback", async () => {
  const controller = new globalThis.AbortController();
  let calls = 0;
  const output = await describeVisionImages(images(), options({ signal: controller.signal,
    callSlot: async (_task, _position, input) => {
      calls++;
      assert.equal(input.beforeAttempt(), "");
      controller.abort();
      assert.equal(input.signal.aborted, true);
      return result("cancelled objective text");
    } }));
  assert.equal(calls, 1);
  assert.deepEqual(output, { ok: false, text: "", cached: false, reason: "task_cancelled" });
  assert.equal(getVisionDescriptionCacheStatus().entries, 0);
});

for (const code of ["CHAT_CANCELLED", "CHAT_TOOL_STOPPED"]) {
  test(code + " privacy errors propagate unchanged even at the task deadline", async () => {
    let stale = false;
    let now = 0;
    let calls = 0;
    const error = Object.assign(new Error("privacy_changed"), { code });
    await assert.rejects(describeVisionImages(images(), options({ budgetClock: () => now,
      assertCurrent: () => { if (stale) throw error; },
      callSlot: async () => { calls++; stale = true; now = 40000; return result("private late text"); } })),
    caught => caught === error);
    assert.equal(calls, 1);
    assert.equal(getVisionDescriptionCacheStatus().entries, 0);
  });
}

for (const task of ["objective", "sticker"]) {
  test("chat-run cancellation aborts " + task + " transport even while caller signals remain active", async () => {
    const controllers = { options: new globalThis.AbortController(), request: new globalThis.AbortController() };
    let calls = 0;
    const output = await withChatRun(SCOPE, () => {
      const signal = chatRunSignal();
      const settings = options({ signal: controllers.options.signal,
        callSlot: async (_task, position, prepared) => {
          calls++;
          assert.equal(position, "primary");
          assert.equal(prepared.beforeAttempt(), "");
          invalidateMemoryPrivacyGeneration();
          assert.throws(assertChatRunCurrent, { code: "CHAT_CANCELLED", message: "privacy_changed" });
          assert.equal(signal.aborted, true);
          assert.equal(prepared.signal.aborted, true);
          assert.equal(controllers.options.signal.aborted, false);
          assert.equal(controllers.request.signal.aborted, false);
          return result("stale objective text");
        } });
      return task === "objective" ? describeVisionImages(images(), settings)
        : callVisionText({ ...request(), signal: controllers.request.signal }, settings);
    }, { cfg: { ...CFG, friendWhitelist: [601], botBlacklist: [] } });
    assert.equal(calls, 1);
    assert.equal(output.kind, "cancelled");
    assert.equal(output.reason, "privacy_changed");
    assert.equal(output.text, null);
    assert.equal(getVisionDescriptionCacheStatus().entries, 0);
  });
}
