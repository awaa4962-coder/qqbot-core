import path from "node:path";
import { CFG } from "../config.mjs";
import { messageRouteRejection } from "../event-admission.mjs";
import { sendGroupSummaryForDate } from "../group-summary/service.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { dateRange, formatDate } from "../group-summary/date.mjs";
import { redactSummaryText } from "../group-summary/formatter.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { resolveSummaryRange } from "../features/conversation-summary/command.mjs";
import { selectSummaryRecords } from "../features/conversation-summary/records.mjs";
import { generateConversationSummary, summaryFooter } from "../features/conversation-summary/prompt.mjs";

const DAY = 86400000;
const QQ_ID = /^[1-9]\d{4,19}$/;
const FAILURE = new Set(["invalid_arguments", "not_allowed", "target_not_allowed", "invalid_date", "guard_unavailable",
  "model_callback_required", "cancelled", "permission_changed", "privacy_changed", "stale_request", "budget_exceeded",
  "no_records", "model_unavailable", "unsafe_service_result", "business_unavailable"]);
const DEFAULT_BUSINESS = { sendGroupSummaryForDate, summaryPrivacy, resolveSummaryRange, selectSummaryRecords,
  generateConversationSummary, summaryFooter };

// The parent owns registry admission, TaskRunner, and one transport budget for ALL nested calls.
export function createBusinessDraftAdapter(options = {}) {
  const scope = Object.freeze({ ...options.scope });
  const cfg = options.cfg || CFG;
  const business = Object.fromEntries(Object.entries(DEFAULT_BUSINESS).map(([key, implementation]) =>
    [key, process.env.NODE_ENV === "test" && typeof options[key] === "function" ? options[key] : implementation]));
  const binding = { userMessage: options.userMessage, messageId: options.messageId,
    dataRoot: cfg.dataRoot, chatLogFile: cfg.chatLogFile,
    signal: options.signal, assertCurrent: options.assertCurrent, callModel: options.callModel,
    targetAuthority: targetAuthority(scope.userId, options.mentionTargets, cfg.selfUin) };

  async function generate(args) {
    try {
      if (!validArguments(args)) return failed("invalid_arguments");
      args = Object.freeze({ ...args });
    } catch { return failed("invalid_arguments"); }
    if (typeof options.callModel !== "function") return failed("model_callback_required");
    if (typeof options.assertCurrent !== "function" || !options.signal) return failed("guard_unavailable");
    if (!allowedScope(scope, cfg, options)) return failed("not_allowed");
    const targets = parseTargets(args, scope.userId);
    if (!targets) return failed("invalid_arguments");
    const activity = createModelActivity();
    let guard;
    let result;
    try {
      guard = createGuard({ options, scope, cfg, binding, business, kind: args.kind, targets });
      guard.check();
      const now = Number(typeof options.now === "function" ? options.now() : options.now ?? Date.now());
      const range = draftRange(args, now, business);
      guard.startPrivacy();
      const common = { ...guard.readOptions, signal: options.signal, assertCurrent: guard.check,
        beforeCall: guard.check, onProgress: guard.progress, selfUin: cfg.selfUin, botNames: cfg.botNames,
        evidenceBudgetChars: 8192, targetBudget: 6500, backgroundBudget: 1500 };
      const invoke = createModelCallback(options, guard, activity, args.kind === "daily" ? "group_summary" : "conversation_summary");
      result = args.kind === "daily"
        ? await dailyDraft(args, range, scope, business, common, invoke, guard)
        : await conversationDraft(args, range, targets, scope, binding, business, common, invoke, guard);
      guard.check();
    } catch (error) {
      result = generationFailure(guard, error);
    }
    await activity.closeAndDrain();
    try { guard?.check(); }
    catch (error) { result = generationFailure(guard, error); }
    return result;
  }

  return { generate };
}

function createGuard({ options, scope, cfg, binding, business, kind, targets }) {
  const readOptions = { root: path.join(cfg.dataRoot || CFG.dataRoot, ".qqfriend", "summaries"),
    chatLogFile: cfg.chatLogFile || CFG.chatLogFile };
  let invalid = "";
  let epoch;
  const stop = reason => { invalid ||= reason; throw stopped(invalid); };
  function check() {
    if (invalid) throw stopped(invalid);
    if (options.signal.aborted) stop("cancelled");
    try { if (options.assertCurrent() === false) stop("stale_request"); }
    catch (error) { stop(safeReason(error, "stale_request")); }
    if (!sameBinding(options, scope, binding, cfg)) stop("stale_request");
    if (!allowedScope(scope, cfg, options) || !whitelisted(cfg[whitelistKey(kind)], scope.groupId)) stop("permission_changed");
    if (!authorizedTargets(targets, binding.targetAuthority, targetAuthority(scope.userId, options.mentionTargets, cfg.selfUin))) stop("target_not_allowed");
    if (epoch !== undefined && business.summaryPrivacy(readOptions).epoch !== epoch) stop("privacy_changed");
  }
  function startPrivacy() {
    check();
    epoch = business.summaryPrivacy(readOptions).epoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0) stop("business_unavailable");
    check();
  }
  function progress(stage) {
    check();
    if (["collecting", "analyzing", "fallback"].includes(stage)) options.onProgress?.(stage);
    check();
  }
  return { check, startPrivacy, progress, readOptions, stop, reason: () => invalid,
    verifyEpoch: value => { check(); if (value !== epoch) stop("privacy_changed"); } };
}

