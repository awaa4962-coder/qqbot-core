import {
  findMemeByNameOrAlias,
  getMemeStore,
  setMemeEnabled,
} from "./store.mjs";
import {
  isActiveMemeEntry,
  normalizeMemeKey,
} from "./schema.mjs";
import { isMemeContextSuppressed } from "./message-policy.mjs";

const TRUSTED_SOURCES = new Set(["builtin", "manual", "web-verified"]);

export function matchMemes(text, options = {}) {
  const value = String(text || "").normalize("NFKC").trim();
  if (!value || isMemeContextSuppressed(value)) return [];
  const store = getMemeStore();
  const terms = segmentedKeys(value);
  const groupId = String(options.groupId || options.group_id || "");
  const matches = [];

  for (const entry of store.entries || []) {
    if (!isActiveMemeEntry(entry, store.mode)) continue;
    if (!scopeAllows(entry, groupId)) continue;
    const hit = entryKeys(entry).find(key => keyMatches(value, terms, key, entry));
    if (!hit) continue;
    matches.push({
      ...entry,
      matched: hit,
      score: memeMatchScore(entry, hit, groupId),
    });
  }

  matches.sort((left, right) => right.score - left.score);
  return matches.slice(0, Math.min(4, Number(options.limit || 4)));
}

export function buildMemeContextBlock(options = {}) {
  const text = String(options.text || options.userMsg || "").trim();
  if (!text) return "";
  const matches = matchMemes(text, { ...options, limit: 2 });
  if (!matches.length) return "";
  const lines = matches.map(formatMemeLine);
  return [
    "[梗库语境提示]",
    "只帮助理解当前发言，不要求主动复读梗；求助、报错和正事优先直接回答。",
    ...lines,
  ].join("\n").slice(0, 700);
}

export function buildMemeSearchReply(query) {
  const key = String(query || "").trim();
  if (!key) return "梗库搜索：请在后面加关键词，例如“梗库 搜 哈基米”。";
  const entry = findMemeByNameOrAlias(key);
  if (!entry) return "梗库里暂时没有找到“" + key + "”。可以在控制台人工添加，或等待联网更新查证。";
  return [
    "梗库：" + entry.name,
    "状态：" + statusLabel(entry.status) + "，来源：" + sourceLabel(entry.source),
    "等级：" + entry.level + "，综合置信度：" + Math.round(Number(entry.confidence || 0) * 100) + "%",
    entry.scope?.type === "groups" ? "范围：仅已学习到的群" : "范围：全局",
    entry.aliases?.length ? "别名：" + entry.aliases.join("、") : "",
    "含义：" + entry.meaning,
    "用法：" + entry.usage,
    entry.examples?.length ? "例子：" + entry.examples.slice(0, 2).join("；") : "",
  ].filter(Boolean).join("\n");
}

export function buildMemeStatusReply() {
  const store = getMemeStore();
  const entries = store.entries || [];
  const candidates = Object.values(store.candidates || {});
  const active = entries.filter(entry => entry.status === "active" && entry.enabled).length;
  const quarantined = entries.filter(entry => entry.status === "quarantined").length;
  const disabled = entries.filter(entry => entry.status === "disabled" || entry.enabled === false).length;
  const pending = candidates.filter(entry => entry.status === "candidate").length;
  const stale = entries.filter(entry => entry.status === "stale").length;
  const sync = store.sync || {};
  return [
    "梗库状态",
    "模式：" + store.mode + modeHint(store.mode),
    "正式词条：" + active + " 条；隔离：" + quarantined + " 条；停用：" + disabled + " 条；过期：" + stale + " 条。",
    "遗留候选：" + pending + " 条；删除墓碑：" + (store.tombstones || []).length + " 条。",
    "最近联网更新：" + (sync.lastSuccessAt || "尚未成功") +
      "；新增 " + Number(sync.accepted || 0) + "，更新 " + Number(sync.updated || 0) + "。",
    "群消息只统计已知梗的使用，不会再从聊天碎片自动造词条；人工修改优先于联网更新。",
  ].join("\n");
}

export function buildMemeToggleReply(action, query) {
  const enabled = action === "enable";
  const entry = setMemeEnabled(query, enabled);
  if (!entry) return "梗库里没有找到“" + String(query || "").trim() + "”。";
  return "已" + (enabled ? "启用" : "禁用") + "梗：" + entry.name + "。";
}

function keyMatches(text, segmented, rawKey, entry) {
  const key = normalizeMemeKey(rawKey);
  if (!key) return false;
  const length = [...String(rawKey || "")].length;
  if (entry.source === "auto" && length <= 2) {
    const normalizedText = normalizeMemeKey(text);
    return segmented.has(key) ||
      normalizedText.startsWith(key) ||
      normalizedText.endsWith(key);
  }
  if (/^[A-Za-z0-9_-]+$/.test(rawKey)) {
    return new RegExp("(^|[^A-Za-z0-9_])" + escapeRegex(rawKey) + "($|[^A-Za-z0-9_])", "i").test(text);
  }
  if (!TRUSTED_SOURCES.has(entry.source) && length < 3) return segmented.has(key);
  return normalizeMemeKey(text).includes(key);
}

function scopeAllows(entry, groupId) {
  const scope = entry.scope || { type: "global", groupIds: [] };
  if (scope.type !== "groups") return true;
  return Boolean(groupId && (scope.groupIds || []).map(String).includes(groupId));
}

function segmentedKeys(text) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return new Set(
    [...segmenter.segment(text)]
      .filter(item => item.isWordLike)
      .map(item => normalizeMemeKey(item.segment))
      .filter(Boolean),
  );
}

function formatMemeLine(entry) {
  const example = entry.examples?.[0] ? " 例：" + entry.examples[0] : "";
  return "- " + entry.name + "：" + entry.meaning + " 用法：" + entry.usage + example;
}

function memeMatchScore(entry, hit, groupId) {
  const sourceScore = {
    manual: 0.35,
    builtin: 0.3,
    "web-verified": 0.28,
    "china-meme-dictionary": 0.05,
    auto: 0.04,
  }[entry.source] || 0;
  const scopeScore = entry.scope?.type === "groups" &&
    entry.scope.groupIds?.map(String).includes(groupId) ? 0.12 : 0;
  return Number(entry.semanticConfidence || 0) * 0.45 +
    Number(entry.frequencyConfidence || entry.confidence || 0) * 0.25 +
    sourceScore +
    scopeScore +
    ([...String(hit || "")].length >= 3 ? 0.05 : 0);
}

function entryKeys(entry) {
  return [entry.name, ...(entry.aliases || []), ...(entry.triggers || [])];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modeHint(mode) {
  if (mode === "off") return "（不统计、不注入）";
  if (mode === "shadow") return "（只使用人工与内置词条）";
  return "（使用人工词条与联网查证词条）";
}

function statusLabel(status) {
  return {
    active: "启用",
    quarantined: "隔离",
    disabled: "停用",
    stale: "过期",
  }[status] || status || "未知";
}

function sourceLabel(source) {
  return {
    builtin: "内置",
    manual: "人工",
    auto: "群聊学习",
    "china-meme-dictionary": "中文梗词典",
    "web-verified": "联网查证",
  }[source] || source || "未知";
}
