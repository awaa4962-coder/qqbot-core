import path from "node:path";
import { CFG } from "../config.mjs";
import { isAdminUser } from "../commands/permissions.mjs";
import { isSuccessfulOutbound } from "../cognition/outcome.mjs";
import { createTaskRunner, taskEventKey } from "../tasks/runner.mjs";
import { DEFAULT_SUMMARY_GROUP_ID } from "./constants.mjs";
import { resolveSummaryDate } from "./date.mjs";
import { listSummaryStyles, normalizeSummaryStyle } from "./styles.mjs";
import {
  previewGroupSummary,
  sendGroupSummaryForDate,
} from "./service.mjs";

const SUMMARY_COMMAND_RE = /^日报(?:帮助|预览|发送)?(?:\s|$)/;
const summaryCommandTasks = createTaskRunner({ filename: path.join(CFG.dataRoot, ".qqfriend", "tasks",
  process.env.NODE_ENV === "test" ? `summary-commands-${process.pid}.json` : "summary-commands.json"),
  maxConcurrent: 2, historyLimit: 256, busyMessage: "这个群的日报任务仍在运行，请稍后再试。" });

export function waitSummaryCommandTasks() { return summaryCommandTasks.wait(); }
export function listSummaryCommandTasks() { return summaryCommandTasks.list(); }

export function isGroupSummaryCommand(cmd) {
  return SUMMARY_COMMAND_RE.test(String(cmd || "").trim());
}

export function buildGroupSummaryHelpText() {
  return [
    "日报管理员命令",
    "",
    "  日报帮助",
    "  日报预览 [群号] [今天|昨天|YYYY-MM-DD] [casual|short|technical]",
    "  日报发送 [群号] [今天|昨天|YYYY-MM-DD] [casual|short|technical]",
    "",
    "示例：",
    "  @夜星 日报预览 昨天 short",
    "  @夜星 日报发送 <群号> 2026-06-26 technical",
    "",
    "风格：" + listSummaryStyles().map(style => style.id + "=" + style.label).join(" / "),
  ].join("\n");
}

export async function buildGroupSummaryCommandReply(cmd, options = {}) {
  const parsed = parseGroupSummaryCommand(cmd, options);
  if (!parsed.ok) return parsed.text;
  if (parsed.action === "help") return buildGroupSummaryHelpText();
  if (parsed.action === "preview" && options.groupId && Number(options.groupId) !== parsed.groupId) return "跨群日报预览请使用服务器控制台或管理员私聊。";

  const result = await runSummaryCommand(parsed, options);
  return formatSummaryCommandResult(parsed.action, result);
}

export async function queueGroupSummaryCommand(cmd, options = {}) {
  if (!isGroupSummaryCommand(cmd)) return false;
  const decision = summaryDispatchDecision(cmd, options);
  if (decision.immediate) { await notifySummary(options, decision.immediate); return true; }
  const parsed = decision.parsed;
  const eventKey = taskEventKey(options.surface === "private" ? "private" : "group",
    options.surface === "private" ? options.userId : options.groupId, options.messageId);
  try {
    if (summaryCommandTasks.hasEvent(eventKey)) {
      await notifySummary(options, "这条日报任务已经受理过，请先核实原任务结果，不会自动重做。"); return true;
    }
  } catch { await notifySummary(options, "日报任务没能启动，请到工作台检查状态。"); return true; }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    summaryCommandTasks.start({ scope: `${parsed.groupId}:${parsed.dateText}`, action: parsed.action, timeoutMs: 10 * 60 * 1000,
      meta: { targetGroupId: String(parsed.groupId), dateText: parsed.dateText, style: parsed.style, eventKey }, run: async ({ progress, signal }) => {
        await gate;
        return runQueuedSummary(parsed, { ...options, onProgress: progress, signal });
      } });
  } catch (error) {
    const busy = error.message === "这个群的日报任务仍在运行，请稍后再试。" || error.message === "后台任务已满，请稍后再试";
    await notifySummary(options, busy ? "这个群的日报任务仍在运行，请稍后再试。" : "日报任务没能启动，请到工作台检查状态。");
    return true;
  }
  try { await notifySummary(options, "日报任务已接收，完成后会回复结果。"); }
  finally { release(); }
  return true;
}

function summaryDispatchDecision(cmd, options) {
  if (!isAdminUser(options.userId, options.admins)) return { immediate: "这个命令需要管理员权限。" };
  const parsed = parseGroupSummaryCommand(cmd, options);
  if (!parsed.ok) return { immediate: parsed.text || buildGroupSummaryHelpText() };
  if (parsed.action === "help") return { immediate: buildGroupSummaryHelpText() };
  if (parsed.action === "preview" && options.groupId && Number(options.groupId) !== parsed.groupId) {
    return { immediate: "跨群日报预览请使用服务器控制台或管理员私聊。" };
  }
  return { parsed };
}

