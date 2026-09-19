import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureSummaryMessage, forgetSummaryUser, loadSummaryCapture } from "../bridge/group-summary/journal.mjs";
import { prepareSummaryEvidence } from "../bridge/group-summary/evidence.mjs";
import { selectSummaryRecords } from "../bridge/features/conversation-summary/records.mjs";
import { createConversationSummaryService } from "../bridge/features/conversation-summary/service.mjs";
import { previewGroupSummary, sendGroupSummaryForDate } from "../bridge/group-summary/service.mjs";
import { readReport, saveReportRevision } from "../bridge/group-summary/reports.mjs";
import { readSummaryDelivery, resolveSummaryDelivery } from "../bridge/group-summary/publisher.mjs";
import { runDailySummaries } from "../bridge/group-summary/daily.mjs";
import { createDailySummaryCatchUp } from "../bridge/group-summary/catchup.mjs";
import { createSummaryManager } from "../bridge/admin-api/summary-manager.mjs";
import { parseSummaryDateArgs, runSummaryForDateCli } from "../scripts/send-summary-for-date.mjs";

const dateText = "2026-09-16";
const base = Date.parse(dateText + "T10:00:00+08:00");
const range = { from: base, to: base + 600000 };
const target = [{ uid: "11", name: "Member" }];
const unexpected = () => assert.fail("No real model or outbound call is allowed");

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-summary-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, chatLogFile: path.join(root, "legacy.json"), dateText, groupId: 101,
    whitelist: [101], groupWhitelist: [101], delayMs: 0,
    callPrimarySummary: unexpected, callFallbackSummary: unexpected, sendGroupMessage: unexpected, ...extra };
}

function records(texts = Array.from({ length: 8 }, (_, index) => "Independent observation " + index)) {
  return texts.map((text, index) => ({ uid: "11", nickname: "Member", messageId: String(index + 1), ts: base + index * 1000, text }));
}

function modelResult() {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ headline: "", topics: [
    { id: "D001", title: "Observation", body: "A synthetic observation remains open.", status: "open", evidenceIds: ["E0001"] },
  ] }) } }] };
}

test("forgetting rejects replay by event time and still accepts genuinely new messages", t => {
  const options = fixture(t);
  const event = { group_id: 101, user_id: 11, message_id: "old", eventTime: base, text: "forgotten synthetic detail" };
  captureSummaryMessage(event, { ...options, now: base + 1000 });
  forgetSummaryUser("11", { ...options, now: base + 60000 });
  assert.equal(captureSummaryMessage(event, { ...options, now: base + 120000 }).reason, "forgotten_event");
  const legacyMessages = [{ ...records()[0], receivedAt: base + 120000 }];
  assert.equal(loadSummaryCapture(dateText, 101, { ...options, legacyMessages }).messages.length, 0);
  const fresh = { ...event, message_id: "new", eventTime: base + 120000, text: "new synthetic detail" };
  assert.equal(captureSummaryMessage(fresh, { ...options, now: base + 121000 }).ok, true);
  const loaded = loadSummaryCapture(dateText, 101, { ...options, legacyMessages });
  assert.deepEqual(loaded.messages.map(item => item.messageId), ["new"]);
  assert.doesNotMatch(fs.readFileSync(path.join(options.root, "journal", dateText + "-101.jsonl"), "utf8"), /forgotten synthetic/);
});

test("member selection cannot restore forgotten records with a newer arrival timestamp", t => {
  const options = fixture(t);
  forgetSummaryUser("11", { ...options, now: base + 60000 });
  const input = [
    { ...records()[0], receivedAt: base + 120000 },
    { ...records()[1], ts: base + 120000, receivedAt: base + 121000 },
  ];
  const selected = selectSummaryRecords(101, target, range, { ...options, records: input });
  assert.deepEqual(selected.transcript.map(item => item.messageId), ["2"]);
});

