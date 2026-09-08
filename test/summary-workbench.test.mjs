import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { formatDate } from "../bridge/group-summary/date.mjs";
import { captureSummaryMessage, cleanupSummaryFiles, forgetSummaryUser, loadSummaryCapture } from "../bridge/group-summary/journal.mjs";
import { buildDiscussionBundle, parseSummaryDocument, renderSummaryDocument } from "../bridge/group-summary/analysis.mjs";
import { prepareSummaryEvidence } from "../bridge/group-summary/evidence.mjs";
import { createDailySummaryGuard } from "../bridge/group-summary/guard.mjs";
import { publishSummary, readSummaryDelivery, resolveSummaryDelivery } from "../bridge/group-summary/publisher.mjs";
import { previewGroupSummary, sendGroupSummaryForDate } from "../bridge/group-summary/service.mjs";
import { readReport, saveReportRevision } from "../bridge/group-summary/reports.mjs";
import { summaryPrivacy } from "../bridge/group-summary/state.mjs";
import { createSummaryManager } from "../bridge/admin-api/summary-manager.mjs";
import { handleAdminApiRequest } from "../bridge/admin-api/routes.mjs";
import { buildGroupSummaryCommandReply } from "../bridge/group-summary/commands.mjs";

const day = formatDate();
const base = Date.parse(day + "T10:00:00+08:00");

function sandbox(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-summary-v2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, chatLogFile: path.join(root, "legacy.json"), whitelist: [101], groupWhitelist: [101], dateText: day, groupId: "101", delayMs: 0, ...extra };
}
function event(id, text, extra = {}) { return { group_id: 101, user_id: 11, message_id: id, nickname: "小林", text, images: [], files: [], eventTime: base + id * 1000, ...extra }; }
function capture(options, id, text, extra = {}) { return captureSummaryMessage(event(id, text, extra), { ...options, now: base + 100000 }); }
function prepared(options, text = "测试日报") { return { ok: true, sent: false, groupId: "101", dateText: day, summary: text, revisionId: "revision-1", privacyEpoch: summaryPrivacy(options).epoch, messages: 8 }; }
function modelResult(text = "已反馈仍未恢复", id = "D001", refs = ["E0001"]) {
  return { choices: [{ message: { content: JSON.stringify({ headline: "", topics: [{ id, title: "显示器排查", body: text, status: "open", evidenceIds: refs }] }) } }] };
}
function messages() { return Array.from({ length: 8 }, (_, index) => ({ uid: "11", nickname: "小林", messageId: String(index + 1), ts: base + index * 1000, text: "显示器黑屏，尝试更新驱动 " + index })); }

test("journal survives rolling-history eviction, deduplicates event ids and redacts before disk", t => {
  const options = sandbox(t);
  capture(options, 1, "早上排查显示器");
  capture(options, 2, "Authorization: Bearer synthetic-token sk-abcdefghijklmnop");
  capture(options, 2, "duplicate must not appear");
  fs.writeFileSync(options.chatLogFile, JSON.stringify({ 101: [{ uid: "11", ts: base, messageId: "2", text: "legacy copy" }] }));
  const result = loadSummaryCapture(day, 101, options);
  assert.equal(result.messages.length, 2);
  assert.equal(result.coverage.complete, false);
  const raw = fs.readFileSync(path.join(options.root, "journal", day + "-101.jsonl"), "utf8");
  assert.doesNotMatch(raw, /synthetic-token|abcdefghijklmnop|duplicate must/);
});

test("journal records original event day rather than delayed arrival day", t => {
  const options = sandbox(t);
  const yesterday = new Date(base - 86400000);
  captureSummaryMessage(event(1, "昨天的讨论", { eventTime: yesterday.getTime() }), { ...options, now: base });
  assert.equal(loadSummaryCapture(formatDate(yesterday), 101, options).messages.length, 1);
  assert.equal(loadSummaryCapture(day, 101, options).messages.length, 0);
});