async function runQueuedSummary(parsed, options) {
  const stopReason = () => queuedSummaryStopReason(options);
  const assertCurrent = () => { const reason = stopReason(); if (reason) throw new Error(reason); };
  if (stopReason()) return { ok: false, reason: stopReason() };
  try {
    const result = await runSummaryCommand(parsed, { ...options,
      beforeCall: () => { assertCurrent(); options.beforeCall?.(); },
      beforeSave: () => { assertCurrent(); options.beforeSave?.(); },
      beforeSend: info => { assertCurrent(); return options.beforeSend?.(info); },
      beforeChunk: () => { assertCurrent(); options.beforeChunk?.(); },
    });
    if (stopReason()) return { ok: false, reason: stopReason() };
    const receipt = await notifySummary(options, formatSummaryCommandResult(parsed.action, result));
    return { ok: result.ok && isSuccessfulOutbound(receipt), reason: result.reason || result.error ||
      (isSuccessfulOutbound(receipt) ? "" : "notice_unconfirmed"), skipped: Boolean(result.skipped) };
  } catch {
    const reason = stopReason() || "task_failed";
    if (reason === "task_failed") await notifySummary(options, "日报任务未完成，请到日报工作台检查状态；不会自动重发。");
    return { ok: false, reason };
  }
}

function queuedSummaryStopReason(options) {
  if (options.signal?.aborted) return "task_timeout";
  return isAdminUser(options.userId, options.admins) ? "" : "permission_changed";
}

async function notifySummary(options, text) {
  try { return await options.sendReply(text); }
  catch { return null; }
}

async function runSummaryCommand(parsed, options) {
  const runner = parsed.action === "send" ? sendGroupSummaryForDate : previewGroupSummary;
  return runner({
    dateText: parsed.dateText,
    groupId: parsed.groupId,
    style: parsed.style,
    now: options.now,
    groupWhitelist: options.groupWhitelist,
    messages: options.summaryMessages,
    digest: options.summaryDigest,
    callPrimarySummary: options.callPrimarySummary,
    callFallbackSummary: options.callFallbackSummary,
    sendGroupMessage: options.sendGroupMessage,
    beforeCall: options.beforeCall,
    beforeSave: options.beforeSave,
    beforeSend: options.beforeSend,
    beforeChunk: options.beforeChunk,
    onProgress: options.onProgress,
    root: options.summaryRoot,
  });
}

export function parseGroupSummaryCommand(cmd, options = {}) {
  const tokens = String(cmd || "").trim().split(/\s+/).filter(Boolean);
  const head = tokens.shift() || "";
  if (!head.startsWith("日报")) return { ok: false, text: null };
  let action = head.replace(/^日报/, "") || "预览";
  if (action === "帮助") return { ok: true, action: "help" };
  if (action !== "预览" && action !== "发送") {
    return { ok: false, text: buildGroupSummaryHelpText() };
  }
  action = action === "发送" ? "send" : "preview";

  let groupId = defaultCommandGroup(options);
  let dateText = resolveSummaryDate(options.now);
  let style = "casual";

  for (const token of tokens) {
    if (/^\d{6,}$/.test(token)) {
      groupId = Number(token);
      continue;
    }
    const parsedDate = parseDateToken(token, options.now);
    if (parsedDate) {
      dateText = parsedDate;
      continue;
    }
    const parsedStyle = normalizeSummaryStyle(token);
    if (parsedStyle) {
      style = parsedStyle;
      continue;
    }
    return { ok: false, text: "无法识别日报参数：" + token + "\n\n" + buildGroupSummaryHelpText() };
  }

  return { ok: true, action, groupId, dateText, style };
}

function defaultCommandGroup(options) { return Number(options.defaultSummaryGroupId || options.groupId || DEFAULT_SUMMARY_GROUP_ID); }

function parseDateToken(token, now = new Date()) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  if (token === "今天") return resolveDateOffset(now, 0);
  if (token === "昨天") return resolveDateOffset(now, -1);
  return null;
}

function resolveDateOffset(now, offsetDays) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const base = Date.parse(values.year + "-" + values.month + "-" + values.day + "T00:00:00+08:00");
  return new Date(base + offsetDays * 24 * 60 * 60 * 1000)
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function formatSummaryCommandResult(action, result) {
  if (!result.ok) return result.message || "日报命令执行失败。";
  if (result.skipped) return "日报未重复发送：" + ({ already_sent: "该群这一天已发送", already_running: "已有任务运行", previous_attempt_unconfirmed: "上一轮发送待核实" }[result.reason] || result.reason);
  const title = action === "send" ? "日报已发送" : "日报预览完成";
  const lines = [
    title,
    "日期：" + result.dateText,
    "群：" + result.groupId,
    "风格：" + result.style,
    "生成：" + result.provider,
    "消息：" + result.messages,
  ];
  if (action === "preview") {
    lines.push("", "——", result.summary);
  }
  return lines.join("\n");
}
