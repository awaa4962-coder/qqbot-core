import { TOPIC_RULES } from "../knowledge/topic-rules.mjs";
import {
  isSummaryBotMessage,
  prepareSummaryEvidence,
  summaryUserKey,
} from "./evidence.mjs";
import { redactSummaryText } from "./formatter.mjs";

const TOPIC_EPISODE_GAP_MS = 90 * 60 * 1000;
const SENSITIVE_RE = /(sk-[A-Za-z0-9_-]{12,}|api[_-]?key|token|secret|password|passwd|密码|密钥|\b1[3-9]\d{9}\b|\b\d{6,18}\b)/i;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?\b/;
const IPV6_RE = /(?:^|[^0-9A-Fa-f])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?::\d{1,5})?(?:$|[^0-9A-Fa-f])/;

export function buildSummaryDigest(messages = [], options = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const evidence = options.evidence || prepareSummaryEvidence(items, options);
  const topics = new Map();
  const timeBuckets = createTimeBuckets();
  const quoteCandidates = [];
  const humanSpeakers = new Set();
  let imageCount = 0;
  let fileCount = 0;
  let botMentionCount = 0;

  for (const item of items) {
    if (isSummaryBotMessage(item, options)) continue;
    humanSpeakers.add(summaryUserKey(item));
    if (Array.isArray(item.imageUrls)) imageCount += item.imageUrls.length;
  }

  for (const item of evidence.messages) {
    const text = normalizeText(item.text);
    countTopics(text, topics);
    countTimeBucket(item.ts, timeBuckets);
    if (looksLikeFileMessage(text)) fileCount++;
    if (mentionsBot(text, options)) botMentionCount++;
    const quote = pickQuoteCandidate(item, text);
    if (quote) quoteCandidates.push(quote);
  }

  quoteCandidates.sort((left, right) => right.score - left.score || Number(left.ts || 0) - Number(right.ts || 0));
  return {
    messageCount: items.length,
    effectiveMessageCount: evidence.messages.length,
    speakerCount: humanSpeakers.size,
    filtered: { ...evidence.metrics },
    topicHints: [...topics.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    topicEpisodes: buildTopicEpisodes(evidence.messages),
    quoteCandidates: quoteCandidates.slice(0, 3).map(({ nickname, text }) => ({ nickname, text })),
    repeatEvents: evidence.repeatEvents,
    timeBuckets,
    imageCount,
    fileCount,
    botMentionCount,
  };
}

export function formatDigestForPrompt(digest) {
  return [
    "系统统计事实（数字以这里为准）：",
    `- 原始消息 ${Number(digest.messageCount || 0)} 条；有效分析证据 ${Number(digest.effectiveMessageCount || 0)} 条；人类发言者 ${Number(digest.speakerCount || 0)} 位。`,
    "- 话题关键词线索：" + formatTopics(digest.topicHints),
    "- 讨论时段线索：" + formatTopicEpisodes(digest.topicEpisodes),
    "- 活跃时段：" + formatTimeBuckets(digest.timeBuckets),
    `- 媒体记录：图片 ${Number(digest.imageCount || 0)} 张；文件/资源消息 ${Number(digest.fileCount || 0)} 条；明确提到机器人 ${Number(digest.botMentionCount || 0)} 次。`,
  ].join("\n");
}

function buildTopicEpisodes(items) {
  const episodesByTopic = new Map();
  const ordered = [...items].sort((left, right) => Number(left.ts || 0) - Number(right.ts || 0));
  for (const item of ordered) {
    const ts = Number(item.ts || 0);
    for (const topic of detectTopics(normalizeText(item.text))) {
      const episodes = episodesByTopic.get(topic) || [];
      let episode = episodes.at(-1);
      if (!episode || !ts || ts - episode.endTs > TOPIC_EPISODE_GAP_MS) {
        episode = { topic, startTs: ts, endTs: ts, messageCount: 0, speakers: new Set() };
        episodes.push(episode);
        episodesByTopic.set(topic, episodes);
      }
      episode.endTs = ts || episode.endTs;
      episode.messageCount++;
      episode.speakers.add(summaryUserKey(item));
    }
  }

  return [...episodesByTopic.values()]
    .flat()
    .sort((left, right) => episodeScore(right) - episodeScore(left) || left.startTs - right.startTs)
    .slice(0, 5)
    .map(episode => ({
      topic: episode.topic,
      startTs: episode.startTs,
      endTs: episode.endTs,
      messageCount: episode.messageCount,
      speakerCount: episode.speakers.size,
    }));
}

function episodeScore(episode) {
  return episode.messageCount + episode.speakers.size * 2;
}

function detectTopics(text) {
  return TOPIC_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function createTimeBuckets() {
  return { dawn: 0, morning: 0, afternoon: 0, evening: 0, night: 0 };
}

function countTimeBucket(ts, buckets) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return;
  const hour = new Date(Number(ts)).toLocaleString("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const value = Number(hour);
  if (value < 6) buckets.dawn++;
  else if (value < 12) buckets.morning++;
  else if (value < 18) buckets.afternoon++;
  else if (value < 22) buckets.evening++;
  else buckets.night++;
}

function countTopics(text, topics) {
  for (const name of detectTopics(text)) topics.set(name, (topics.get(name) || 0) + 1);
}

function pickQuoteCandidate(item, text) {
  if (!isSafeQuote(text)) return null;
  return {
    nickname: safeNickname(item.nickname),
    text,
    score: scoreQuote(text),
    ts: item.ts,
  };
}

function isSafeQuote(text) {
  if (!text || text.length < 4 || text.length > 60) return false;
  if (SENSITIVE_RE.test(text) || IPV4_RE.test(text) || IPV6_RE.test(text)) return false;
  if (/https?:\/\/|CQ:|^\[非文本消息\]$/.test(text)) return false;
  return true;
}

function scoreQuote(text) {
  let score = Math.min(text.length, 60);
  if (/[！？?!]/.test(text)) score += 4;
  if (/确认|完成|解决|失败|原因|结果|决定|修复|通过/.test(text)) score += 10;
  if (/哈哈|笑死|草|绷|牛|离谱|急|乐/.test(text)) score += 2;
  return score;
}

function looksLikeFileMessage(text) {
  return /文件|压缩包|zip|7z|rar|pdf|docx|xlsx|下载|资源/i.test(text);
}

function mentionsBot(text, options) {
  const selfUin = String(options.selfUin || "").trim();
  if (selfUin && new RegExp(`CQ:at,qq=${escapeRegex(selfUin)}(?:,|\\])`, "i").test(text)) return true;
  const names = Array.isArray(options.botNames) && options.botNames.length
    ? options.botNames
    : ["夜星", "QQFriend", "Yexing"];
  return names.some(name => new RegExp(`(?:@|^|\\s)${escapeRegex(name)}(?:\\s|$)`, "i").test(text));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function safeNickname(value) {
  return redactSummaryText(String(value || "群友").replace(/\[|\]/g, "")).slice(0, 20);
}

function formatTopics(items = []) {
  return items.length ? items.map(item => item.name + " x" + item.count).join("、") : "没有可靠的关键词主题";
}

function formatTopicEpisodes(items = []) {
  return items.length ? items.map(item => {
    const time = formatTimeRange(item.startTs, item.endTs);
    return `${item.topic} ${time}（${item.messageCount} 条，${item.speakerCount} 人）`;
  }).join("；") : "没有形成可靠时段线索";
}

function formatTimeBuckets(buckets = {}) {
  const labels = [
    ["dawn", "凌晨"],
    ["morning", "上午"],
    ["afternoon", "下午"],
    ["evening", "晚上"],
    ["night", "深夜"],
  ];
  const present = labels.filter(([key]) => Number(buckets[key] || 0) > 0);
  return present.length ? present.map(([key, label]) => `${label} ${Number(buckets[key])} 条`).join("、") : "无有效时段数据";
}

function formatTimeRange(startTs, endTs) {
  const start = formatClock(startTs);
  const end = formatClock(endTs);
  if (!start) return "时间未知";
  return !end || end === start ? start : `${start}-${end}`;
}

function formatClock(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return "";
  return new Date(Number(ts)).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