test("expired backlog is not reclassified as today's discussion", t => {
  const options = sandbox(t);
  const result = captureSummaryMessage(event(1, "old backlog", { eventTime: base - 8 * 86400000 }), { ...options, now: base });
  assert.equal(result.reason, "expired_event");
  assert.equal(loadSummaryCapture(day, 101, options).messages.length, 0);
});

test("journal enforces group allowlist and reports capacity loss", t => {
  const options = sandbox(t, { maxMessages: 1 });
  assert.equal(captureSummaryMessage(event(1, "blocked", { group_id: 202 }), options).reason, "not_whitelisted");
  capture(options, 1, "first");
  assert.equal(capture(options, 2, "second").reason, "capacity");
  assert.equal(loadSummaryCapture(day, 101, options).coverage.capped, true);
});

test("long evidence keeps its final correction and indicates truncation", t => {
  const options = sandbox(t);
  capture(options, 1, "开始排查" + "过程记录".repeat(700) + "最后确认仍然黑屏");
  const item = loadSummaryCapture(day, 101, options).messages[0];
  assert.ok(item.text.length <= 1800);
  assert.match(item.text, /最后确认仍然黑屏$/);
  assert.equal(item.truncated, true);
});

test("torn journal tails do not swallow the next complete message", t => {
  const options = sandbox(t);
  const dir = path.join(options.root, "journal"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, day + "-101.jsonl"), '{"partial":');
  capture(options, 1, "后续完整消息");
  const result = loadSummaryCapture(day, 101, options);
  assert.equal(result.messages.length, 1); assert.equal(result.coverage.malformed, 1);
});

test("independent confirmations and different reply targets survive repeat filtering", () => {
  const records = [
    { uid: "1", text: "已经修好了", ts: base, replyToMessageId: "10" },
    { uid: "2", text: "已经修好了", ts: base + 1000, replyToMessageId: "10" },
    { uid: "1", text: "已经修好了", ts: base + 2000, replyToMessageId: "20" },
    { uid: "1", text: "已经修好了", ts: base + 3000, replyToMessageId: "20" },
  ];
  const result = prepareSummaryEvidence(records);
  assert.equal(result.messages.length, 3); assert.equal(result.metrics.repeatMessageCount, 1);
});

test("discussion grouping follows cross-time reply links and keeps unrelated talk separate", () => {
  const bundle = buildDiscussionBundle([
    { uid: "1", nickname: "同名", messageId: "1", ts: base, text: "显示器更新驱动后黑屏" },
    { uid: "2", nickname: "同名", messageId: "2", ts: base + 1000, text: "晚饭吃火锅" },
    { uid: "1", messageId: "3", replyToMessageId: "1", ts: base + 5 * 3600000, text: "换了线，还是没好" },
  ]);
  const linked = bundle.discussions.find(item => item.messages.some(message => message.messageId === "1"));
  assert.ok(linked.messages.some(item => item.messageId === "3"));
  assert.equal(linked.messages.some(item => item.messageId === "2"), false);
  const actors = bundle.discussions.flatMap(item => item.messages).map(item => item.actorId);
  assert.equal(new Set(actors).size, 2);
});

test("structured document rejects unknown, cross-discussion and malformed evidence", () => {
  const bundle = buildDiscussionBundle(messages());
  assert.equal(parseSummaryDocument("null", bundle), null);
  assert.equal(parseSummaryDocument('{"topics":[null]}', bundle), null);
  assert.equal(parseSummaryDocument(modelResult("x", "D999").choices[0].message.content, bundle), null);
  assert.equal(parseSummaryDocument(modelResult("x", "D001", ["E9999"]).choices[0].message.content, bundle), null);
  const valid = parseSummaryDocument(modelResult().choices[0].message.content, bundle);
  assert.ok(valid);
  const rendered = renderSummaryDocument(valid, bundle, { dateText: day });
  assert.match(rendered, /已反馈仍未恢复/); assert.doesNotMatch(rendered, /E0001|经过：|状态：|话痨/);
});

