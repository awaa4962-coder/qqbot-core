import { CFG } from "../config.mjs";
import { resolveSummaryDate } from "./date.mjs";
import { createDailySummaryGuard, summarySkipResult } from "./guard.mjs";
import { loadSummaryCapture } from "./journal.mjs";
import { sendGroupSummaryForDate } from "./service.mjs";

export async function runDailySummaries(options = {}) {
  const dateText = options.dateText || resolveSummaryDate(options.now);
  const groupIds = normalizeGroupIds(options.groupIds || CFG.summaryGroupWhitelist);
  const createGuard = options.createGuard || createDailySummaryGuard;
  const loadMessages = options.loadMessages || loadSummaryCapture;
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
    ok: results.every(result => result.ok !== false && !result.pending),
    pending: results.some(result => result.pending),
    dateText,
    groups: groupIds.length,
    sent: results.filter(result => result.sent).length,
    results,
  };
}

async function runDailySummaryForGroup(options) {
  const { dateText, groupId, createGuard } = options;
  let guard;
  try {
    guard = createGuard({ dateText, groupId });
    if (!guard.ok) return skippedResult(guard.reason, options);
  } catch (error) {
    return groupError(options, "claim", error);
  }

  let result;
  try {
    result = await sendDailySummaryForGroup(guard, options);
  } catch (error) {
    result = groupError(options, "send", error);
  }
  try {
    guard.release();
  } catch (error) {
    const failed = groupError(options, "release", error);
    return { ...result, ok: false, pending: true, error: result.error || failed.error, releaseError: failed.error };
  }
  return result;
}

async function sendDailySummaryForGroup(guard, options) {
  const { dateText, groupId, loadMessages, sendSummary, log } = options;
  const loaded = loadMessages(dateText, groupId);
  const capture = Array.isArray(loaded) ? null : loaded;
  const messages = capture ? capture.messages : loaded;
  if (!messages.length) return skippedResult("no_messages", options);
  log("start", { dateText, groupId, messages: messages.length });
  const result = await sendSummary({ dateText, groupId, messages, capture, guard });
  markSentWhenSuccessful(guard, result);
  log(result.ok && result.sent ? "sent" : "failed", { dateText, groupId, result: { ok: result.ok, sent: result.sent, provider: result.provider, error: result.error, reason: result.reason, revisionId: result.revisionId } });
  return { groupId, ...result };
}

function groupError({ dateText, groupId, log }, stage, error) {
  const message = error?.message || String(error);
  try { log("error", { dateText, groupId, stage, error: message }); } catch {}
  return { groupId, ok: false, sent: false, error: message };
}

function skippedResult(reason, options) {
  options.log("skip", { dateText: options.dateText, groupId: options.groupId, reason });
  return summarySkipResult(reason, { groupId: options.groupId });
}

function markSentWhenSuccessful(guard, result) {
  if (result.publicationManaged || !result.ok || !result.sent) return;
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
