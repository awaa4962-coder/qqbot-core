import assert from "node:assert/strict";
import { test } from "node:test";

import { runDailySummaries } from "../bridge/group-summary/daily.mjs";

test("daily summary runner processes every configured group independently", async () => {
  const sent = [];
  const marked = [];
  const released = [];
  const result = await runDailySummaries({
    dateText: "2026-07-29",
    groupIds: [101, 202, 101],
    createGuard: ({ groupId }) => ({
      ok: true,
      markSent: payload => marked.push({ groupId, payload }),
      release: () => released.push(groupId),
    }),
    loadMessages: (_dateText, groupId) => [{ text: "group-" + groupId }],
    sendSummary: async ({ groupId, messages }) => {
      sent.push({ groupId, messages });
      return { ok: true, sent: true, messages: messages.length, outputFile: "summary-" + groupId };
    },
  });

  assert.deepEqual(sent.map(item => item.groupId), [101, 202]);
  assert.deepEqual(marked.map(item => item.groupId), [101, 202]);
  assert.deepEqual(released, [101, 202]);
  assert.equal(result.groups, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.ok, true);
});

test("daily summary runner skips only the guarded or empty group", async () => {
  const sent = [];
  const result = await runDailySummaries({
    dateText: "2026-07-29",
    groupIds: [101, 202, 303],
    createGuard: ({ groupId }) => groupId === 101
      ? { ok: false, reason: "already_sent" }
      : { ok: true, markSent() {}, release() {} },
    loadMessages: (_dateText, groupId) => groupId === 202 ? [] : [{ text: "ready" }],
    sendSummary: async ({ groupId }) => {
      sent.push(groupId);
      return { ok: true, sent: true, messages: 1 };
    },
  });

  assert.deepEqual(sent, [303]);
  assert.deepEqual(result.results.map(item => item.reason || ""), ["already_sent", "no_messages", ""]);
});

test("daily summary runner leaves attempt bookkeeping to the segment publisher", async () => {
  const events = [];
  const result = await runDailySummaries({
    dateText: "2026-07-29",
    groupIds: [101],
    createGuard: () => ({
      ok: true,
      markAttempt: payload => events.push(["attempt", payload.messages]),
      markFailed: () => events.push(["failed"]),
      release: () => events.push(["released"]),
    }),
    loadMessages: () => [{ text: "ready" }],
    sendSummary: async options => {
      assert.equal(options.beforeSend, undefined);
      return { ok: false, sent: false, error: "send_failed" };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, [["released"]]);
});

test("a claim error and a release error both leave later groups runnable", async () => {
  const sent = [];
  const failures = [];
  const result = await runDailySummaries({
    dateText: "2026-07-29",
    groupIds: [101, 202, 303],
    createGuard: ({ groupId }) => {
      if (groupId === 101) throw new Error("claim failed");
      return { ok: true, release() { if (groupId === 202) throw new Error("release failed"); } };
    },
    loadMessages: () => [{ text: "ready" }],
    sendSummary: async ({ groupId }) => {
      sent.push(groupId);
      return { publicationManaged: true, ok: true, sent: true };
    },
    log: (event, detail) => { if (event === "error") failures.push(detail.stage); },
  });

  assert.deepEqual(sent, [202, 303]);
  assert.deepEqual(failures, ["claim", "release"]);
  assert.equal(result.ok, false);
  assert.equal(result.sent, 2);
  assert.equal(result.results[0].error, "claim failed");
  assert.equal(result.results[1].releaseError, "release failed");
  assert.equal(result.results[1].sent, true);
  assert.equal(result.results[2].ok, true);
});
