import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runVmTestFile } from "./vm-test-runner.mjs";

const temporaryBase = path.resolve(os.tmpdir());
fs.mkdirSync(temporaryBase, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryBase, "qqfriend-vm-runner-"));
let sequence = 0;

test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), temporaryBase);
  assert.match(path.basename(root), /^qqfriend-vm-runner-/);
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(source) {
  const directory = path.join(root, "case-" + (++sequence));
  fs.mkdirSync(directory);
  const filename = path.join(directory, "synthetic.test.mjs");
  const marker = path.join(directory, "executed.txt");
  fs.writeFileSync(filename, `
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const mark = value => fs.appendFileSync(${JSON.stringify(marker)}, value + "\\n");
${source}
`);
  return { url: pathToFileURL(filename), markers: () => fs.readFileSync(marker, "utf8").trim().split("\n") };
}

function rejectWithSummary(url, expected, options = {}) {
  let rejection;
  assert.throws(() => runVmTestFile(url, options), error => {
    assert.equal(error.code, "ERR_ASSERTION");
    for (const [name, count] of Object.entries(expected)) {
      const summary = error.message.match(new RegExp("^# " + name + " (\\d+)$", "m"));
      assert.ok(summary, "rejected child must report its actual " + name + " count");
      assert.equal(Number(summary[1]), count, error.message);
    }
    rejection = error;
    return true;
  });
  return rejection;
}

test("inherited child-v8 context really executes selected VM cases and returns exact TAP counts", () => {
  const child = fixture(`
test("synthetic VM case", async () => {
  const vm = await import("node:vm");
  assert.equal(typeof vm.SourceTextModule, "function");
  const module = new vm.SourceTextModule("export const answer = 42;");
  await module.link(() => assert.fail("No external modules permitted"));
  await module.evaluate();
  assert.equal(module.namespace.answer, 42);
  mark("vm:42");
});
test("synthetic second case", () => mark("second:executed"));
test("outside selected pattern", () => assert.fail("Pattern must exclude this assertion"));
`);
  const originalContext = process.env.NODE_TEST_CONTEXT;
  let counts;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    counts = runVmTestFile(child.url, { pattern: "^synthetic ", timeout: 15000, minTests: 2 });
    assert.equal(process.env.NODE_TEST_CONTEXT, "child-v8", "helper must not mutate its parent's environment");
  } finally {
    if (originalContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalContext;
  }
  assert.ok(counts.tests >= 2);
  assert.equal(counts.pass, 2);
  assert.equal(counts.fail, 0);
  assert.equal(counts.cancelled, 0);
  assert.deepEqual(child.markers(), ["vm:42", "second:executed"]);
});

test("empty files and unmatched patterns cannot count a file placeholder as an executed case", () => {
  const empty = fixture('mark("module:loaded");');
  assert.throws(() => runVmTestFile(empty.url), /did not register explicit cases/);
  assert.deepEqual(empty.markers(), ["module:loaded"]);
  const unmatched = fixture(`
mark("module:loaded");
test("synthetic excluded case", () => mark("unexpected:case"));
`);
  assert.throws(() => runVmTestFile(unmatched.url, { pattern: "^no-matching-case$" }),
    /did not register explicit cases|did not execute required cases/);
  assert.deepEqual(unmatched.markers(), ["module:loaded"]);
});

test("an all-skipped file is rejected despite a successful child process exit", () => {
  const child = fixture(`
mark("module:loaded");
test("synthetic skipped A", { skip: true }, () => mark("unexpected:A"));
test("synthetic skipped B", { skip: true }, () => mark("unexpected:B"));
`);
  const error = rejectWithSummary(child.url, { tests: 2, pass: 0, fail: 0, cancelled: 0 });
  assert.match(error.message, /did not execute required cases/);
  assert.match(error.message, /^# skipped 2$/m);
  assert.deepEqual(child.markers(), ["module:loaded"]);
});

test("a file with an actual failing assertion is rejected even when another case passes", () => {
  const child = fixture(`
test("synthetic passing assertion", () => { mark("pass:executed"); assert.equal(1, 1); });
test("synthetic failing assertion", () => {
  mark("fail:executed");
  assert.equal(1, 2, "synthetic assertion must fail");
});
`);
  const error = rejectWithSummary(child.url, { tests: 2, pass: 1, fail: 1, cancelled: 0 });
  assert.match(error.message, /synthetic assertion must fail/);
  assert.deepEqual(child.markers(), ["pass:executed", "fail:executed"]);
});

test("a timed-out runner stays rejected even if its worker finishes and produces a TAP summary", async () => {
  const child = fixture(`
import { setTimeout } from "node:timers/promises";
test("synthetic bounded delayed case", async () => {
  mark("timeout:started");
  await setTimeout(2000);
  mark("timeout:finished");
});
`);
  const started = Date.now();
  try {
    assert.throws(() => runVmTestFile(child.url, { timeout: 1500 }), error => {
      assert.equal(error.code, "ERR_ASSERTION");
      assert.equal(error.actual, false, "timed-out runner must fail the clean-completion guard");
      assert.equal(error.expected, true);
      assert.match(error.message, /VM child did not finish cleanly/);
      return true;
    });
    assert.ok(Date.now() - started >= 1300, "rejection must come from the configured timeout, not a launch failure");
    const markers = child.markers();
    assert.equal(markers[0], "timeout:started", "the child must actually enter its delayed test");
    assert.ok(markers.length <= 2 && markers.slice(1).every(value => value === "timeout:finished"),
      "only the runner timeout or its still-running worker completion may be observed");
  } finally {
    // A bounded worker can finish even if the platform only terminates its runner.
    await setTimeout(2500);
  }
});

test("complete passing TAP cannot confirm a timed-out or signalled runner, even with a zero exit code", t => {
  const child = fixture('test("synthetic late completion", () => mark("completed"));');
  const results = [
    { status: null, signal: "SIGTERM", error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) },
    { status: 0, signal: null, error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) },
    { status: 0, signal: "SIGTERM" },
  ];
  let result;
  const mock = t.mock.method(childProcess, "spawnSync", () => ({ ...result,
    stdout: "TAP version 13\n# Subtest: synthetic late completion\nok 1 - synthetic late completion\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n", stderr: "" }));
  syncBuiltinESMExports();
  try {
    for (result of results) {
      assert.throws(() => runVmTestFile(child.url), error => error.code === "ERR_ASSERTION" &&
        error.actual === false && error.expected === true);
    }
    assert.equal(mock.mock.callCount(), results.length);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("minTests requires enough total cases and enough actual passes, not passing-plus-skipped totals", () => {
  const child = fixture(`
test("synthetic single case", () => { mark("single:executed"); assert.equal(42, 42); });
`);
  const error = rejectWithSummary(child.url, { tests: 1, pass: 1, fail: 0, cancelled: 0 }, { minTests: 2 });
  assert.match(error.message, /did not execute required cases/);
  assert.deepEqual(child.markers(), ["single:executed"]);
  const partlySkipped = fixture(`
test("synthetic passing minimum", () => mark("minimum:executed"));
test("synthetic skipped minimum", { skip: true }, () => mark("unexpected:minimum"));
`);
  const minimumPassError = rejectWithSummary(partlySkipped.url,
    { tests: 2, pass: 1, fail: 0, cancelled: 0 }, { minTests: 2 });
  assert.match(minimumPassError.message, /did not execute required cases/);
  assert.match(minimumPassError.message, /^# skipped 1$/m);
  assert.deepEqual(partlySkipped.markers(), ["minimum:executed"]);
});
