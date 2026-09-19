import { CFG } from "../config.mjs";
import { DEFAULT_SUMMARY_GROUP_ID, DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { loadSummaryCapture } from "./journal.mjs";
import { reportFile, saveReportRevision } from "./reports.mjs";
import { deliveryDirectory, publishSummary } from "./publisher.mjs";
import { assertSummaryEpoch, summaryPrivacy } from "./state.mjs";
import { createDailySummaryGuard, summarySkipResult } from "./guard.mjs";
import { generateGroupSummaryResult } from "./providers.mjs";
import { getSummaryStyle } from "./styles.mjs";

export async function previewGroupSummary(options = {}) {
  return await buildSummaryServiceResult({ ...options, dryRun: true });
}

export async function sendGroupSummaryForDate(options = {}) {
  if (options.dryRun === true) {
    if (!options.prepared) return await buildSummaryServiceResult(options, false);
    if (!isAllowedSummaryGroup(options.prepared.groupId, options.groupWhitelist)) throw new Error("该群未启用日报");
    assertSummaryEpoch(options.prepared.privacyEpoch, options);
    return { ...options.prepared, ok: true, sent: false, dryRun: true, publicationManaged: false };
  }
  if (options.prepared) return await publishSummary(options.prepared, options);
  const dateText = options.dateText || formatDate();
  const groupId = Number(options.groupId || DEFAULT_SUMMARY_GROUP_ID);
  const guard = options.guard || createDailySummaryGuard({ dateText, groupId, rootDir: deliveryDirectory(options) });
  if (!guard.ok) return summarySkipResult(guard.reason, { publicationManaged: true, dateText, groupId });
  try {
    const result = await buildSummaryServiceResult(options);
    if (!result.ok) return result;
    return await publishSummary(result, { ...options, guard });
  } finally { if (!options.guard) guard.release(); }
}

async function buildSummaryServiceResult(options, persist = true) {
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
  const capture = collectSummaryCapture(dateText, groupId, options);
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
  const generated = await generateGroupSummaryResult(messages, {
    ...options,
    ...analysisOptions,
    dateText,
    groupName,
    label: dateLabel(dateText),
    style: style.id,
    includeDigest: options.includeDigest ?? false,
    structured: options.structured !== false,
    privacyEpoch: capture.privacyEpoch,
    coverage: capture.coverage,
  });
  const summary = generated.text;
  if (!summary) {
    return {
      ok: false,
      error: "generation_failed",
      reason: generated.reason,
      message: "模型未生成通过证据校验的日报正文，本次未发送占位提要。请稍后在日报工作台重试：" + dateText + " / " + groupId,
      dateText,
      groupId,
      style: style.id,
      messages: messages.length,
      provider: generated.provider,
      digest: generated.digest,
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
    digest: generated.digest,
    summary,
    document: generated.document || null, bundle: generated.bundle || null,
    privacyEpoch: capture.privacyEpoch, coverage: capture.coverage,
  };
  if (!persist) {
    assertSummaryEpoch(capture.privacyEpoch, options);
    return { ...result, outputFile: undefined, dryRun: true };
  }
  options.onProgress?.("saving");
  const revision = saveReportRevision(result, options);
  result.revisionId = revision.id;
  return result;
}

function collectSummaryCapture(dateText, groupId, options) {
  if (options.capture) return options.capture;
  if (!options.messages) return loadSummaryCapture(dateText, groupId, options);
  return {
    messages: options.messages, privacyEpoch: summaryPrivacy(options).epoch,
    coverage: { source: "provided", captured: options.messages.length, complete: false },
  };
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