test("draft evidence drops legacy image URLs and sanitizes nickname credentials", () => {
  const bundle = buildDiscussionBundle([{ uid: "1", nickname: "sk-abcdefghijklmnop", text: "显示器排查", ts: base, imageUrls: ["https://example.com/private-token"] }]);
  assert.doesNotMatch(JSON.stringify(bundle), /abcdefghijklmnop|private-token|imageUrls/);
});

test("preview creates private revisions without QQ sends and preserves prior versions", async t => {
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => modelResult(), sendGroupMessage: () => assert.fail("must not send") });
  const first = await previewGroupSummary(options);
  const second = await previewGroupSummary(options);
  assert.equal(first.sent, false);
  assert.notEqual(first.revisionId, second.revisionId);
  assert.equal(readReport(day, 101, options).revisions.length, 2);
});

test("invalid primary structure uses fallback instead of publishing unverified free text", async t => {
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => ({ choices: [{ message: { content: "Everything fixed without evidence" } }] }), callFallbackSummary: async () => modelResult("备用模型依据记录给出回复") });
  const result = await previewGroupSummary(options);
  assert.equal(result.provider, "mimo"); assert.match(result.summary, /备用模型/);
  assert.doesNotMatch(result.summary, /Everything fixed/);
});

test("pending delivery pins the original draft across later revision retention", async t => {
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => modelResult(), sendGroupMessage: async () => null });
  const original = await previewGroupSummary(options);
  await publishSummary(original, options);
  for (let index = 0; index < 12; index++) saveReportRevision({ ...original, summary: "后续修改 " + index }, options);
  const revisions = readReport(day, 101, options).revisions;
  assert.equal(revisions.length, 10);
  assert.equal(revisions[0].id, original.revisionId);
  assert.equal(revisions[0].summary, original.summary);
  assert.equal(revisions.at(-1).summary, "后续修改 11");
});

test("structured JSON is not erased by legacy presentation-line filtering", async t => {
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => modelResult("有群友反馈，显示器驱动尚未进入讨论。"), callFallbackSummary: () => assert.fail("valid JSON must not trigger fallback") });
  const result = await previewGroupSummary(options);
  assert.equal(result.provider, "deepseek");
  assert.match(result.document.topics[0].body, /尚未进入讨论/);
});

test("privacy cleanup removes journal and related drafts and blocks in-flight stale generation", async t => {
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => modelResult() });
  capture(options, 1, "private discussion");
  const result = await previewGroupSummary(options);
  forgetSummaryUser("11", { ...options, now: base + 200000 });
  assert.equal(loadSummaryCapture(day, 101, options).messages.length, 0);
  assert.equal(readReport(day, 101, options).revisions.length, 0);
  assert.throws(() => saveReportRevision(result, options), /清理/);
});

test("retention deletes only expired journal and report files", t => {
  const options = sandbox(t);
  const dir = path.join(options.root, "journal"); fs.mkdirSync(dir);
  const old = formatDate(new Date(base - 9 * 86400000));
  fs.writeFileSync(path.join(dir, old + "-101.jsonl"), "");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "keep");
  cleanupSummaryFiles({ ...options, now: base });
  assert.equal(fs.existsSync(path.join(dir, old + "-101.jsonl")), false);
  assert.equal(fs.existsSync(path.join(dir, "unrelated.txt")), true);
});

test("all sends share a group/date guard and do not publish a second revision twice", async t => {
  let calls = 0;
  const options = sandbox(t, { sendGroupMessage: async () => { calls++; return { status: "ok" }; } });
  const first = await publishSummary(prepared(options), options);
  const second = await publishSummary({ ...prepared(options), revisionId: "revision-2" }, options);
  assert.equal(first.sent, true); assert.equal(second.skipped, true); assert.equal(calls, 1);
});

test("confirmed partial failure resumes only remaining chunks of the identical revision", async t => {
  const sent = [];
  const options = sandbox(t, { sendGroupMessage: async (_group, text) => { sent.push(text); return sent.length === 2 ? { status: "failed", retcode: 1 } : { status: "ok" }; } });
  const report = prepared(options, "甲".repeat(900) + "乙".repeat(900) + "丙".repeat(100));
  const first = await publishSummary(report, options);
  assert.equal(first.delivery.status, "partial"); assert.equal(first.delivery.completed, 1);
  const blocked = await publishSummary(report, options);
  assert.equal(blocked.skipped, true);
  const resumed = await publishSummary(report, { ...options, resume: true });
  assert.equal(resumed.sent, true);
  assert.equal(sent.filter(text => text.startsWith("甲")).length, 1);
  assert.equal(sent.filter(text => text.startsWith("乙")).length, 2);
});

