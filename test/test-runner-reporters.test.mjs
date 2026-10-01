import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { testRunArguments } from "../scripts/run-tests.mjs";
import { parseTestCounts } from "../scripts/release.mjs";

test("test runner passes an ESM file URL and separate destinations to both reporters", () => {
  const files = ["synthetic space.test.mjs", "another.test.mjs"];
  const args = testRunArguments(files);
  const reporter = args.find(value => value.startsWith("--test-reporter=file:"));
  assert.ok(reporter);
  const url = new URL(reporter.slice("--test-reporter=".length));
  assert.equal(url.protocol, "file:");
  assert.match(fileURLToPath(url), /test-failure-reporter\.mjs$/);
  assert.ok(args.includes("--test-reporter=spec"));
  assert.ok(args.includes("--test-reporter-destination=stdout"));
  assert.ok(args.includes("--test-reporter-destination=stderr"));
  assert.deepEqual(args.slice(-2), files);
});

test("actual dual-reporter child starts and retains complete safe test-count metadata", () => {
  const file = fileURLToPath(new URL("./release-failure-locations.test.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, testRunArguments([file]), {
    env, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.equal(child.status, 0, "the dual-reporter runner must execute rather than fail before startup");
  assert.deepEqual(parseTestCounts(child.stdout), { total: 8, pass: 8, fail: 0, skipped: 0 });
  assert.equal(child.stderr, "");
});
