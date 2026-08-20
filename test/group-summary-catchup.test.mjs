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
