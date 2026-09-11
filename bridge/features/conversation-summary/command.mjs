import { CFG } from "../../config.mjs";
import { prepareCommandText } from "../../commands/normalize.mjs";
import { dateRange, formatDate } from "../../group-summary/date.mjs";

const DAY = 86400000;
const PREFIX = /^(总结我|分别总结|总结)(?=\s|$|\[CQ:at,|@)/;

export function isConversationSummaryCommand(text) {
  return text === "总结帮助" || PREFIX.test(String(text || ""));
}

export function parseConversationSummaryCommand(text, options = {}) {
  const value = prepareCommandText(text, { ...options, requireMention: options.requireMention ?? true }).replace(/[。！？!?]+$/, "").trim();
  if (value === "总结帮助") return { help: true };
  const match = value.match(PREFIX);
  if (!match) return null;
  const tail = value.slice(match[0].length).replace(/\[CQ:at,qq=[^\]]+\]/g, " ").trim();
  return { self: match[1] === "总结我", separate: match[1] === "分别总结", rangeText: tail || "最近2小时" };
}

export function resolveSummaryTargets(ctx, parsed, options = {}) {
  const selfUin = String(options.selfUin ?? CFG.selfUin);
  const mentions = Array.isArray(ctx.mentions) ? ctx.mentions : [];
  if (mentions.some(item => item.isAll || item.qq === "all")) throw new Error("请 @具体的人，暂不支持总结全体成员。");
  const people = new Map();
  for (const item of mentions) {
    const target = mentionTarget(item, selfUin);
    if (target) people.set(target.uid, target);
  }
  if (parsed.self) {
    if (people.size) throw new Error("总结我不用再 @别人；多人一起总结请用“总结 @某人 @某人”。");
    return [{ uid: String(ctx.user_id), name: ctx.nickname || "" }];
  }
  if (!people.size) throw new Error("想总结谁？请用 QQ 的 @选中成员，或者发“总结我”。");
  if (people.size > 5) throw new Error("一次最多总结五个人，请少选几位。");
  return [...people.values()];
}

function mentionTarget(item, selfUin) {
  const uid = String(item.qq || "");
  if (item.isBot || uid === selfUin || !/^\d{5,20}$/.test(uid)) return null;
  return { uid, name: item.displayName || item.groupCard || item.nickname || "" };
}

export function resolveSummaryRange(text, now = Date.now()) {
  const to = Number(now);
  if (!Number.isFinite(to)) throw new Error("无法确定当前时间。");
  const today = dateRange(formatDate(new Date(to))).start;
  const oldest = today - 6 * DAY;
  const value = String(text).replace(/\s+/g, "");
  if (value === "今天" || value === "今日") return { from: today, to };
  if (value === "昨天" || value === "昨日") return { from: today - DAY, to: today - 1 };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return explicitDateRange(value, oldest, to);
  }
  const match = value.match(/^(?:最近|近)(\d{1,5})(分钟|小时|天)$/);
  if (!match || Number(match[1]) < 1) throw new Error("时间可以写“今天”“昨天”“最近2小时”“最近30分钟”或“最近7天”。");
  const count = Number(match[1]);
  const duration = match[2] === "分钟" ? count * 60000 : count * 3600000;
  const from = match[2] === "天" ? today - (count - 1) * DAY : to - duration;
  if (from < oldest || from > to) throw new Error("最多查看今天及前六天内已采集的记录，请缩短时间范围。");
  return { from, to };
}

function explicitDateRange(value, oldest, to) {
  const range = dateRange(value);
  if (formatDate(new Date(range.start)) !== value || range.start < oldest || range.start > to) throw new Error("日期请选今天及前六天内的有效日期。");
  return { from: range.start, to: Math.min(range.end, to) };
}

export function conversationSummaryHelp() {
  const bot = "@" + (CFG.botNames[0] || "机器人");
  return [
    "想知道谁刚才聊了什么，可以这样问：",
    bot + " 总结我",
    bot + " 总结 @某人 昨天",
    bot + " 总结 @甲 @乙 最近2小时",
    bot + " 分别总结 @甲 @乙 今天",
    "不写时间就看最近两小时，一次最多五个人。只总结本群已收到的文字，不查私聊，也不做人物画像。",
  ].join("\n");
}
