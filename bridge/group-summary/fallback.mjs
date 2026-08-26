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
  const lowData = digest.effectiveMessageCount < 8;
  const episodes = selectTopicEpisodes(digest, style.maxTopics);
  const topicNames = episodes.map(item => item.topic).join("、") || "日常交流";

  if (lowData) {
    return [
      `【${label} 群聊日报】`,
      "",
      "今日主线：有效记录较少，暂时无法可靠概括主要讨论。",
      `可确认线索：${topicNames}。`,
      "状态：记录不足，不推测讨论结果。",
      buildMediaLine(digest),
      `参与概况：${stats.messageCount} 条消息，${stats.speakerCount} 位群友发言。`,
    ].filter(Boolean).join("\n");
  }

  return [
    `【${label} 群聊日报】`,
    "",
    `今日主线：有效讨论主要集中在${topicNames}；以下只保留可以由记录直接核对的线索。`,
    "",
    "关键线索",
    ...buildEpisodeLines(episodes),
    buildMediaLine(digest),
    `参与概况：${stats.messageCount} 条消息，${stats.speakerCount} 位群友发言；参与较多者：${stats.top3}。`,
  ].filter(Boolean).join("\n");
}

function selectTopicEpisodes(digest, limit) {
  const seen = new Set();
  const result = [];
  for (const item of digest.topicEpisodes || []) {
    const topic = String(item.topic || "").trim();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    result.push({ ...item, topic });
    if (result.length >= limit) return result;
  }
  for (const item of digest.topicHints || []) {
    const topic = String(item.name || "").trim();
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    result.push({ topic, messageCount: Number(item.count || 0), speakerCount: 0 });
    if (result.length >= limit) break;
  }
  return result;
}

function buildEpisodeLines(episodes) {
  if (!episodes.length) {
    return ["1. 日常交流：没有形成可稳定归类的主题，不根据零散消息补写结论。"];
  }
  return episodes.map((item, index) => {
    const time = formatTimeRange(item.startTs, item.endTs);
    const speakerText = Number(item.speakerCount || 0) > 0
      ? `，${Number(item.speakerCount)} 位群友参与`
      : "";
    return `${index + 1}. ${item.topic}${time ? `（${time}）` : ""}：` +
      `${Number(item.messageCount || 0)} 条相关消息${speakerText}；结果未确认。`;
  });
}

function formatTimeRange(startTs, endTs) {
  const start = formatClock(startTs);
  const end = formatClock(endTs);
  if (!start) return "";
  return !end || end === start ? start : `${start}-${end}`;
}

function formatClock(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function buildMediaLine(digest) {
  const parts = [];
  if (Number(digest.imageCount || 0) > 0) parts.push(`图片 ${digest.imageCount} 张`);
  if (Number(digest.fileCount || 0) > 0) parts.push(`文件/资源消息 ${digest.fileCount} 条`);
  return parts.length ? "媒体记录：" + parts.join("，") + "。" : "";
}
