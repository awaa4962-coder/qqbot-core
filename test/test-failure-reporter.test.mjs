import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import reportTestFailures from "../scripts/test-failure-reporter.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PREFIX = "[qqfriend-test-failure] ";
const PRIVATE_KEY = "sk-SYNTHETIC-PRIVATE-KEY-NEVER-PRINT";
const REASONING = "SYNTHETIC_PRIVATE_REASONING_NEVER_PRINT";
const PRIVATE_PATH = path.join(os.tmpdir(), "synthetic-private", "secret.txt");
const PROBE_ENV = "QQFRIEND_TEST_FAILURE_REPORTER_PROBE";

if (process.env[PROBE_ENV] === "1") {
  test(PRIVATE_KEY + " " + REASONING + " " + PRIVATE_PATH, () => {
    assert.fail(PRIVATE_KEY + " " + REASONING + " " + PRIVATE_PATH);
  });
} else {
  function failure(file = "test/foo.test.mjs", line = 7, column = 3, extra = {}) {
    return { type: "test:fail", data: { file, line, column, ...extra } };
  }

  async function collect(events) {
    const chunks = [];
    for await (const chunk of reportTestFailures(events)) chunks.push(chunk);
    return chunks;
  }

  function records(chunks) {
    return chunks.map(chunk => {
      assert.equal(typeof chunk, "string");
      assert.ok(chunk.startsWith(PREFIX));
      assert.ok(chunk.endsWith("\n"));
      assert.equal(chunk.split("\n").length, 2);
      const record = JSON.parse(chunk.slice(PREFIX.length, -1));
      assert.deepEqual(Object.keys(record), ["file", "line", "column"]);
      assert.match(record.file, /^test\//);
      assert.equal(path.posix.isAbsolute(record.file), false);
      assert.doesNotMatch(record.file, /\\|\.\.\//);
      return record;
    });
  }

  function assertPrivateFieldsAbsent(text) {
    for (const privateValue of [PRIVATE_KEY, REASONING, PRIVATE_PATH, ROOT, "RAW_ASSERTION", "RAW_STACK", "RAW_OUTPUT"]) {
      assert.equal(text.includes(privateValue), false, "private field must not appear in reporter output");
    }
  }

  test("failure reporter emits only a safe relative location, never private failure details", async () => {
    const event = failure(path.join(ROOT, "test", "foo.test.mjs"), 7, 3, {
      name: PRIVATE_KEY, message: "RAW_ASSERTION " + REASONING,
      error: { message: PRIVATE_KEY, stack: "RAW_STACK " + PRIVATE_PATH, reasoning: REASONING },
      stack: "RAW_STACK " + PRIVATE_PATH, output: "RAW_OUTPUT " + PRIVATE_KEY,
    });
    const chunks = await collect([event]);
    assert.deepEqual(records(chunks), [{ file: "test/foo.test.mjs", line: 7, column: 3 }]);
    assertPrivateFieldsAbsent(chunks.join(""));
  });

  test("failure reporter never reads unused private properties", async () => {
    const event = failure();
    for (const field of ["name", "message", "error", "stack", "output", "reasoning"]) {
      Object.defineProperty(event.data, field, { get() { return assert.fail("private property was accessed"); } });
    }
    assert.deepEqual(records(await collect([event])), [{ file: "test/foo.test.mjs", line: 7, column: 3 }]);
  });

  test("failure reporter ignores malformed events and every non-failure event", async () => {
    const valid = failure();
    const events = [null, undefined, false, 42, PRIVATE_KEY, [], {},
      { type: "test:fail" }, { type: "test:fail", data: null },
      { type: "test:fail", data: [] }, { type: "test:fail", data: PRIVATE_KEY },
      { type: "test:fail", data: {} },
      ...["test:pass", "test:diagnostic", "test:stdout", "test:stderr", "test:enqueue"].map(type => ({ ...valid, type })),
      failure(null), failure(42), failure(new URL("file:///private/test.mjs")), failure(""),
    ];
    assert.deepEqual(await collect(events), []);
  });

  test("failure reporter rejects external, traversal, non-ASCII and unsafe filenames", async () => {
    const files = [path.join(ROOT, "scripts", "private.mjs"),
      path.resolve(ROOT, "..", "outside", "test", "private.test.mjs"),
      path.join(ROOT + "-outside", "test", "private.test.mjs"),
      path.join(ROOT, "test-outside", "private.test.mjs"),
      "../outside/test/private.mjs", "test/../../private.mjs", PRIVATE_PATH,
      "test/private.json", "test/private.ts", "test/private.mjs.bak",
      "test/private name.mjs", "test/private:name.mjs", "test/private#name.mjs",
      "test/private\nname.mjs", "test/private\0name.mjs", "test/\u79c1\u5bc6.mjs",
      "file:///private/test/private.mjs",
    ];
    assert.deepEqual(await collect(files.map(file => failure(file))), []);
    const chunks = await collect([failure(path.join(ROOT, "test", "nested", "safe_file-1.js"))]);
    assert.deepEqual(records(chunks), [{ file: "test/nested/safe_file-1.js", line: 7, column: 3 }]);
    assertPrivateFieldsAbsent(chunks.join(""));
  });

  test("failure reporter requires bounded positive integer line and column coordinates", async () => {
    const invalid = [undefined, null, false, "1", 0, -1, 1.5, NaN, Infinity, 10_000_001, 1n];
    const events = invalid.flatMap(value => [failure("test/range.mjs", 1, 1, { line: value }),
      failure("test/range.mjs", 1, 1, { column: value })]);
    assert.deepEqual(await collect(events), []);
    assert.deepEqual(records(await collect([failure("test/range.mjs", 1, 10_000_000)])),
      [{ file: "test/range.mjs", line: 1, column: 10_000_000 }]);
  });

  test("failure reporter deduplicates exact locations while keeping distinct coordinates", async () => {
    const chunks = await collect([failure(), failure(path.join(ROOT, "test", "foo.test.mjs")),
      failure("test/foo.test.mjs", 7, 4), failure("test/foo.test.mjs", 8, 3), failure()]);
    assert.deepEqual(records(chunks), [
      { file: "test/foo.test.mjs", line: 7, column: 3 },
      { file: "test/foo.test.mjs", line: 7, column: 4 },
      { file: "test/foo.test.mjs", line: 8, column: 3 },
    ]);
  });

  test("failure reporter emits at most twenty unique locations and drains its async source", async () => {
    let consumed = 0;
    async function* events() {
      for (let index = 0; index < 45; index++) {
        consumed++;
        await Promise.resolve();
        yield index % 2 ? failure("test/capped.mjs", index + 1, 1) : failure();
      }
      consumed++;
      yield failure("test/last.mjs", 1, 1);
    }
    const output = records(await collect(events()));
    assert.equal(output.length, 20);
    assert.equal(new Set(output.map(value => JSON.stringify(value))).size, 20);
    assert.equal(consumed, 46);
    assert.deepEqual(output[0], { file: "test/foo.test.mjs", line: 7, column: 3 });
    assert.equal(output.some(value => value.file === "test/last.mjs"), false);
  });

  test("real failing Node child emits only the structured test location from a different cwd", () => {
    const base = path.resolve(os.tmpdir());
    const temporary = fs.mkdtempSync(path.join(base, "qqfriend-failure-reporter-"));
    try {
      const env = { ...process.env, [PROBE_ENV]: "1" };
      delete env.NODE_TEST_CONTEXT;
      const reporter = new URL("../scripts/test-failure-reporter.mjs", import.meta.url).href;
      const child = spawnSync(process.execPath, ["--test", "--test-reporter=" + reporter, fileURLToPath(import.meta.url)],
        { cwd: temporary, env, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      const chunks = child.stdout.trimEnd().split("\n").map(line => line + "\n");
      const output = records(chunks);
      assert.equal(output.length, 1);
      assert.equal(output[0].file, "test/test-failure-reporter.test.mjs");
      for (const field of ["line", "column"]) {
        assert.ok(Number.isInteger(output[0][field]) && output[0][field] > 0 && output[0][field] <= 10_000_000);
      }
      assertPrivateFieldsAbsent(child.stdout + child.stderr);
    } finally {
      assert.equal(path.dirname(path.resolve(temporary)), base);
      assert.match(path.basename(temporary), /^qqfriend-failure-reporter-/);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}
