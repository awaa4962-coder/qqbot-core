import { dateLabel, formatDate } from "./date.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { prepareSummaryEvidence } from "./evidence.mjs";
import { buildSummaryStats } from "./stats.mjs";
import { getSummaryStyle } from "./styles.mjs";

export function buildLocalSummaryFallback(messages, options = {}) {
  const label = options.label || dateLabel(options.dateText || formatDate());
  const evidence = options.evidence || prepareSummaryEvidence(messages || [], options);
  const stats = buildSummaryStats(messages || [], { ...options, evidence });
  const digest = options.digest || buildSummaryDigest(messages || [], { ...options, evidence });
  const style = getSummaryStyle(options.style);
  const topics = digest.topicHints?.length
    ? digest.topicHints.map(item => item.name).slice(0, style.maxTopics).join("、")
    : "没有形成可靠主题";
  const lowData = digest.effectiveMessageCount < 8;

  return [
    `【${label} 群聊日报】`,
    "",
    lowData
      ? "今日主线：有效记录较少，暂时无法可靠概括主要讨论。"
      : "今日主线：模型暂未生成可用正文，以下仅保留可以直接核对的统计和话题线索。",
    `可确认线索：${topics}。`,
    lowData ? "状态：记录不足，不推测讨论结果。" : "状态：未进行语义结论判断，不补写讨论结果。",
    buildMediaLine(digest),
    `参与概况：${stats.messageCount} 条消息，${stats.speakerCount} 位群友发言。`,
  ].filter(Boolean).join("\n");
}

function buildMediaLine(digest) {
  const parts = [];
  if (Number(digest.imageCount || 0) > 0) parts.push(`图片 ${digest.imageCount} 张`);
  if (Number(digest.fileCount || 0) > 0) parts.push(`文件/资源消息 ${digest.fileCount} 条`);
  return parts.length ? "媒体记录：" + parts.join("，") + "。" : "";
}