function createModelActivity() {
  let open = true;
  const pending = new Set();
  function assertOpen() { if (!open) throw stopped("stale_request"); }
  function run(operation) {
    assertOpen();
    const task = Promise.resolve().then(() => { assertOpen(); return operation(); });
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  async function closeAndDrain() {
    open = false;
    // Track the actual parent promise, not the signal race. The parent retains transport ownership.
    while (pending.size) await Promise.allSettled([...pending]);
  }
  return { assertOpen, run, closeAndDrain };
}

function modelHook(guard, activity, operation) {
  try { guard.check(); activity.assertOpen(); const value = operation(); guard.check(); return value; }
  catch (error) { return guard.stop(safeReason(error)); }
}

function createModelCallback(options, guard, activity, expectedTask) {
  return async (task, position, request, providerOptions) => {
    guard.check();
    activity.assertOpen();
    if (task !== expectedTask || !["primary", "fallback"].includes(position) ||
        !request || !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1) {
      guard.stop("unsafe_service_result");
    }
    const signal = AbortSignal.any([options.signal, request.signal].filter(Boolean));
    // Keep the business budget hooks; the parent must compose them with its shared HTTP reservation.
    const prepared = { ...request, signal, maxTokens: Math.min(1536, request.maxTokens),
      options: { ...request.options, allowTools: false },
      beforeAttempt: () => modelHook(guard, activity, () => {
        const reason = request.beforeAttempt?.();
        if (reason) guard.stop(safeReason({ message: reason }, "budget_exceeded"));
        return "";
      }),
      validatePrepared: value => modelHook(guard, activity, () => request.validatePrepared?.(value)) };
    let result;
    try { result = await abortable(() => activity.run(() => {
      guard.check();
      return options.callModel(task, position, prepared, providerOptions);
    }), signal); }
    catch (error) {
      guard.check();
      const reason = safeReason(error, "model_unavailable");
      if (reason !== "model_unavailable" && reason !== "business_unavailable") guard.stop(reason);
      // Existing daily services log caught errors; never hand them raw transport errors or credentials.
      throw stopped("model_unavailable");
    }
    guard.check();
    if (result?.ok === false) {
      const reason = safeReason({ message: result.reason || result.error }, "model_unavailable");
      if (reason !== "model_unavailable" && reason !== "business_unavailable") guard.stop(reason);
      return { ok: false, raw: null, provider: publicProvider(result.provider), error: "model_unavailable" };
    }
    return result;
  };
}

async function dailyDraft(args, range, scope, business, common, invoke, guard) {
  const result = await abortable(() => business.sendGroupSummaryForDate({ ...common,
    groupId: scope.groupId, dateText: range.day, groupWhitelist: [String(scope.groupId)],
    requireWhitelisted: true, dryRun: true,
    callPrimarySummary: (_prompt, request) => invoke("group_summary", "primary", request, { reasoningMode: undefined }),
    callFallbackSummary: (_prompt, request) => invoke("group_summary", "fallback", request, { reasoningMode: "economy" }),
  }), common.signal);
  guard.check();
  if (!result?.ok) return failed(result?.error === "no_messages" ? "no_records" : "model_unavailable");
  if (!safeDailyResult(result, scope, range)) guard.stop("unsafe_service_result");
  guard.verifyEpoch(result.privacyEpoch);
  const coverage = dailyCoverage(result, range);
  return success(result.summary, args.kind, coverage, result.provider);
}

async function conversationDraft(args, range, targets, scope, binding, business, common, invoke, guard) {
  guard.progress("collecting");
  const bundle = await abortable(() => business.selectSummaryRecords(String(scope.groupId), targets.map(uid => ({ uid })),
    { from: range.from, to: range.to }, { ...common, excludeMessageId: binding.messageId }), common.signal);
  guard.check();
  guard.verifyEpoch(bundle?.privacyEpoch);
  if (!validBundle(bundle, scope, range, targets)) guard.stop("unsafe_service_result");
  if (!bundle.selected) return failed("no_records");
  const result = await abortable(() => business.generateConversationSummary(bundle, { ...common,
    separate: args.separate === true, userId: scope.userId, callProvider: invoke }), common.signal);
  guard.check();
  if (!result?.ok) return failed(safeReason({ message: result?.reason }, "model_unavailable"));
  if (typeof result.text !== "string" || !result.text.trim() || result.sent === true || result.persisted === true) guard.stop("unsafe_service_result");
  const coverage = { ...rangeCoverage(range), source: "group_capture_and_retained", complete: false,
    selected: count(bundle.selected), background: count(bundle.background), targetCount: targets.length,
    missingTargets: bundle.targets.filter(item => item.count === 0).length,
    sampled: bundle.sampled === true, truncated: bundle.truncated === true, partial: true };
  const text = result.text + "\n\n" + business.summaryFooter({ ...bundle, partial: true });
  guard.check();
  return success(text, args.kind, coverage, result.provider, result.position);
}

function validArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
  const keys = Reflect.ownKeys(args);
  if (keys.some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key), "value"))) return false;
  if (!["daily", "conversation"].includes(args.kind)) return false;
  const permitted = args.kind === "daily" ? ["kind", "day"] : ["kind", "day", "targets", "separate"];
  if (keys.some(key => !permitted.includes(key))) return false;
  return validArgumentValues(args);
}

