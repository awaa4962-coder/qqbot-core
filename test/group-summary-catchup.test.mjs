import assert from "node:assert/strict";
import test from "node:test";

import { createDailySummaryCatchUp } from "../bridge/group-summary/catchup.mjs";

test("boot catch-up waits for OneBot and always targets the previous Shanghai day", async () => {
  let ready = false;
  const scheduled = [];
  const runs = [];
  const catchUp = createDailySummaryCatchUp({
    isReady: () => ready,
    now: () => new Date("2026-08-20T10:00:00+08:00"),
    run: async options => {
      runs.push(options.dateText);
      return { ok: true, sent: 1, groups: 1 };
    },
    initialDelayMs: 1,
    retryDelayMs: 1,
    setTimeoutFn: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    clearTimeoutFn() {},
  });

  catchUp.start();
  assert.equal(scheduled.length, 1);
  await catchUp.runNow();
  assert.equal(runs.length, 0);
  ready = true;
  await catchUp.runNow();
  assert.deepEqual(runs, ["2026-08-19"]);
  assert.equal(catchUp.status().completed, true);
});

test("concurrent catch-up callers share an async readiness check and deferrals do not use run attempts", async () => {
  const scheduled = new Set();
  let ready;
  let checks = 0;
  let runs = 0;
  const catchUp = createDailySummaryCatchUp({
    isReady: () => { checks++; return new Promise(resolve => { ready = resolve; }); },
    run: async () => { runs++; return { ok: true }; },
    maxRunAttempts: 1,
    setTimeoutFn: callback => { scheduled.add(callback); return callback; },
    clearTimeoutFn: timer => scheduled.delete(timer),
  });

  catchUp.start();
  const first = catchUp.runNow();
  assert.equal(catchUp.runNow(), first);
  catchUp.start();
  await Promise.resolve();
  assert.equal(scheduled.size, 0);
  assert.equal(checks, 1);
  assert.equal(runs, 0);
  ready(false);
  assert.equal(await first, null);
  assert.equal(scheduled.size, 1);
  assert.equal(catchUp.status().runAttempts, 0);

  const next = catchUp.runNow();
  await Promise.resolve();
  assert.equal(checks, 2);
  ready(true);
  assert.deepEqual(await next, { ok: true });
  assert.equal(runs, 1);
  assert.equal(catchUp.status().runAttempts, 1);
  assert.equal(scheduled.size, 0);
});

test("catch-up can't dispatch after stop during an in-flight readiness check", async () => {
  let ready;
  let runs = 0;
  const catchUp = createDailySummaryCatchUp({
    isReady: () => new Promise(resolve => { ready = resolve; }),
    run: async () => { runs++; return { ok: true }; },
  });
  const pending = catchUp.runNow();
  await Promise.resolve();
  assert.equal(catchUp.stop(), true);
  ready(true);
  assert.equal(await pending, null);
  assert.equal(await catchUp.runNow(), null);
  assert.equal(runs, 0);
  assert.equal(catchUp.status().scheduled, false);
});

test("stopping catch-up tracks a dispatched run without scheduling another attempt", async () => {
  let finish;
  const started = Promise.withResolvers();
  const catchUp = createDailySummaryCatchUp({
    run: () => new Promise(resolve => { finish = resolve; started.resolve(); }),
    setTimeoutFn: () => assert.fail("stopped work must not schedule a retry"),
  });
  const pending = catchUp.runNow();
  await started.promise;
  const stopped = catchUp.stop();
  assert.equal(typeof stopped.then, "function");
  finish({ ok: false, pending: true });
  await pending;
  assert.equal(await stopped, true);
  assert.equal(await catchUp.runNow(), null);
  assert.equal(catchUp.status().runAttempts, 1);
});
