import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createDailySummaryGuard } from "../bridge/group-summary/guard.mjs";

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

  it("removes stale locks before starting a new run", () => {
    const rootDir = tempRoot();
    let uptime = 1000;
    createDailySummaryGuard({
      dateText: "2026-07-07",
      groupId: 2000000001,
      rootDir,
      uptimeNow: () => uptime,
    });
    uptime += 10_000;

    const second = createDailySummaryGuard({
      dateText: "2026-07-07",
      groupId: 2000000001,
      rootDir,
      staleMs: 1,
      uptimeNow: () => uptime,
    });
    assert.equal(second.ok, true);
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

  it("quarantines a malformed sent marker instead of treating it as sent", () => {
    const rootDir = tempRoot();
    const marker = path.join(rootDir, "2026-07-07-2000000001.sent.json");
    fs.writeFileSync(marker, "not-json", "utf8");
    const guard = createDailySummaryGuard({ dateText: "2026-07-07", groupId: 2000000001, rootDir });

    assert.equal(guard.ok, true);
    assert.equal(fs.existsSync(marker), false);
    assert.ok(fs.readdirSync(rootDir).some(name => name.includes(".sent.json.invalid-")));
    guard.release();
  });
});
