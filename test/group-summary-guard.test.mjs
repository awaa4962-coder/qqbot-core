import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { afterEach, describe, it } from "node:test";
import { URL } from "node:url";

import { createDailySummaryGuard } from "../bridge/group-summary/guard.mjs";
import { withSummaryWriteLock } from "../bridge/group-summary/state.mjs";

const roots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-summary-guard-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

function claimInChild(rootDir) {
  const child = spawnSync(execPath, ["--input-type=module", "-e", `
    import { createDailySummaryGuard } from ${JSON.stringify(new URL("../bridge/group-summary/guard.mjs", import.meta.url).href)};
    const { ok, reason } = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir: process.argv[1] });
    process.stdout.write(JSON.stringify({ ok, reason }));
  `, rootDir], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  return JSON.parse(child.stdout);
}

describe("daily summary guard", () => {
  it("blocks a second run while the same group/date is running", () => {
    const rootDir = tempRoot();
    const first = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(first.ok, true);

    const second = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "already_running");

    first.release();
    const third = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(third.ok, true);
    third.release();
  });

  it("keeps publication held across processes until the operator removes the hold alone", () => {
    const rootDir = tempRoot();
    const hold = path.join(rootDir, "publication.hold");
    fs.writeFileSync(hold, "synthetic deployment hold");
    assert.deepEqual(claimInChild(rootDir), { ok: false, reason: "publication_held" });
    fs.unlinkSync(hold);
    const guard = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(guard.ok, true);
    guard.release();
  });

  it("blocks later runs after a summary was marked sent", () => {
    const rootDir = tempRoot();
    const first = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    first.markSent({ messages: 42, result: { status: "ok" } });
    first.release();

    const second = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "already_sent");
    assert.match(fs.readFileSync(first.sentFile, "utf8"), /"messages": 42/);
  });

  it("never takes over an old lock, including one left by an exited process", () => {
    const rootDir = tempRoot();
    assert.deepEqual(claimInChild(rootDir), { ok: true, reason: "" });
    const lockDir = path.join(rootDir, "2026-07-07-2000000001.lock");
    const runFile = path.join(lockDir, "run.json");
    const original = fs.readFileSync(runFile, "utf8");
    fs.utimesSync(lockDir, new Date(0), new Date(0));
    assert.deepEqual(claimInChild(rootDir), { ok: false, reason: "already_running" });
    assert.equal(createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir }).reason, "already_running");
    assert.equal(fs.readFileSync(runFile, "utf8"), original);
  });

  it("cannot release or update a successor's lock through a released guard", () => {
    const options = { dateText: "2026-07-07", groupId: 2000000001, rootDir: tempRoot() };
    const first = createDailySummaryGuard(options);
    assert.deepEqual(claimInChild(options.rootDir), { ok: false, reason: "already_running" });
    first.release();
    const second = createDailySummaryGuard(options);
    first.release();
    assert.throws(() => first.markAttempt(), /released/);
    assert.throws(() => first.markSent(), /released/);
    assert.throws(() => first.markFailed(), /released/);
    assert.equal(createDailySummaryGuard(options).reason, "already_running");
    second.release();
  });

  it("blocks automatic retries after an unconfirmed send attempt", () => {
    const rootDir = tempRoot();
    const first = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    first.markAttempt({ messages: 20 });
    first.release();

    const second = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "previous_attempt_unconfirmed");
  });

  it("blocks on a malformed sent marker without rewriting it", () => {
    const rootDir = tempRoot();
    const marker = path.join(rootDir, "2026-07-07-2000000001.sent.json");
    fs.writeFileSync(marker, "not-json", "utf8");
    const guard = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });

    assert.equal(guard.ok, false);
    assert.equal(guard.reason, "previous_attempt_unconfirmed");
    assert.equal(fs.readFileSync(marker, "utf8"), "not-json");
    assert.equal(fs.existsSync(guard.lockDir), false);
  });

  it("keeps the summary write lock exclusive even when its mtime is old", () => {
    const root = tempRoot();
    const lock = path.join(root, "write.lock");
    withSummaryWriteLock({ root }, () => {
      fs.utimesSync(lock, new Date(0), new Date(0));
      assert.throws(() => withSummaryWriteLock({ root }, () => assert.fail("entered active lock")), error => error.cause?.code === "EEXIST");
      assert.equal(fs.existsSync(lock), true);
    });
    assert.equal(withSummaryWriteLock({ root }, () => "released"), "released");
  });
});
