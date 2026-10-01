import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { main, parseTestFailureLocations } from "../scripts/release.mjs";

const prefix = "[qqfriend-test-failure] ";
const location = (file = "test/foo.test.mjs", line = 1, column = 1) => ({ file, line, column });
const record = value => prefix + JSON.stringify(value);
const privateValues = [
  "sk-SYNTHETIC-PRIVATE-KEY-DO-NOT-PRINT",
  "SYNTHETIC_PRIVATE_REASONING_DO_NOT_PRINT",
  "/home/synthetic-private/workspace/secret.test.mjs",
  "C:\\synthetic-private\\workspace\\secret.test.mjs",
];

// Boolean assertions keep unexpected parser output out of failure diagnostics.
function assertLocations(output, expected, message, knownFiles = [location().file, ...expected.map(value => value.file)]) {
  const actual = parseTestFailureLocations(output, knownFiles);
  assert.ok(isDeepStrictEqual(actual, expected), message);
  assert.ok(!privateValues.some(value => JSON.stringify(actual).includes(value)),
    "returned locations must not expose private fixture values");
}

test("exact structured records retain only safe relative locations and support CRLF", () => {
  const expected = [location(), location("test/nested_dir/with-dash/check.test.js", 42, 7),
    location("test/nested.v1/safe.test.mjs", 12, 3),
    location("test/limits.test.mjs", 10000000, 10000000)];
  assertLocations(expected.map(record).join("\r\n"), expected,
    "valid records must retain their exact file, line and column");
});

test("an explicit known-source array or set is required and unknown key-like filenames are rejected", () => {
  const safe = location("test/known.test.mjs", 5, 6);
  const forged = location("test/" + privateValues[0] + ".test.mjs", 7, 8);
  const output = [record(safe), record(location("test/unknown.test.mjs")), record(forged)].join("\n");
  assert.ok(isDeepStrictEqual(parseTestFailureLocations(output), []),
    "omitting the source allowlist must fail closed");
  for (const empty of [[], new Set()]) {
    assertLocations(output, [], "an empty source allowlist must reject all records", empty);
  }
  for (const known of [[safe.file], new Set([safe.file])]) {
    assertLocations(output, [safe], "safe shape alone must not authorize an unknown filename", known);
  }
});

test("near prefixes and unstructured private output never become failure locations", () => {
  const valid = location("test/confirmed.test.mjs", 8, 9);
  const encoded = JSON.stringify(location());
  const output = [
    " " + prefix + encoded, "\t" + prefix + encoded, "# " + prefix + encoded,
    "message " + prefix + encoded, "[qqfriend-test-failure]" + encoded,
    "[qqfriend-test-failure]\t" + encoded, "[qqfriend-test-failure-extra] " + encoded,
    prefix + encoded + " trailing text", ...privateValues,
    "Error: apiKey=" + privateValues[0], "reasoning_content=" + privateValues[1],
    "    at " + privateValues[2] + ":12:3", record(valid),
  ].join("\n");
  assertLocations(output, [valid], "only the exact prefixed JSON line may be accepted");
  for (const input of [undefined, null, 3, true, {}, [], Buffer.from(output)]) {
    assertLocations(input, [], "non-string output must not be interpreted or throw");
  }
});

test("malformed JSON, non-object records and extra private fields are rejected", () => {
  const invalid = [null, false, 1, "message", [], [location()], {},
    { file: "test/foo.test.mjs", line: 1 },
    { file: "test/foo.test.mjs", column: 1 },
    { line: 1, column: 1 }, { ...location(), file: {} },
    { ...location(), file: null }, { ...location(), line: "1" },
    { ...location(), column: "1" }];
  for (const field of ["apiKey", "reasoning_content", "message", "stdout", "stderr", "path", "__proto__"]) {
    invalid.push({ ...location(), [field]: privateValues });
  }
  const output = [prefix, prefix + "{broken", prefix + "{\"file\":",
    prefix + JSON.stringify(location()) + "{}", ...invalid.map(record)].join("\n");
  assertLocations(output, [], "malformed or non-contract records must be rejected wholesale");
});

test("traversal, absolute, backslash, non-ASCII and non-test paths are rejected", () => {
  const invalid = ["", "../test/foo.test.mjs", "test/../foo.test.mjs",
    "test/sub/../../foo.test.mjs", "test/./foo.test.mjs", "test//foo.test.mjs",
    "/test/foo.test.mjs", "C:/test/foo.test.mjs", "C:\\test\\foo.test.mjs",
    "\\\\server\\test\\foo.test.mjs", "test\\foo.test.mjs", "./test/foo.test.mjs",
    "file:///test/foo.test.mjs", "test/%2e%2e/foo.test.mjs", "test/foo test.mjs",
    "test/\u4e2d.test.mjs", "test/\u00e9.test.mjs", "test/foo\u0000.test.mjs",
    "test/foo\n.test.mjs", "test/", "test/foo.test.ts", "test/foo.test.mjs.bak",
    "bridge/foo.test.mjs", ...privateValues];
  assertLocations(invalid.map(file => record(location(file))).join("\n"), [],
    "unsafe file paths must not survive normalization or sanitization", invalid);
});

