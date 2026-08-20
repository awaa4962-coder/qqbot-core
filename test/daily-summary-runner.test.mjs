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

test("daily summary runner clears a reserved attempt after a confirmed send failure", async () => {
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
      await options.beforeSend({ messages: 1 });
      return { ok: false, sent: false, error: "send_failed" };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, [["attempt", 1], ["failed"], ["released"]]);
});