const fixed = "\u5df2\u7ecf\u4fee\u597d\u4e86";
const broken = "\u4e0d\u5bf9\uff0c\u8fd8\u662f\u6ca1\u4fee\u597d";
test("daily repeat filtering preserves a renewed confirmation after a reversal", () => {
  for (const replyToMessageId of ["", "parent"]) {
    const input = records([fixed, broken, fixed, fixed]).map(item => ({ ...item, replyToMessageId }));
    const result = prepareSummaryEvidence(input);
    assert.deepEqual(result.messages.map(item => item.text), [fixed, broken, fixed].map(text => text.normalize("NFKC")));
    assert.equal(result.metrics.repeatMessageCount, 1);
  }
});

test("member repeat filtering preserves a renewed confirmation after a reversal", t => {
  const options = fixture(t);
  for (const replyToMessageId of ["", "parent"]) {
    const input = records([fixed, broken, fixed, fixed]).map(item => ({ ...item, replyToMessageId }));
    const result = selectSummaryRecords(101, target, range, { ...options, records: input });
    assert.deepEqual(result.transcript.map(item => item.text), [fixed, broken, fixed]);
  }
});

test("daily generation rejects stale captures before the first model call", async t => {
  const options = fixture(t);
  const capture = { messages: records(), privacyEpoch: 0, coverage: {} };
  forgetSummaryUser("11", options);
  await assert.rejects(previewGroupSummary({ ...options, capture }), /\u6e05\u7406/);
  assert.equal(readReport(dateText, 101, options).revisions.length, 0);
});

test("forgetting during daily primary generation blocks fallback, persistence and sends", async t => {
  const options = fixture(t, { messages: records() });
  let primaryCalls = 0;
  await assert.rejects(sendGroupSummaryForDate({ ...options, callPrimarySummary: async () => {
    primaryCalls++;
    forgetSummaryUser("11", options);
    return null;
  } }), /\u6e05\u7406/);
  assert.equal(primaryCalls, 1);
  assert.equal(readReport(dateText, 101, options).revisions.length, 0);
  assert.equal(readSummaryDelivery(dateText, 101, options).status, "not_sent");
});

test("single-topic regeneration rechecks the revision epoch before fallback", async t => {
  const options = fixture(t, { messages: records() });
  const revision = await previewGroupSummary({ ...options, callPrimarySummary: async () => modelResult() });
  let fallbackCalls = 0;
  const manager = createSummaryManager({ ...options, callPrimarySummary: async () => {
    forgetSummaryUser("11", options);
    return null;
  }, callFallbackSummary: async () => { fallbackCalls++; return null; } });
  await manager.act({ action: "regenerate-topic", groupId: 101, dateText, revisionId: revision.revisionId, discussionId: "D001" });
  await manager.wait();
  assert.equal(manager.snapshot({ groupId: 101, dateText }).jobs.at(-1).phase, "failed");
  assert.equal(fallbackCalls, 0);
  assert.equal(readReport(dateText, 101, options).revisions.length, 0);
});

test("dry-run generates a body without sending, saving a draft, or touching delivery guards", async t => {
  const options = fixture(t, { messages: records(), callPrimarySummary: async () => modelResult() });
  const guard = { get ok() { return unexpected(); } };
  const result = await sendGroupSummaryForDate({ ...options, dryRun: true, guard });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.match(result.summary, /synthetic observation/);
  assert.equal(result.revisionId, undefined);
  assert.equal(result.outputFile, undefined);
  assert.deepEqual(fs.readdirSync(options.root), []);
  const prepared = { ...result, revisionId: "prepared", sent: true };
  const again = await sendGroupSummaryForDate({ ...options, dryRun: true, prepared, guard });
  assert.equal(again.sent, false);
  assert.deepEqual(fs.readdirSync(options.root), []);
});

test("structured service skips unused digest work while preserving opt-in compatibility", async t => {
  const options = fixture(t, { messages: records(), dryRun: true, callPrimarySummary: async () => modelResult() });
  assert.equal((await sendGroupSummaryForDate(options)).digest, null);
  assert.equal((await sendGroupSummaryForDate({ ...options, includeDigest: true })).digest.messageCount, 8);
});

