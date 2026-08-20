import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeMaintenance } from "../bridge/runtime-maintenance.mjs";

test("runtime maintenance runs every cleanup independently", async () => {
  const errors = [];
  const maintenance = createRuntimeMaintenance({
    tasks: [
      { name: "one", run: async () => 2 },
      { name: "two", run: async () => { throw new Error("failed"); } },
      { name: "three", run: async () => ({ removed: 1 }) },
    ],
    logError: (...args) => errors.push(args.join(" ")),
  });
  const result = await maintenance.runOnce();

  assert.deepEqual(result.map(item => item.ok), [true, false, true]);
  assert.deepEqual(result.map(item => item.removed), [2, 0, 1]);
  assert.match(errors[0], /two failed/);
});
