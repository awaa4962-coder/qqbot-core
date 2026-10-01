import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function runVmTestFile(url, { pattern, timeout = 15000, minTests = 1 } = {}) {
  const env = { ...process.env };
  // A nested test runner must not inherit the parent's recursion marker.
  delete env.NODE_TEST_CONTEXT;
  const args = ["--experimental-vm-modules", "--test", "--test-reporter=tap"];
  if (pattern) args.push("--test-name-pattern=" + pattern);
  const filename = fileURLToPath(url);
  args.push(filename);
  const child = spawnSync(process.execPath, args, { env, encoding: "utf8", windowsHide: true,
    timeout, maxBuffer: 8 * 1024 * 1024 });
  const output = String(child.stdout || "") + String(child.stderr || "");
  assert.ok(!child.error && !child.signal && child.status === 0,
    "VM child did not finish cleanly: " + (output || String(child.error || "no completed result")));
  const placeholders = new Set([filename, filename.replace(/\\/g, "\\\\")]);
  const cases = [...String(child.stdout || "").matchAll(/^# Subtest: (.+)$/gm)];
  assert.ok(cases.some(match => !placeholders.has(match[1])), "VM child did not register explicit cases: " + output);
  const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled"].map(name => {
    const match = String(child.stdout || "").match(new RegExp("^# " + name + " (\\d+)$", "m"));
    assert.ok(match, "VM child did not report " + name + ": " + output);
    return [name, Number(match[1])];
  }));
  assert.ok(counts.tests >= minTests && counts.pass >= minTests, "VM child did not execute required cases: " + output);
  assert.equal(counts.fail, 0, output);
  assert.equal(counts.cancelled, 0, output);
  return counts;
}
