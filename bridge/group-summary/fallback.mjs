import { DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";
import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { buildSummaryStats } from "./stats.mjs";
import { getSummaryStyle } from "./styles.mjs";

export function buildLocalSummaryFallback(messages, options = {}) {
  const groupName = options.groupName || DEFAULT_SUMMARY_GROUP_NAME;
  const label = options.label || dateLabel(options.dateText || formatDate());
  const stats = buildSummaryStats(messages || []);
  const digest = options.digest || buildSummaryDigest(messages || []);
  const style = getSummaryStyle(options.style);
  const topics = digest.topicHints?.length
    ? digest.topicHints.map(item => item.name).slice(0, 3).join("、")
    : "零散闲聊";
  const quote = digest.quoteCandidates?.[0]
    ? "今日有句挺显眼：" + digest.quoteCandidates[0].nickname + " 说「" + digest.quoteCandidates[0].text + "」。"
    : "今天没有特别适合引用的原话，但群里的动静我都记下啦。";
  const media = buildMediaLine(digest);

  if (shouldUseCompactFallback(style, stats)) {
    return buildCompactFallback({ label, groupName, stats, topics, quote, media, style });
  }

  const topicLine = style.id === "technical" ? "技术/资源相关动向主要是：" : "热聊方向主要是：";
  return [
    "🌟【" + label + " 群聊小报】喵～",
    "",
    "今天「" + groupName + "」一共 " + stats.messageCount + " 条消息，" + stats.speakerCount + " 位群友发言。",
    topicLine + topics + "。",
    "活跃之星：" + stats.top3 + "。",
    quote,
    media,
    "今天的小报先送到这里，夜星继续蹲在群里听大家聊天喵～",
  ].filter(Boolean).join("\n");
}

function shouldUseCompactFallback(style, stats) {
  return style.id === "short" || stats.messageCount < 8;
}

function buildCompactFallback({ label, groupName, stats, topics, quote, media, style }) {
  const ending = style.id === "short"
    ? "简短小报送到，夜星继续观察群里动静喵～"
    : "小报先轻轻记一笔，等群里热闹起来我再写长一点喵～";
  return [
    "🌟【" + label + " 群聊小报】喵～",
    "",
    "今天「" + groupName + "」比较安静，一共 " + stats.messageCount + " 条消息，" + stats.speakerCount + " 位群友发言。",
    "主要氛围偏向：" + topics + "。",
    quote,
    media,
    ending,
  ].filter(Boolean).join("\n");
}

function buildMediaLine(digest) {
  const parts = [];
  if (Number(digest.imageCount || 0) > 0) parts.push("图片 " + digest.imageCount + " 张");
  if (Number(digest.fileCount || 0) > 0) parts.push("文件/资源消息 " + digest.fileCount + " 条");
  if (Number(digest.botMentionCount || 0) > 0) parts.push("提到夜星 " + digest.botMentionCount + " 次");
  return parts.length ? "补充记录：" + parts.join("，") + "。" : "";
}