test("ambiguous network failure requires explicit verification before any retry", async t => {
  const options = sandbox(t, { sendGroupMessage: async () => null });
  const report = prepared(options);
  const result = await publishSummary(report, options);
  assert.equal(result.delivery.status, "unconfirmed");
  assert.equal((await publishSummary(report, options)).skipped, true);
  await assert.rejects(publishSummary(report, { ...options, resume: true }), /已确认失败/);
  resolveSummaryDelivery(report, false, options);
  const sent = await publishSummary(report, { ...options, resume: true, sendGroupMessage: async () => ({ status: "ok" }) });
  assert.equal(sent.sent, true);
});

test("manual confirmation of delivery marks success without resending", async t => {
  let calls = 0;
  const options = sandbox(t, { sendGroupMessage: async () => { calls++; return null; } });
  const report = prepared(options);
  await publishSummary(report, options);
  const result = resolveSummaryDelivery(report, true, options);
  assert.equal(result.sent, true); assert.equal(calls, 1);
  assert.equal(readSummaryDelivery(day, 101, options).status, "sent");
});

test("the same unknown segment cannot be manually confirmed twice", async t => {
  const options = sandbox(t, { sendGroupMessage: async () => null });
  const report = prepared(options, "甲".repeat(1800));
  await publishSummary(report, options);
  const confirmed = resolveSummaryDelivery(report, true, options);
  assert.equal(confirmed.delivery.completed, 1);
  assert.throws(() => resolveSummaryDelivery(report, true, options), /没有可核实/);
  assert.equal(readSummaryDelivery(day, 101, options).completed, 1);
});

test("failed recovery cannot erase an active sender's pending attempt", t => {
  const options = sandbox(t);
  const rootDir = path.join(options.root, "delivery");
  const first = createDailySummaryGuard({ dateText: day, groupId: 101, rootDir });
  first.markAttempt({ revisionId: "one" });
  const second = createDailySummaryGuard({ dateText: day, groupId: 101, rootDir, recoverUnconfirmed: true });
  assert.equal(second.reason, "already_running");
  assert.equal(fs.existsSync(first.attemptFile), true);
  first.release();
});

test("draft manager provides progress, edits, conflict detection and private evidence", async t => {
  const options = sandbox(t, { callPrimarySummary: async () => modelResult() });
  for (let index = 1; index <= 8; index++) capture(options, index, "显示器驱动排查记录 " + index);
  const manager = createSummaryManager(options);
  const job = await manager.act({ action: "generate", groupId: 101, dateText: day });
  assert.ok(job.jobId); await manager.wait();
  let snapshot = manager.snapshot({ groupId: 101, dateText: day });
  assert.equal(snapshot.jobs.at(-1).phase, "done");
  const revision = snapshot.revisions.at(-1);
  assert.ok(revision.evidence.length);
  assert.equal(Object.hasOwn(revision.evidence[0], "uid"), false);
  await manager.act({ action: "save", groupId: 101, dateText: day, revisionId: revision.id, expectedRevisionId: revision.id, summary: "人工修订的日报" });
  snapshot = manager.snapshot({ groupId: 101, dateText: day });
  assert.equal(snapshot.revisions.length, 2);
  assert.equal(snapshot.revisions.at(-1).document, null);
  await assert.rejects(manager.act({ action: "save", groupId: 101, dateText: day, revisionId: revision.id, expectedRevisionId: revision.id, summary: "旧版本覆盖" }), /已有新版本/);
});

