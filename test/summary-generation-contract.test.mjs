import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDiscussionBundle, buildStructuredSummaryPrompt, parseSummaryDocument, parseSummaryDocumentResult, renderSummaryDocument } from "../bridge/group-summary/analysis.mjs";
import { budgetDiscussionEvidence } from "../bridge/group-summary/evidence-budget.mjs";
import { generateGroupSummaryResult } from "../bridge/group-summary/providers.mjs";
import { createSummaryPlan } from "../bridge/group-summary/generation-plans.mjs";
import { sendGroupSummaryForDate } from "../bridge/group-summary/service.mjs";
import { readReport, saveReportRevision } from "../bridge/group-summary/reports.mjs";
import { readSummaryDelivery } from "../bridge/group-summary/publisher.mjs";
import { summaryPrivacy } from "../bridge/group-summary/state.mjs";
import { createSummaryManager } from "../bridge/admin-api/summary-manager.mjs";

const dateText = "2026-09-13";
const start = Date.parse(dateText + "T00:00:00+08:00");
const message = (id, text, offset = 0) => ({ uid: "11", nickname: "测试成员", actorId: "P1", evidenceId: id, text, ts: start + offset });
const bundle = {
  discussions: [
    { id: "D196", messages: [message("E0390", "晚上去食堂聊天吗？")], messageCount: 1 },
    { id: "D267", messages: [message("E0406", "好，我下楼过去。", 60000)], messageCount: 1 },
    { id: "D302", messages: [message("E0531", "显示器换线之后仍然黑屏。", 120000)], messageCount: 1 },
  ], stats: { effectiveMessageCount: 9, messageCount: 9, speakerCount: 2 },
};
const merged = () => ({ headline: "", topics: [{ id: "D196", sourceDiscussionIds: ["D196", "D267"], title: "约在食堂聊天", body: "有人约在食堂聊天，另一人表示准备过去。", status: "chat", evidenceIds: ["E0390", "E0406"] }] });
const raw = document => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(document) } }] });
const records = bundle.discussions.flatMap(item => item.messages);
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, groupId: "101", groupWhitelist: [101], whitelist: [101], dateText, bundle, messages: records, lowMessageLimit: 0, delayMs: 0 };
}

test("declared multi-fragment topics accept only evidence in their declared sources", () => {
  const document = parseSummaryDocument(JSON.stringify(merged()), bundle);
  assert.deepEqual(document.topics[0].sourceDiscussionIds, ["D196", "D267"]);
  assert.deepEqual(document.topics[0].evidenceIds, ["E0390", "E0406"]);
});

test("source membership is computed from known evidence without a redundant model index", () => {
  const value = merged(); delete value.topics[0].sourceDiscussionIds;
  assert.deepEqual(parseSummaryDocument(JSON.stringify(value), bundle).topics[0].sourceDiscussionIds, ["D196", "D267"]);
});

test("unknown sources, invented evidence and unrelated topic anchors fail", () => {
  for (const change of [
    topic => topic.sourceDiscussionIds.push("D999"),
    topic => topic.evidenceIds.push("E9999"),
    topic => { topic.id = "D302"; },
  ]) {
    const value = merged(); change(value.topics[0]);
    assert.equal(parseSummaryDocument(JSON.stringify(value), bundle), null);
  }
});

test("unused but valid declared sources are pruned rather than trusted or treated as a fatal error", () => {
  const value = merged(); value.topics[0].sourceDiscussionIds.push("D302");
  assert.deepEqual(parseSummaryDocument(JSON.stringify(value), bundle).topics[0].sourceDiscussionIds, ["D196", "D267"]);
});

test("legacy single-source documents remain readable", () => {
  const value = merged(); delete value.topics[0].sourceDiscussionIds; value.topics[0].evidenceIds = ["E0390"];
  assert.deepEqual(parseSummaryDocument(JSON.stringify(value), bundle).topics[0].sourceDiscussionIds, ["D196"]);
});

test("headline references cannot come from unselected evidence", () => {
  const value = { ...merged(), headline: "某项情况", headlineEvidenceIds: ["E0531"] };
  assert.equal(parseSummaryDocumentResult(JSON.stringify(value), bundle).reason, "invalid_headline_evidence");
});

test("scoped rewrites keep a stable topic identity and cannot return multiple topics", () => {
  assert.ok(parseSummaryDocument(JSON.stringify(merged()), bundle, { onlyDiscussionId: "D196" }));
  assert.equal(parseSummaryDocumentResult(JSON.stringify(merged()), bundle, { onlyDiscussionId: "D267" }).reason, "rewrite_scope_mismatch");
  const duplicate = merged(); duplicate.topics.push(duplicate.topics[0]);
  assert.equal(parseSummaryDocumentResult(JSON.stringify(duplicate), bundle).reason, "duplicate_topic");
});

test("prompt uses actual identifiers and distinguishes plans from completed outcomes", () => {
  const prompt = buildStructuredSummaryPrompt(bundle, { dateText });
  assert.match(prompt, /"id":"D196"/);
  assert.match(prompt, /来源片段由程序计算/);
  assert.doesNotMatch(prompt, /"id":"D001"|"E0001"/);
  assert.match(prompt, /快要过万.*接近过万/);
  assert.match(prompt, /同一件事跨多个片段/);
});

