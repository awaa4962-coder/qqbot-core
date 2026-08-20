import { CFG } from "../config.mjs";
import { resolveSummaryDate } from "./date.mjs";
import { createDailySummaryGuard } from "./guard.mjs";
import { loadSummaryMessages } from "./loader.mjs";
import { sendGroupSummaryForDate } from "./service.mjs";

export async function runDailySummaries(options = {}) {
  const dateText = options.dateText || resolveSummaryDate(options.now);
  const groupIds = normalizeGroupIds(options.groupIds || CFG.summaryGroupWhitelist);
  const createGuard = options.createGuard || createDailySummaryGuard;
  const loadMessages = options.loadMessages || loadSummaryMessages;
  const sendSummary = options.sendSummary || sendGroupSummaryForDate;
  const log = options.log || (() => {});
  const results = [];

  for (const groupId of groupIds) {
    results.push(await runDailySummaryForGroup({
      dateText,
      groupId,
      createGuard,
      loadMessages,
      sendSummary,
      log,
    }));
  }

  return {
    ok: results.every(result => result.ok !== false),
    dateText,
    groups: groupIds.length,
    sent: results.filter(result => result.sent).length,
    results,
  };
}

async function runDailySummaryForGroup(options) {
  const { dateText, groupId, createGuard, loadMessages, sendSummary, log } = options;
  const guard = createGuard({ dateText, groupId });
  if (!guard.ok) return skippedResult(guard.reason, options);

  try {
    const messages = loadMessages(dateText, groupId);
    if (!messages.length) return skippedResult("no_messages", options);
    log("start", { dateText, groupId, messages: messages.length });
    const result = await sendSummary({
      dateText,
      groupId,
      messages,
      beforeSend: payload => guard.markAttempt?.(payload),
    });
    markSentWhenSuccessful(guard, result);
    log(result.ok && result.sent ? "sent" : "failed", { dateText, groupId, result });
    return { groupId, ...result };
  } catch (error) {
    log("error", { dateText, groupId, error: error.message });
    return { groupId, ok: false, sent: false, error: error.message };
  } finally {
    guard.release();
  }
}

function skippedResult(reason, options) {
  options.log("skip", { dateText: options.dateText, groupId: options.groupId, reason });
  return { groupId: options.groupId, ok: true, sent: false, skipped: true, reason };
}

function markSentWhenSuccessful(guard, result) {
  if (!result.ok || !result.sent) {
    guard.markFailed?.();
    return;
  }
  guard.markSent({
    messages: result.messages,
    outputFile: result.outputFile,
    provider: result.provider,
    result: result.result,
  });
}

function normalizeGroupIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0))];
}