function validArgumentValues(args) {
  if (Object.hasOwn(args, "day") && (typeof args.day !== "string" || !/^(today|yesterday|\d{4}-\d{2}-\d{2})$/.test(args.day))) return false;
  if (Object.hasOwn(args, "separate") && typeof args.separate !== "boolean") return false;
  return !Object.hasOwn(args, "targets") || (typeof args.targets === "string" && args.targets.length <= 100);
}

function parseTargets(args, requester) {
  if (!Object.hasOwn(args, "targets")) return [String(requester)];
  const targets = args.targets.trim().split(/[\s,]+/);
  if (!targets.length || targets.length > 4 || targets.some(uid => !QQ_ID.test(uid)) || new Set(targets).size !== targets.length) return null;
  return targets;
}

function targetAuthority(requester, mentions, selfUin) {
  const allowed = new Set([String(requester)]);
  for (const item of Array.isArray(mentions) ? mentions : []) {
    const uid = typeof item === "string" ? item : String(item?.uid ?? item?.qq ?? "");
    if (QQ_ID.test(uid) && !item?.isAll && !item?.isBot && uid !== String(selfUin)) allowed.add(uid);
  }
  allowed.delete(String(selfUin));
  return allowed;
}

function authorizedTargets(targets, initial, current) { return targets.every(uid => initial.has(uid) && current.has(uid)); }

function draftRange(args, now, business) {
  try {
    if (!Number.isFinite(now)) throw stopped("invalid_date");
    const input = args.day || (args.kind === "daily" ? "today" : "recent");
    const range = business.resolveSummaryRange(({ today: "今天", yesterday: "昨天", recent: "最近2小时" })[input] || input, now);
    const today = dateRange(formatDate(new Date(now))).start;
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from < today - 6 * DAY ||
        range.to > now || range.from > range.to) throw stopped("invalid_date");
    const day = formatDate(new Date(range.from));
    // The daily service selects a calendar date, not a rolling endpoint. Today is explicitly partial.
    return args.kind === "daily" ? { from: dateRange(day).start, to: dateRange(day).end, day } : { ...range, day };
  } catch { throw stopped("invalid_date"); }
}

function allowedScope(scope, cfg, options) {
  return scope.surface === "group" && QQ_ID.test(String(scope.userId)) && QQ_ID.test(String(scope.groupId)) &&
    Number.isSafeInteger(Number(scope.groupId)) && (options.task === undefined || options.task === "group_chat") &&
    (scope.task === undefined || scope.task === "group_chat") &&
    options.mentioned !== false && typeof options.userMessage === "string" && Boolean(options.userMessage.trim()) &&
    Boolean(options.messageId) && whitelisted(cfg.agentGroupWhitelist, scope.groupId) &&
    !messageRouteRejection({ message_type: "group", group_id: scope.groupId, user_id: scope.userId }, cfg);
}

function sameBinding(options, scope, binding, cfg) {
  const current = options.scope;
  return current?.surface === scope.surface && String(current.userId) === String(scope.userId) &&
    String(current.groupId) === String(scope.groupId) && options.userMessage === binding.userMessage &&
    options.messageId === binding.messageId && cfg.dataRoot === binding.dataRoot && cfg.chatLogFile === binding.chatLogFile &&
    options.signal === binding.signal && options.assertCurrent === binding.assertCurrent && options.callModel === binding.callModel &&
    (current.currentMessageId === undefined || String(current.currentMessageId) === String(binding.messageId));
}

