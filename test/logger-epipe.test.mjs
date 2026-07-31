import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { log, logE } from "../bridge/logger.mjs";

test("logger does not throw when stdout or stderr has EPIPE", () => {
  const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  process.stdout.emit("error", epipe);
  process.stderr.emit("error", epipe);

  assert.doesNotThrow(() => log("after stdout epipe"));
  assert.doesNotThrow(() => logE("after stderr epipe"));
});
