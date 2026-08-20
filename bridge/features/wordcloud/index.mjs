// bridge/features/wordcloud/index.mjs - group word cloud feature.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CFG } from "../../config.mjs";
import { logE } from "../../logger.mjs";
import { sendMsg, sendMsgWithImage } from "../../napcat.mjs";
import { groupChats } from "../../storage.mjs";
import { prepareCommandText } from "../../commands/normalize.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOP_N = 48;
const MIN_TOKEN_COUNT = 2;
const WORDCLOUD_TEMP_PREFIX = "qqfriend-wordcloud-";
const DEFAULT_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const activeWordcloudFiles = new Set();

export async function handleWordcloudCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = options.parsedCommand || parseWordcloudCommand(ctx.text || ctx.rawText, {
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
  if (!parsed) return false;

  const sender = options.sender || sendMsg;
  const imageSender = options.imageSender || sendMsgWithImage;
  const now = options.now || new Date();
  if (!isFeatureGroupAllowed(ctx.group_id, options.featureGroupWhitelist || CFG.featureGroupWhitelist)) {
    await sender(ctx.group_id, "这个群还没开启词云功能。", options.replyToId);
    return true;
  }

  const result = await buildWordcloudReply(ctx.group_id, parsed, { ...options, now });
  if (result.imagePath) {
    try {
      await imageSender(ctx.group_id, result.text, result.imagePath);
    } finally {
      await fs.rm(result.imagePath, { force: true }).catch(() => {});
      activeWordcloudFiles.delete(path.resolve(result.imagePath));
    }
  } else {
    await sender(ctx.group_id, result.text, options.replyToId);
  }
  return true;
}

export function parseWordcloudCommand(text, options = {}) {
  const command = prepareCommandText(text, {
    ...options,
    requireMention: options.requireMention ?? true,
  })
    .toLowerCase();
  if (!command) return null;
  if (["词云", "今日词云", "wordcloud", "word cloud"].includes(command)) return { range: "today", days: 1 };
  if (["昨日词云", "昨天词云", "wordcloud yesterday", "word cloud yesterday"].includes(command)) {
    return { range: "yesterday", days: 1 };
  }

  const daysMatch = command.match(/^(?:词云|wordcloud|word cloud)\s+(\d{1,2})\s*(?:天|d|day|days)?$/i);
  if (!daysMatch) return null;
  const days = Math.max(1, Math.min(30, Number(daysMatch[1])));
  return { range: "days", days };
}

export function isFeatureGroupAllowed(groupId, whitelist = CFG.featureGroupWhitelist) {
  return Array.isArray(whitelist) && whitelist.map(Number).includes(Number(groupId));
}

export async function buildWordcloudReply(groupId, parsed, options = {}) {
  const now = options.now || new Date();
  const chats = options.chats || groupChats[String(groupId)] || [];
  const messages = filterMessagesByRange(chats, parsed, now)
    .slice(-(options.maxMessages || CFG.wordcloudMaxMessages || 800));
  const tokens = collectWordcloudTokens(messages, {
    stopwords: options.stopwords || CFG.wordcloudStopwords,
    topN: options.topN || DEFAULT_TOP_N,
  });

  if (!tokens.length) {
    return {
      text: "互动记录还不够，暂时生成不了词云。可以晚点再试。",
      imagePath: null,
    };
  }

  const title = wordcloudRangeLabel(parsed);
  const text = [
    "词云生成好了。",
    "范围：" + title,
    "热词：" + tokens.slice(0, 12).map(item => item.word).join("、"),
  ].join("\n");
  const renderer = options.renderer || renderWordcloudPng;
  const imagePath = await renderer(tokens, { title, groupId, now }).catch((error) => {
    logE("wordcloud render failed:", error.message);
    return null;
  });
  return { text, imagePath };
}

export function filterMessagesByRange(chats, parsed, now = new Date()) {
  const end = now.getTime();
  let start = end - DAY_MS;
  if (parsed.range === "yesterday") {
    const shanghaiStart = startOfShanghaiDay(now);
    return chats.filter(item => item.ts >= shanghaiStart - DAY_MS && item.ts < shanghaiStart);
  }
  if (parsed.range === "days") start = end - parsed.days * DAY_MS;
  return chats.filter(item => item.ts >= start && item.ts <= end);
}

export function collectWordcloudTokens(messages, options = {}) {
  const stopwords = new Set((options.stopwords || []).map(item => String(item).toLowerCase()));
  const counts = new Map();
  for (const message of messages) {
    if (message.role === "assistant") continue;
    if (isNoiseMessage(message.text)) continue;
    for (const token of tokenizeText(message.text || "")) {
      const normalized = token.toLowerCase();
      if (stopwords.has(normalized) || stopwords.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_TOKEN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, options.topN || DEFAULT_TOP_N)
    .map(([word, count]) => ({ word, count }));
}

function isNoiseMessage(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (value === "[command]") return true;
  if (value.includes("非文本消息") || value.includes("闈炴枃鏈")) return true;
  if (/^\[(?:图片|文件|image|file)/i.test(value)) return true;
  return false;
}

export function tokenizeText(text) {
  const clean = String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\d{5,15}/g, " ")
    .replace(/[^\p{Script=Han}A-Za-z0-9_]+/gu, " ");
  const raw = clean.match(/[\p{Script=Han}]+|[A-Za-z][A-Za-z0-9_]{1,24}|\d{2,}/gu) || [];
  const tokens = [];
  for (const item of raw) {
    if (/^[\p{Script=Han}]+$/u.test(item)) tokens.push(...tokenizeChinese(item));
    else if (item.length >= 2) tokens.push(item);
  }
  return tokens;
}

function tokenizeChinese(text) {
  if (text.length < 2) return [];
  if (text.length <= 4) return [text];
  const tokens = [];
  for (let i = 0; i < text.length - 1; i++) tokens.push(text.slice(i, i + 2));
  for (let i = 0; i < text.length - 2; i++) tokens.push(text.slice(i, i + 3));
  return tokens;
}

export function wordcloudRangeLabel(parsed) {
  if (parsed.range === "yesterday") return "昨天";
  if (parsed.range === "days") return "最近 " + parsed.days + " 天";
  return "今天";
}

export async function renderWordcloudPng(tokens, options = {}) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const filePath = path.join(os.tmpdir(), `${WORDCLOUD_TEMP_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const svg = buildWordcloudSvg(tokens, options);
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  activeWordcloudFiles.add(path.resolve(filePath));
  return filePath;
}

export async function cleanupExpiredWordcloudFiles(options = {}) {
  const root = options.root || os.tmpdir();
  const now = Number(options.now || Date.now());
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_TEMP_MAX_AGE_MS);
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(WORDCLOUD_TEMP_PREFIX)) continue;
    const target = path.join(root, entry.name);
    if (activeWordcloudFiles.has(path.resolve(target))) continue;
    try {
      const age = now - (await fs.stat(target)).mtimeMs;
      if (age >= 0 && age < maxAgeMs) continue;
      if (age < 0 && age > -FUTURE_SKEW_MS) continue;
      await fs.rm(target, { force: true });
      removed++;
    } catch {}
  }
  return removed;
}

export function buildWordcloudSvg(tokens, options = {}) {
  const width = 1200;
  const height = 760;
  const max = Math.max(...tokens.map(item => item.count), 1);
  const colors = ["#15616d", "#1b7f5f", "#355070", "#a23e48", "#5f6f52", "#6d597a"];
  const placed = tokens.slice(0, DEFAULT_TOP_N).map((item, index) => {
    const row = Math.floor(index / 6);
    const col = index % 6;
    const x = 90 + col * 170 + ((row % 2) * 40);
    const y = 190 + row * 68;
    const size = 24 + Math.round((item.count / max) * 42);
    const color = colors[index % colors.length];
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="700">${escapeXml(item.word)}</text>`;
  }).join("\n");
  const title = escapeXml(options.title || "词云");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="36" fill="#f7fbf9"/>
  <circle cx="180" cy="120" r="180" fill="#a7f3d0" opacity="0.42"/>
  <circle cx="1020" cy="620" r="220" fill="#bae6fd" opacity="0.46"/>
  <text x="70" y="90" font-size="42" fill="#102a43" font-weight="800">QQFriend 群词云</text>
  <text x="72" y="136" font-size="24" fill="#52616b">范围：${title}，只展示聚合热词，不展示聊天原文。</text>
  ${placed}
</svg>`;
}

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

function startOfShanghaiDay(now) {
  const dateText = new Date(now).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  return Date.parse(dateText + "T00:00:00+08:00");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