test("daily aggregate distinguishes pending guards from already-sent and empty groups", async () => {
  for (const reason of ["previous_attempt_unconfirmed", "already_running"]) {
    const result = await runDailySummaries({ dateText, groupIds: [101], createGuard: () => ({ ok: false, reason }), loadMessages: unexpected, sendSummary: unexpected });
    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.equal(result.results[0].reason, reason);
  }
  const sent = await runDailySummaries({ dateText, groupIds: [101], createGuard: () => ({ ok: false, reason: "already_sent" }), loadMessages: unexpected });
  assert.equal(sent.ok, true);
  assert.equal(sent.pending, false);
});

test("catch-up exhausts pending or failed work without claiming completion", async () => {
  for (const pending of [true, false]) {
    const events = [];
    const catchUp = createDailySummaryCatchUp({ maxRunAttempts: 1, now: () => new Date(base),
      run: async () => ({ ok: false, pending, groups: 1, sent: 0 }), log: event => events.push(event) });
    await catchUp.runNow();
    assert.equal(catchUp.status().completed, false);
    assert.equal(catchUp.status().exhausted, true);
    assert.equal(catchUp.status().scheduled, false);
    assert.equal(await catchUp.runNow(), null);
    assert.equal(events.includes("complete"), false);
  }
});

test("unconfirmed delivery stays pending and a manual retry never reports done or resends", async t => {
  let sends = 0;
  const options = fixture(t, { messages: records(), callPrimarySummary: async () => modelResult(),
    sendGroupMessage: async () => { sends++; return { status: "unknown", delivery: "unconfirmed" }; } });
  const prepared = await previewGroupSummary(options);
  const first = await sendGroupSummaryForDate({ ...options, prepared });
  assert.equal(first.ok, false);
  assert.equal(first.pending, true);
  const retry = await sendGroupSummaryForDate({ ...options, prepared });
  assert.equal(retry.ok, false);
  assert.equal(retry.pending, true);
  assert.equal(retry.reason, "previous_attempt_unconfirmed");
  const manager = createSummaryManager(options);
  await manager.act({ action: "send", groupId: 101, dateText, revisionId: prepared.revisionId });
  await manager.wait();
  const job = manager.snapshot({ groupId: 101, dateText }).jobs.at(-1);
  assert.equal(job.phase, "failed");
  assert.equal(job.pending, true);
  assert.equal(sends, 1);
  assert.equal(readSummaryDelivery(dateText, 101, options).status, "unconfirmed");
});

test("unknown ack after a confirmed chunk preserves the fence until manual verification", async t => {
  const sent = [];
  const options = fixture(t, { messages: records(), callPrimarySummary: async () => modelResult(), sendGroupMessage: async (_group, text) => {
    sent.push(text);
    return sent.length === 2 ? { status: "unknown", delivery: "unconfirmed" } : { status: "ok" };
  } });
  const original = await previewGroupSummary(options);
  const summary = "A".repeat(900) + "B".repeat(900) + "C".repeat(100);
  const revision = saveReportRevision({ ...original, summary }, options);
  const prepared = { ...original, summary, revisionId: revision.id };
  const first = await sendGroupSummaryForDate({ ...options, prepared });
  assert.equal(first.ok, false);
  assert.equal(first.pending, true);
  assert.equal(first.delivery.status, "unconfirmed");
  assert.equal(first.delivery.completed, 1);
  const directory = path.join(options.root, "delivery");
  assert.equal(fs.existsSync(path.join(directory, dateText + "-101.attempt.json")), true);
  assert.equal(fs.existsSync(path.join(directory, dateText + "-101.sent.json")), false);
  assert.equal((await sendGroupSummaryForDate({ ...options, prepared })).pending, true);
  await assert.rejects(sendGroupSummaryForDate({ ...options, prepared, resume: true }), /\u5df2\u786e\u8ba4\u5931\u8d25/);
  assert.equal(sent.length, 2);
  resolveSummaryDelivery(prepared, false, options);
  const resumed = await sendGroupSummaryForDate({ ...options, prepared, resume: true });
  assert.equal(resumed.sent, true);
  assert.equal(sent.filter(text => text.startsWith("A")).length, 1);
  assert.equal(sent.filter(text => text.startsWith("B")).length, 2);
  assert.equal(sent.filter(text => text.startsWith("C")).length, 1);
});

