import { CFG } from "../config.mjs";
import { isSuccessfulOutbound } from "../cognition/outcome.mjs";
import { sendMsg } from "../napcat.mjs";
import { DEFAULT_SUMMARY_GROUP_ID, DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { loadSummaryMessages } from "./loader.mjs";
import { writeManualSummary } from "./output.mjs";
import { generateGroupSummaryResult } from "./providers.mjs";
import { getSummaryStyle } from "./styles.mjs";

export async function previewGroupSummary(options = {}) {
  return await buildSummaryServiceResult({ ...options, dryRun: true });
}

export async function sendGroupSummaryForDate(options = {}) {
  return await buildSummaryServiceResult({ ...options, dryRun: false });
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

  const messages = options.messages || loadSummaryMessages(dateText, groupId);
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

  const outputFile = writeManualSummary(dateText, summary, { groupId });
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
    outputFile,
    digest,
    summary,
  };
  if (options.dryRun) return result;

  const sender = options.sendGroupMessage || sendMsg;
  result.result = await sender(groupId, summary);
  result.sent = isSuccessfulOutbound(result.result);
  if (!result.sent) {
    result.ok = false;
    result.error = "send_failed";
    result.message = "日报已经生成，但发送失败，未写入已发送标记，可以稍后重试。";
  }
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
