import { TOPIC_RULES } from "../knowledge/topic-rules.mjs";

const SENSITIVE_RE = /(sk-[A-Za-z0-9_-]{12,}|api[_-]?key|token|secret|password|passwd|密码|密钥|\b1[3-9]\d{9}\b|\b\d{15,18}[0-9x]\b)/i;

export function buildSummaryDigest(messages = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const topics = new Map();
  const timeBuckets = createTimeBuckets();
  const quoteCandidates = [];
  let imageCount = 0;
  let fileCount = 0;
  let botMentionCount = 0;

  for (const item of items) {
    const text = normalizeText(item.text);
    countTopics(text, topics);
    countTimeBucket(item.ts, timeBuckets);
    if (Array.isArray(item.imageUrls)) imageCount += item.imageUrls.length;
    if (looksLikeFileMessage(text)) fileCount++;
    if (/夜星|qqfriend|@/.test(text)) botMentionCount++;
    const quote = pickQuoteCandidate(item, text);
    if (quote) quoteCandidates.push(quote);
  }

  quoteCandidates.sort((a, b) => b.score - a.score || Number(a.ts || 0) - Number(b.ts || 0));
  return {
    messageCount: items.length,
    topicHints: [...topics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    quoteCandidates: quoteCandidates.slice(0, 5).map(({ nickname, text }) => ({ nickname, text })),
    timeBuckets,
    imageCount,
    fileCount,
    botMentionCount,
  };
}

export function formatDigestForPrompt(digest) {
  return [
    "结构化摘要：",
    "话题提示：" + formatTopics(digest.topicHints),
    "代表性短句：" + formatQuotes(digest.quoteCandidates),
    "活跃时段：" + formatTimeBuckets(digest.timeBuckets),
    "图片数：" + Number(digest.imageCount || 0),
    "文件/资源消息数：" + Number(digest.fileCount || 0),
    "提到夜星/机器人次数：" + Number(digest.botMentionCount || 0),
  ].join("\n");
}

function createTimeBuckets() {
  return { dawn: 0, morning: 0, afternoon: 0, evening: 0, night: 0 };
}

function countTimeBucket(ts, buckets) {
  const hour = new Date(Number(ts || 0)).toLocaleString("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const h = Number(hour);
  if (h < 6) buckets.dawn++;
  else if (h < 12) buckets.morning++;
  else if (h < 18) buckets.afternoon++;
  else if (h < 22) buckets.evening++;
  else buckets.night++;
}

function countTopics(text, topics) {
  for (const [name, pattern] of TOPIC_RULES) {
    if (pattern.test(text)) topics.set(name, (topics.get(name) || 0) + 1);
  }
}

function pickQuoteCandidate(item, text) {
  if (!isSafeQuote(text)) return null;
  const score = scoreQuote(text);
  return {
    nickname: safeNickname(item.nickname),
    text,
    score,
    ts: item.ts,
  };
}

function isSafeQuote(text) {
  if (!text || text.length < 4 || text.length > 60) return false;
  if (SENSITIVE_RE.test(text)) return false;
  if (/https?:\/\/|CQ:|^\[非文本消息\]$/.test(text)) return false;
  return true;
}

function scoreQuote(text) {
  let score = Math.min(text.length, 60);
  if (/[！？?!]/.test(text)) score += 8;
  if (/哈哈|笑死|草|绷|牛|离谱|急|乐/.test(text)) score += 6;
  if (/夜星|bot|机器人|jm|下载|修复/.test(text)) score += 4;
  return score;
}

function looksLikeFileMessage(text) {
  return /文件|压缩包|zip|7z|rar|pdf|docx|xlsx|下载|资源/i.test(text);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function safeNickname(value) {
  return String(value || "群友").replace(/\[|\]/g, "").slice(0, 20);
}

function formatTopics(items = []) {
  return items.length ? items.map(item => item.name + " x" + item.count).join("、") : "暂无明显主题";
}

function formatQuotes(items = []) {
  return items.length ? items.map(item => item.nickname + "：「" + item.text + "」").join("；") : "暂无适合引用的短句";
}

function formatTimeBuckets(buckets = {}) {
  const labels = [
    ["dawn", "凌晨"],
    ["morning", "上午"],
    ["afternoon", "下午"],
    ["evening", "晚上"],
    ["night", "深夜"],
  ];
  return labels.map(([key, label]) => label + " " + Number(buckets[key] || 0)).join("、");
}
