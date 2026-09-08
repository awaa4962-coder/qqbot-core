import path from "node:path";
import { createTaskRunner } from "../tasks/runner.mjs";
import { CFG } from "../config.mjs";
import { buildOutputPacket } from "../output-pipeline.mjs";
import { loadSummaryCapture } from "../group-summary/journal.mjs";
import { dateLabel, resolvePreviousSummaryDate } from "../group-summary/date.mjs";
import { publicRevision, readReport, saveReportRevision } from "../group-summary/reports.mjs";
import { previewGroupSummary, sendGroupSummaryForDate } from "../group-summary/service.mjs";
import { readSummaryDelivery, resolveSummaryDelivery } from "../group-summary/publisher.mjs";
import { generateGroupSummaryResult } from "../group-summary/providers.mjs";
import { renderSummaryDocument } from "../group-summary/analysis.mjs";
import { redactSummaryText } from "../group-summary/formatter.mjs";
import { assertSummaryEpoch, readSummaryJson, summaryKey, summaryPrivacy, summaryRoot, withSummaryWriteLock, writeSummaryJson } from "../group-summary/state.mjs";

export function createSummaryManager(options = {}) {
  const jobFile = path.join(summaryRoot(options), "jobs.json");
  const groups = () => (options.whitelist || CFG.summaryGroupWhitelist).map(String);
  const tasks = createTaskRunner({
    read: () => readSummaryJson(jobFile, []), write: jobs => writeSummaryJson(jobFile, jobs),
    mutate: operation => withSummaryWriteLock(options, operation),
    keyFor: job => summaryKey(job.dateText, job.groupId), maxConcurrent: 2,
    busyMessage: "这个群和日期已有任务运行",
    failureMessage: "日报任务失败，请检查记录是否变化或模型是否可用",
    resultError: result => result.message || "日报任务失败",
    describeResult: result => ({ revisionId: result.revisionId || "", sent: Boolean(result.sent), reason: result.reason || "" }),
  });

  function scope(input = {}) {
    const groupId = String(input.groupId || groups()[0] || "");
    const dateText = input.dateText || resolvePreviousSummaryDate(new Date());
    summaryKey(dateText, groupId);
    if (!groups().includes(groupId)) throw new Error("该群未启用日报");
    return { dateText, groupId };
  }

  function snapshot(input = {}) {
    if (!groups().length) return { groups: [], revisions: [], jobs: [], coverage: null };
    const target = scope(input);
    const capture = loadSummaryCapture(target.dateText, target.groupId, options);
    const report = readReport(target.dateText, target.groupId, options);
    return {
      ...target, groups: groups(), coverage: capture.coverage,
      revisions: report.revisions.map(publicRevision),
      jobs: tasks.list().filter(job => job.groupId === target.groupId && job.dateText === target.dateText),
      delivery: readSummaryDelivery(target.dateText, target.groupId, options),
    };
  }

  function chosenRevision(input, target) {
    const report = readReport(target.dateText, target.groupId, options);
    const revision = report.revisions.find(item => item.id === input.revisionId);
    if (!revision) throw new Error("草稿不存在或已被清理，请刷新");
    return revision;
  }

  async function execute(input, target, progress) {
    const common = { ...options, ...target, groupWhitelist: groups(), onProgress: progress };
    if (input.action === "generate") return await (options.preview || previewGroupSummary)(common);
    const revision = chosenRevision(input, target);
    if (["confirm-delivered", "confirm-not-delivered"].includes(input.action)) return resolveSummaryDelivery(revisionResult(revision), input.action === "confirm-delivered", common);
    if (input.action === "regenerate-topic") return await regenerateTopic(revision, input, common);
    if (input.action === "send" || input.action === "resume") {
      const prepared = revisionResult(revision);
      return await (options.publish || sendGroupSummaryForDate)({ ...common, prepared, resume: input.action === "resume" });
    }
    throw new Error("不支持的日报任务");
  }

  function start(input) {
    const target = scope(input);
    return tasks.start({ scope: summaryKey(target.dateText, target.groupId), action: input.action, meta: target,
      run: ({ progress }) => execute(input, target, progress) });
  }

  async function act(input = {}) {
    if (["generate", "regenerate-topic", "send", "resume", "confirm-delivered", "confirm-not-delivered"].includes(input.action)) return start(input);
    if (input.action !== "save") throw new Error("不支持的日报操作");
    const target = scope(input);
    const previous = chosenRevision(input, target);
    if (typeof input.summary !== "string" || input.summary.length > 6000) throw new Error("正文请控制在 6000 字符以内");
    const output = buildOutputPacket({ content: redactSummaryText(input.summary) });
    if (!output.ok) throw new Error("正文为空或包含不能发布的内容");
    const revision = saveReportRevision({ ...previous, summary: output.text, document: null, privacyEpoch: summaryPrivacy(options).epoch }, {
      ...options, kind: "edited", expectedRevisionId: input.expectedRevisionId,
    });
    return { revisionId: revision.id, ...snapshot(target) };
  }

  return { snapshot, act, wait: tasks.wait };
}

function revisionResult(revision) {
  return { ...revision, ok: true, sent: false, revisionId: revision.id, messages: revision.bundle?.stats?.messageCount || 0 };
}

async function regenerateTopic(revision, input, options) {
  if (!revision.document?.topics.some(item => item.id === input.discussionId)) throw new Error("请先选择结构化草稿中的讨论");
  assertSummaryEpoch(revision.privacyEpoch, options);
  const generated = await generateGroupSummaryResult(revision.bundle.discussions.flatMap(item => item.messages), {
    ...options, structured: true, bundle: revision.bundle, onlyDiscussionId: input.discussionId,
    style: "technical", lowMessageLimit: 0, label: dateLabel(revision.dateText), coverage: revision.coverage,
  });
  const replacement = generated.document.topics.find(item => item.id === input.discussionId);
  if (!replacement) throw new Error("该讨论未生成可用结果");
  const document = { ...revision.document, headline: "", headlineEvidenceIds: [], topics: revision.document.topics.map(item => item.id === input.discussionId ? replacement : item) };
  const summary = renderSummaryDocument(document, revision.bundle, options);
  const result = { ...revision, document, summary, provider: generated.provider };
  const saved = saveReportRevision(result, { ...options, kind: "topic-regenerated", expectedRevisionId: input.expectedRevisionId });
  return { ok: true, revisionId: saved.id };
}

export const summaryManager = createSummaryManager();
