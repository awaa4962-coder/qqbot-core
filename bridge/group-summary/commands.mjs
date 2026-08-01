import { DEFAULT_SUMMARY_GROUP_ID } from "./constants.mjs";
import { resolveSummaryDate } from "./date.mjs";
import { listSummaryStyles, normalizeSummaryStyle } from "./styles.mjs";
import {
  previewGroupSummary,
  sendGroupSummaryForDate,
} from "./service.mjs";

const SUMMARY_COMMAND_RE = /^日报(?:帮助|预览|发送)?(?:\s|$)/;

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

  const runner = parsed.action === "send" ? sendGroupSummaryForDate : previewGroupSummary;
  const result = await runner({
    dateText: parsed.dateText,
    groupId: parsed.groupId,
    style: parsed.style,
    now: options.now,
    groupWhitelist: options.groupWhitelist,
    messages: options.summaryMessages,
    digest: options.summaryDigest,
    callMiMoSummary: options.callMiMoSummary,
    callDeepSeekSummary: options.callDeepSeekSummary,
    sendGroupMessage: options.sendGroupMessage,
  });

  return formatSummaryCommandResult(parsed.action, result);
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

  let groupId = Number(options.defaultSummaryGroupId || DEFAULT_SUMMARY_GROUP_ID);
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
  const title = action === "send" ? "日报已发送" : "日报预览完成";
  const lines = [
    title,
    "日期：" + result.dateText,
    "群：" + result.groupId,
    "风格：" + result.style,
    "生成：" + result.provider,
    "消息：" + result.messages,
  ];
  if (result.outputFile) lines.push("文件：" + result.outputFile);
  if (action === "preview") {
    lines.push("", "——", result.summary);
  }
  return lines.join("\n");
}
