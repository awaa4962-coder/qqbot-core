import { CFG } from "../config.mjs";
import { DEFAULT_SUMMARY_GROUP_ID, DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { loadSummaryCapture } from "./journal.mjs";
import { reportFile, saveReportRevision } from "./reports.mjs";
import { deliveryDirectory, publishSummary } from "./publisher.mjs";
import { summaryPrivacy } from "./state.mjs";
import { createDailySummaryGuard } from "./guard.mjs";
import { generateGroupSummaryResult } from "./providers.mjs";
import { getSummaryStyle } from "./styles.mjs";

export async function previewGroupSummary(options = {}) {
  return await buildSummaryServiceResult({ ...options, dryRun: true });
}

export async function sendGroupSummaryForDate(options = {}) {
  if (options.prepared) return await publishSummary(options.prepared, options);
  const dateText = options.dateText || formatDate();
  const groupId = Number(options.groupId || DEFAULT_SUMMARY_GROUP_ID);
  const guard = options.guard || createDailySummaryGuard({ dateText, groupId, rootDir: deliveryDirectory(options) });
  if (!guard.ok) return { ok: true, sent: false, skipped: true, reason: guard.reason, publicationManaged: true, dateText, groupId };
  try {
    const result = await buildSummaryServiceResult(options);
    if (!result.ok) return result;
    return await publishSummary(result, { ...options, guard });
  } finally { if (!options.guard) guard.release(); }
}

async function buildSummaryServiceResult(options) {
  const dateText = options.dateText || formatDate();
  const groupId = Number(options.groupId || DEFAULT_SUMMARY_GROUP_ID);
  const groupName = options.groupName || DEFAULT_SUMMARY_GROUP_NAME;
  const style = getSummaryStyle(options.style);
  if (options.requireWhitelisted !== false && !isAllowedSummaryGroup(groupId, options.groupWhitelist)) {
    return {
      ok: false,
      error: "group_not_allowed",
      message: "目标群不在白名单中：" + groupId,
      dateText,
      groupId,
      style: style.id,
    };
  }

  options.onProgress?.("collecting");
  const capture = options.capture || (options.messages ? {
    messages: options.messages, privacyEpoch: summaryPrivacy(options).epoch,
    coverage: { source: "provided", captured: options.messages.length, complete: false },
  } : loadSummaryCapture(dateText, groupId, options));
  const messages = capture.messages;
  if (!messages.length) {
    return {
      ok: false,
      error: "no_messages",
      message: "这一天没有可生成日报的群聊记录：" + dateText + " / " + groupId,
      dateText,
      groupId,
      style: style.id,
      messages: 0,
    };
  }

  const analysisOptions = buildAnalysisOptions(options);
  const digest = options.digest || buildSummaryDigest(messages, analysisOptions);
  const generated = await generateGroupSummaryResult(messages, {
    ...options,
    ...analysisOptions,
    dateText,
    groupName,
    label: dateLabel(dateText),
    style: style.id,
    digest,
    structured: options.structured !== false,
    coverage: capture.coverage,
  });
  const summary = generated.text;
  if (!summary) {
    return {
      ok: false,
      error: "generation_failed",
      message: "日报生成失败：" + dateText + " / " + groupId,
      dateText,
      groupId,
      style: style.id,
      messages: messages.length,
      provider: generated.provider,
      digest,
    };
  }

  const result = {
    ok: true,
    sent: false,
    dateText,
    groupId,
    groupName,
    style: style.id,
    styleLabel: style.label,
    provider: generated.provider,
    messages: messages.length,
    outputFile: reportFile(dateText, groupId, options),
    digest,
    summary,
    document: generated.document || null, bundle: generated.bundle || null,
    privacyEpoch: capture.privacyEpoch, coverage: capture.coverage,
  };
  options.onProgress?.("saving");
  const revision = saveReportRevision(result, options);
  result.revisionId = revision.id;
  return result;
}

function isAllowedSummaryGroup(groupId, whitelist = CFG.summaryGroupWhitelist) {
  return (whitelist || []).map(Number).includes(Number(groupId));
}

function buildAnalysisOptions(options) {
  return {
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  };
}