test("in-budget input preserves the whole day instead of only five fragments", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ uid: String(i + 1), text: "一段有内容的讨论 " + i, ts: start + i * 7200000 }));
  const result = buildDiscussionBundle(input);
  assert.equal(result.discussions.length, 12);
  assert.equal(result.selection.included, 12);
  assert.equal(result.selection.sampled, false);
});

test("over-budget sampling is bounded and preserves the beginning and end", () => {
  const input = [{ id: "D001", messages: Array.from({ length: 100 }, (_, i) => message("E" + i, "记录".repeat(60) + "最终情况" + i, i * 1000)) }];
  const result = budgetDiscussionEvidence(input, { evidenceBudgetChars: 2000 });
  const kept = result.discussions[0].messages;
  assert.ok(result.selection.chars <= 2000);
  assert.equal(result.selection.sampled, true);
  assert.equal(kept[0].evidenceId, "E0"); assert.equal(kept.at(-1).evidenceId, "E99");
  assert.ok(kept.some(item => item.evidenceId === "E49"));
  const text = renderSummaryDocument({ topics: [] }, { ...result, stats: bundle.stats }, { dateText });
  assert.match(text, /抽样或截短/);
});

test("long evidence retains the final correction and reports clipping", () => {
  const result = budgetDiscussionEvidence([{ id: "D001", messages: [message("E1", "过程".repeat(900) + "最后确认没修好")] }]);
  assert.match(result.discussions[0].messages[0].text, /最后确认没修好$/);
  assert.equal(result.selection.truncated, 1);
});

test("valid merged output does not waste a fallback call", async () => {
  const result = await generateGroupSummaryResult(records, { dateText, bundle, structured: true, lowMessageLimit: 0,
    callPrimarySummary: async () => raw(merged()), callFallbackSummary: () => assert.fail("must not call fallback") });
  assert.equal(result.provider, "deepseek"); assert.match(result.text, /食堂/);
});

test("double invalid generation neither publishes placeholders nor marks the day sent", async t => {
  const options = sandbox(t); let sends = 0;
  const invalid = raw({ topics: [{ id: "D999" }] });
  const result = await sendGroupSummaryForDate({ ...options, callPrimarySummary: async () => invalid, callFallbackSummary: async () => invalid,
    sendGroupMessage: async () => { sends++; return { status: "ok" }; } });
  assert.equal(result.ok, false); assert.equal(result.error, "generation_failed");
  assert.match(result.message, /未发送占位提要/); assert.equal(sends, 0);
  assert.equal(readSummaryDelivery(dateText, "101", options).status, "not_sent");
  assert.equal(readReport(dateText, "101", options).revisions.length, 0);
  const retry = await sendGroupSummaryForDate({ ...options, callPrimarySummary: async () => raw(merged()),
    sendGroupMessage: async () => { sends++; return { status: "ok" }; } });
  assert.equal(retry.sent, true); assert.equal(sends, 1);
});

test("truncated structured output falls back even when its JSON is syntactically valid", async () => {
  const truncated = raw(merged()); truncated.choices[0].finish_reason = "length";
  const result = await generateGroupSummaryResult(records, { dateText, bundle, structured: true, lowMessageLimit: 0,
    callPrimarySummary: async () => truncated, callFallbackSummary: async () => raw(merged()) });
  assert.equal(result.provider, "mimo"); assert.doesNotMatch(result.text, /被模型截断/);
});

test("single-topic rewrite includes all original sources without unrelated fragments", () => {
  const plan = createSummaryPlan(records, { dateText, bundle, structured: true, lowMessageLimit: 0,
    onlyDiscussionId: "D196", onlyDiscussionIds: ["D196", "D267"] }, {});
  assert.match(plan.prompt(), /E0390/); assert.match(plan.prompt(), /E0406/);
  assert.doesNotMatch(plan.prompt(), /E0531/);
  assert.equal(plan.parse(JSON.stringify(merged())).ok, true);
  const escaped = merged(); escaped.topics[0].evidenceIds.push("E0531");
  assert.equal(plan.parse(JSON.stringify(escaped)).ok, false);
});

test("admin topic rewrite preserves merged evidence and handles generation failure without losing the draft", async t => {
  const options = sandbox(t); let fail = false;
  const initial = saveReportRevision({ ...options, summary: "原稿", document: parseSummaryDocument(JSON.stringify(merged()), bundle), privacyEpoch: summaryPrivacy(options).epoch }, options);
  const manager = createSummaryManager({ ...options,
    callPrimarySummary: async prompt => { assert.match(prompt, /E0406/); assert.doesNotMatch(prompt, /E0531/); return fail ? raw({}) : raw(merged()); },
    callFallbackSummary: async () => raw({}) });
  await manager.act({ action: "regenerate-topic", groupId: "101", dateText, revisionId: initial.id, discussionId: "D196" });
  await manager.wait();
  const updated = readReport(dateText, "101", options).revisions;
  assert.equal(updated.length, 2); assert.deepEqual(updated[1].document.topics[0].sourceDiscussionIds, ["D196", "D267"]);
  fail = true;
  await manager.act({ action: "regenerate-topic", groupId: "101", dateText, revisionId: updated[1].id, discussionId: "D196" });
  await manager.wait();
  assert.equal(readReport(dateText, "101", options).revisions.length, 2);
  assert.equal(manager.snapshot({ groupId: "101", dateText }).jobs.at(-1).phase, "failed");
});