test("member summary stops after the explicit unknown ack without retrying or reporting done", async t => {
  const options = fixture(t);
  let sends = 0;
  const service = createConversationSummaryService({ ...options, records: records(), now: range.to,
    jobFile: path.join(options.root, "member-jobs.json"),
    callProvider: async () => ({ ok: true, provider: "synthetic", raw: {
      choices: [{ finish_reason: "stop", message: { content: "A synthetic observation. ".repeat(100) } }],
    } }),
    sender: async () => { sends++; return sends === 1 ? { status: "ok" } : { status: "unknown", delivery: "unconfirmed" }; },
  });
  await service.handle({ isAtMe: true, group_id: 101, user_id: 11, nickname: "Member", message_id: "request", mentions: [] }, { self: true, rangeText: "\u4eca\u5929" });
  await service.wait();
  const job = service.snapshot().tasks.at(-1);
  assert.equal(sends, 2);
  assert.equal(job.phase, "failed");
  assert.equal(job.sent, false);
  assert.equal(job.reason, "send_unconfirmed");
  assert.equal(fs.existsSync(path.join(options.root, "delivery")), false);
});

test("date CLI accepts explicit or sole configured groups and rejects ambiguous or invalid inputs", () => {
  const options = { groupWhitelist: [101], now: new Date("2026-09-17T00:05:00+08:00") };
  assert.deepEqual(parseSummaryDateArgs([], options), { dateText, groupId: 101, dryRun: false });
  for (const args of [[dateText, "--group", "101", "--dry-run"], ["--group=101", dateText, "--dry-run"], [dateText, "101", "--dry-run"]]) {
    assert.deepEqual(parseSummaryDateArgs(args, options), { dateText, groupId: 101, dryRun: true });
  }
  for (const args of [["--group"], ["--group=0"], ["--group=9007199254740992"], ["2026-02-30"], ["--force"], ["--group=101", "--group=101"]]) {
    assert.throws(() => parseSummaryDateArgs(args, options));
  }
  assert.throws(() => parseSummaryDateArgs([], { groupWhitelist: [101, 202] }), /--group/);
  assert.throws(() => parseSummaryDateArgs([], { groupWhitelist: [] }), /--group/);
});

test("date CLI reports actual outcomes and nonzero status for pending or failed sends", async () => {
  const cases = [
    [{ ok: false, sent: false, error: "generation_failed" }, "failed", 1],
    [{ ok: false, sent: false, pending: true, reason: "previous_attempt_unconfirmed" }, "pending", 1],
    [{ ok: true, sent: false }, "failed", 1],
    [{ ok: true, sent: false, skipped: true, reason: "already_sent" }, "skipped", 0],
    [{ ok: true, sent: true }, "sent", 0],
  ];
  for (const [result, status, exitCode] of cases) {
    const output = await runSummaryForDateCli([dateText, "--group", "101"], { run: async () => result });
    assert.equal(output.output.status, status);
    assert.equal(output.output.ok, exitCode === 0);
    assert.equal(output.exitCode, exitCode);
  }
});

test("date CLI dry-run uses the actual no-persistence path", async t => {
  const options = fixture(t, { messages: records(), callPrimarySummary: async () => modelResult() });
  const result = await runSummaryForDateCli([dateText, "--group", "101", "--dry-run"], options);
  assert.equal(result.output.status, "generated");
  assert.equal(result.output.sent, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.output.summary, /synthetic observation/);
  assert.deepEqual(fs.readdirSync(options.root), []);
});