test("line and column require integers from one through ten million", () => {
  const invalid = [0, -1, 1.5, 10000001, Number.MAX_SAFE_INTEGER, NaN, Infinity,
    null, undefined, "1", true, {}, []];
  for (const field of ["line", "column"]) {
    for (const value of invalid) {
      assertLocations(record({ ...location(), [field]: value }), [],
        "out-of-range or incorrectly typed counters must be rejected");
    }
  }
  const expected = [location("test/lower.test.js", 1, 1),
    location("test/upper.test.mjs", 10000000, 10000000)];
  assertLocations(expected.map(record).join("\n"), expected,
    "both inclusive counter boundaries must remain valid");
});

test("duplicate location tuples do not consume the twenty-record limit", () => {
  const locations = [location("test/shared.test.mjs", 1, 1),
    location("test/shared.test.mjs", 2, 1), location("test/shared.test.mjs", 1, 2),
    ...Array.from({ length: 25 }, (_, index) => location("test/item-" + index + ".test.mjs", index + 1, 3))];
  const output = [record({ ...location(), message: privateValues[0] }),
    ...locations.flatMap(value => [record(value), record(value)]),
    record(location("test/beyond-limit.test.mjs", 9, 9))].join("\n");
  assertLocations(output, locations.slice(0, 20),
    "only the first twenty distinct complete location tuples may be returned",
    [...locations.map(value => value.file), "test/beyond-limit.test.mjs"]);
});

test("redacted release failure exposes only valid location JSON, never raw stdout, stderr or cause", async t => {
  const temporaryBase = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryBase, "qqfriend-release-failure-locations-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), temporaryBase);
    assert.ok(path.basename(root).startsWith("qqfriend-release-failure-locations-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "synthetic-release", version: "0.0.0" }));
  const safe = [location("test/first.test.mjs", 12, 3), location("test/second.test.js", 4, 5)];
  fs.mkdirSync(path.join(root, "test"));
  for (const value of safe) fs.writeFileSync(path.join(root, value.file), "// Synthetic source fixture.\n");
  const rawStdout = "apiKey=" + privateValues[0] + "\nreasoning_content=" + privateValues[1];
  const rawStderr = privateValues[2] + "\n" + privateValues[3];
  const forged = record(location("test/" + privateValues[0] + ".test.mjs", 6, 7));
  const scenarios = [
    { stdout: rawStdout + "\n" + record(safe[0]) + "\n" + forged,
      stderr: rawStderr + "\n" + record(safe[1]), expected: safe },
    { stdout: rawStdout + "\n" + record({ ...location(), apiKey: privateValues[0] }),
      stderr: rawStderr + "\n" + forged + "\n" + record(location("test/unknown.test.mjs")), expected: [] },
  ];
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const expectedCommands = [npm + " run check:dependencies", npm + " run lint", npm + " test"];
  for (const scenario of scenarios) {
    const commands = [], messages = [];
    const spawnMock = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      const invocation = process.platform === "win32" ? args[3] : [command, ...args].join(" ");
      assert.ok(invocation === expectedCommands[commands.length], "only mocked dependency, lint and test commands are allowed");
      assert.ok(options.cwd === root, "mocked checks must stay inside the synthetic project");
      commands.push(invocation);
      return commands.length < 3 ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: scenario.stdout, stderr: scenario.stderr, error: new Error(privateValues[1]) };
    });
    const logMock = t.mock.method(globalThis.console, "log", (...args) => messages.push(args.map(String).join(" ")));
    const errorMock = t.mock.method(globalThis.console, "error", (...args) => messages.push(args.map(String).join(" ")));
    let failure;
    syncBuiltinESMExports();
    try {
      await main(["--check-only"], root);
    } catch (error) {
      failure = error;
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
      logMock.mock.restore();
      errorMock.mock.restore();
    }
    const expected = npm + " test failed" + (scenario.expected.length
      ? "\n[release] test failure locations " + JSON.stringify(scenario.expected) : "");
    assert.ok(failure instanceof Error && failure.message === expected,
      "redacted failure must contain only the command and validated location JSON");
    assert.ok(isDeepStrictEqual(commands, expectedCommands), "no runtime, archive, deployment or real subprocess may run");
    assert.ok(messages.every(message => !privateValues.some(value => message.includes(value))),
      "release logs must not expose private stdout, stderr or error causes");
  }
});