test("draft manager prevents overlapping same-scope generation", async t => {
  let finish;
  const options = sandbox(t, { preview: () => new Promise(resolve => { finish = resolve; }) });
  const manager = createSummaryManager(options);
  await manager.act({ action: "generate", groupId: 101, dateText: day });
  await assert.rejects(manager.act({ action: "generate", groupId: 101, dateText: day }), /已有任务/);
  finish({ ok: true }); await manager.wait();
});

test("regenerating one discussion preserves the remaining discussion bodies", async t => {
  let regenerating = false;
  const options = sandbox(t, { callPrimarySummary: async prompt => {
    const matches = [...prompt.matchAll(/(?:^|\n)(D\d+)\n(E\d+)/g)];
    return { choices: [{ message: { content: JSON.stringify({ headline: "旧的总括句", headlineEvidenceIds: [matches[0][2]], topics: matches.map((match, index) => ({ id: match[1], title: "话题" + index, body: regenerating ? "重写后的讨论" : "原讨论 " + match[1], status: "chat", evidenceIds: [match[2]] })) }) } }] };
  } });
  for (let index = 1; index <= 8; index++) capture(options, index, index % 2 ? "显示器驱动排查 " + index : "晚饭火锅菜单 " + index);
  const manager = createSummaryManager(options);
  await manager.act({ action: "generate", groupId: 101, dateText: day }); await manager.wait();
  const original = manager.snapshot({ groupId: 101, dateText: day }).revisions.at(-1);
  assert.equal(original.document.topics.length, 2);
  assert.equal(original.document.headline, "旧的总括句");
  regenerating = true;
  await manager.act({ action: "regenerate-topic", groupId: 101, dateText: day, revisionId: original.id, expectedRevisionId: original.id, discussionId: original.document.topics[0].id });
  await manager.wait();
  const updated = manager.snapshot({ groupId: 101, dateText: day }).revisions.at(-1);
  assert.equal(updated.document.topics[0].body, "重写后的讨论");
  assert.equal(updated.document.topics[1].body, original.document.topics[1].body);
  assert.equal(updated.document.headline, "");
  assert.deepEqual(updated.document.headlineEvidenceIds, []);
});

test("read-only snapshots mark abandoned jobs interrupted after process replacement", async t => {
  let finish;
  const options = sandbox(t, { preview: () => new Promise(resolve => { finish = resolve; }) });
  const first = createSummaryManager(options);
  await first.act({ action: "generate", groupId: 101, dateText: day });
  const replacement = createSummaryManager(options);
  assert.equal(replacement.snapshot({ groupId: 101, dateText: day }).jobs.at(-1).phase, "interrupted");
  finish({ ok: true }); await first.wait();
});

test("publishing rejects stale privacy epochs without sending anything", async t => {
  const options = sandbox(t, { sendGroupMessage: () => assert.fail("must not send") });
  const report = prepared(options);
  forgetSummaryUser("11", options);
  await assert.rejects(publishSummary(report, options), /清理/);
});

test("cross-group previews are denied before generation", async () => {
  const text = await buildGroupSummaryCommandReply("日报预览 2000000002 昨天", { groupId: 2000000001, callPrimarySummary: () => assert.fail("no model") });
  assert.match(text, /跨群日报预览/);
});

test("summary workbench APIs require the existing admin token and reject public callers", async () => {
  for (const method of ["GET", "POST"]) {
    const results = [];
    const req = Readable.from([]);
    Object.assign(req, { method, url: "/admin/summaries", socket: { remoteAddress: "203.0.113.5" }, headers: {} });
    await handleAdminApiRequest(req, {}, { pathname: "/admin/summaries", requiredToken: "test-only", sendJson(_res, code) { results.push(code); } });
    assert.deepEqual(results, [403]);
  }
});

test("existing service entrypoint also observes the publication guard", async t => {
  let calls = 0;
  const options = sandbox(t, { messages: messages(), callPrimarySummary: async () => modelResult(), sendGroupMessage: async () => { calls++; return { status: "ok" }; } });
  const first = await sendGroupSummaryForDate(options);
  const second = await sendGroupSummaryForDate(options);
  assert.equal(first.sent, true); assert.equal(second.skipped, true); assert.equal(calls, 1);
});