function validBundle(bundle, scope, range, targets) {
  return bundle && String(bundle.groupId) === String(scope.groupId) && bundle.range?.from === range.from && bundle.range?.to === range.to &&
    Array.isArray(bundle.targets) && bundle.targets.length === targets.length &&
    bundle.targets.every((item, index) => item.uid === targets[index] && Number.isSafeInteger(item.count) && item.count >= 0) &&
    Number.isSafeInteger(bundle.selected) && bundle.selected >= 0 && Array.isArray(bundle.transcript) &&
    bundle.transcript.every(item => item.surface !== "private" && item.message_type !== "private" &&
      [item.groupId, item.group_id, item.group].every(id => id === undefined || String(id) === String(scope.groupId)));
}

function dailyCoverage(result, range) {
  const capture = result.coverage || {};
  const selection = result.bundle?.selection || {};
  return { ...rangeCoverage(range), source: ["journal-and-retained", "retained-only", "provided"].includes(capture.source) ? capture.source : "group_capture",
    captured: count(capture.captured ?? result.messages), complete: false, partial: true,
    malformed: count(capture.malformed), capped: capture.capped === true,
    truncated: count(capture.truncated) > 0 || count(selection.truncated) > 0,
    capturedTruncated: count(capture.truncated), evidenceTruncated: count(selection.truncated),
    evidenceSelected: count(selection.included), evidenceAvailable: count(selection.total),
    sampled: selection.sampled === true };
}

function safeDailyResult(result, scope, range) {
  return result.sent === false && result.dryRun === true && result.persisted !== true &&
    !Object.hasOwn(result, "revisionId") && !result.outputFile &&
    (result.groupId === undefined || String(result.groupId) === String(scope.groupId)) &&
    (result.dateText === undefined || result.dateText === range.day);
}

function rangeCoverage(range) { return { scope: "current_group", from: range.from, to: range.to, timeZone: "Asia/Shanghai" }; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function whitelistKey(kind) { return kind === "daily" ? "summaryGroupWhitelist" : "conversationSummaryGroupWhitelist"; }
function whitelisted(list, group) { return Array.isArray(list) && list.some(id => String(id) === String(group)); }
function stopped(reason) { return Object.assign(new Error(reason), { code: "BUSINESS_DRAFT_STOPPED" }); }
function failed(reason) { return { ok: false, reason: FAILURE.has(reason) ? reason : "business_unavailable", sent: false, persisted: false }; }
function generationFailure(guard, error) { return failed(guard?.reason() || safeReason(error)); }

function safeReason(error, fallback = "business_unavailable") {
  const reason = String(error?.reason || error?.message || "");
  if (FAILURE.has(reason)) return reason;
  if (/^(tool_|task_)(budget|deadline|input_budget|output_budget|context_budget)$/.test(reason)) return "budget_exceeded";
  if (["privacy_changed", "memory_expired", "preferences_changed"].includes(reason)) return "privacy_changed";
  if (["reply_superseded", "reply_expired", "recipient_mismatch", "tool_configuration_changed"].includes(reason)) return "stale_request";
  if (reason === "task_cancelled" || error?.name === "AbortError") return "cancelled";
  return fallback;
}

function success(text, kind, coverage, provider, position) {
  if (typeof text !== "string" || !text.trim()) return failed("model_unavailable");
  const normalized = text.normalize("NFKC").replace(/\p{Cf}/gu, "")
    .replace(/\b(?:proxy-)?authorization["']?\s*[:=]\s*[^\r\n,;，；]+/gi, "[authorization hidden]")
    .replace(/\bBasic\s+[A-Za-z0-9+/_-]{4,}={0,2}/gi, "Basic [credentials hidden]");
  const safeText = redactSummaryText(redactSensitiveText(normalized)).replace(/\b[1-9]\d{4,19}\b/g, "[ID hidden]")
    .replace(/\b[A-Za-z]:[\\/][^\s]+|(?:^|\s)\/(?:[^\s/]+\/)+[^\s]*/g, " [path hidden]");
  return { ok: true, text: safeText, kind, coverage,
    provider: publicProvider(provider),
    ...(["primary", "fallback"].includes(position) ? { position } : {}), sent: false, persisted: false };
}

function publicProvider(provider) {
  return typeof provider === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(provider) &&
    redactSummaryText(provider) === provider && !QQ_ID.test(provider) ? provider : "unknown";
}

async function abortable(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(stopped("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
