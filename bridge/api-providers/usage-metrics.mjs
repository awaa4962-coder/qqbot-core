import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CFG } from "../config.mjs";

const DEFAULT_WINDOW_DAYS = 7;
const RETENTION_DAYS = 30;
const MAX_TOKEN_VALUE = 1_000_000_000;
const USAGE_FILE_RE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const cleanupDays = new Map();

export function normalizeProviderUsage(input = {}) {
  const usage = input && typeof input === "object" ? input : {};
  const promptTokens = firstTokenNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokenCount,
  ) ?? 0;
  const completionTokens = firstTokenNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.candidatesTokenCount,
  ) ?? 0;
  const cached = cacheTokenValue(usage);
  const explicitMiss = usage.cache_reported === false
    ? null
    : firstTokenNumber(usage.prompt_cache_miss_tokens);
  const cacheReported = cached.reported || explicitMiss !== null;
  const cachedTokens = cached.value;
  const missTokens = explicitMiss ?? Math.max(0, promptTokens - cachedTokens);
  const reasoningTokens = firstTokenNumber(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
  ) ?? 0;
  const totalTokens = firstTokenNumber(usage.total_tokens, usage.totalTokenCount) ??
    promptTokens + completionTokens;
  return {
    promptTokens,
    cachedTokens,
    missTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    cacheReported,
    usageReported: hasUsageNumbers(usage),
  };
}

export function recordApiUsage(event = {}, options = {}) {
  const usage = normalizeProviderUsage(event.usage);
  if (!usage.usageReported) return false;
  try {
    const dir = resolveUsageDir(options);
    const timestamp = safeTimestamp(event.timestamp ?? options.now ?? Date.now());
    ensureUsageDirectory(dir);
    cleanupExpiredUsageFiles(dir, timestamp);
    appendUsageRecord(dir, timestamp, {
      kind: "usage",
      timestamp,
      provider: safeId(event.provider, "unknown"),
      task: safeId(event.task, "direct"),
      position: safeId(event.position, "direct"),
      userKey: event.userId === undefined || event.userId === null || event.userId === ""
        ? ""
        : buildUserUsageKey(event.userId, { ...options, dir }),
      durationMs: boundedInteger(event.durationMs),
      ...usage,
    });
    return true;
  } catch {
    return false;
  }
}

export function getUserCacheUsage(userId, options = {}) {
  const now = safeTimestamp(options.now ?? Date.now());
  const days = boundedDays(options.days ?? DEFAULT_WINDOW_DAYS);
  const since = safeTimestamp(options.since ?? now - days * 24 * 60 * 60 * 1000);
  const dir = resolveUsageDir(options);
  const userKey = buildUserUsageKey(userId, { ...options, dir });
  const events = readUserEvents(dir, userKey, now);
  const resetAt = events.reduce((latest, event) =>
    event.kind === "reset" ? Math.max(latest, Number(event.timestamp || 0)) : latest, 0);
  const aggregate = createAggregate();
  const effectiveSince = Math.max(since, resetAt);
  for (const event of events) {
    if (event.kind !== "usage" || Number(event.timestamp || 0) <= effectiveSince) continue;
    addUsageRecord(aggregate, event);
  }
  return finalizeAggregate(aggregate, { since: effectiveSince, now, days });
}

export function buildUserCacheStatsText(userId, options = {}) {
  const now = safeTimestamp(options.now ?? Date.now());
  const today = getUserCacheUsage(userId, {
    ...options,
    now,
    since: beijingDayStart(now),
    days: 1,
  });
  const recent = getUserCacheUsage(userId, { ...options, now, days: 7 });
  if (!recent.calls) {
    return [
      "我的缓存命中",
      "",
      "暂时还没有可统计的模型请求。和夜星正常聊几次后再来看看。",
      "这里统计的是供应商 Prompt Cache，不会保存你的聊天答案或提示词。",
    ].join("\n");
  }

  const lines = [
    "我的缓存命中",
    "",
    formatPeriodLine("今天", today),
    formatPeriodLine("近 7 天", recent),
  ];
  for (const [provider, summary] of sortedProviders(recent.providers)) {
    lines.push(formatPeriodLine(providerLabel(provider), summary));
  }
  lines.push(
    "",
    "说明：按你触发的模型请求统计；首个新前缀通常不会命中。这里只保存匿名 token 计数，最多保留 30 天。",
  );
  return lines.join("\n");
}

export function clearUserCacheUsage(userId, options = {}) {
  try {
    const dir = resolveUsageDir(options);
    const timestamp = safeTimestamp(options.now ?? Date.now());
    ensureUsageDirectory(dir);
    appendUsageRecord(dir, timestamp, {
      kind: "reset",
      timestamp,
      userKey: buildUserUsageKey(userId, { ...options, dir }),
    });
    return true;
  } catch {
    return false;
  }
}

export function buildUserUsageKey(userId, options = {}) {
  const value = String(userId || "").trim();
  if (!value) return "";
  const secret = options.salt || readOrCreateSalt(options.dir || resolveUsageDir(options));
  return crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

function cacheTokenValue(usage) {
  if (usage.cache_reported === false) return { value: 0, reported: false };
  const paths = [
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
  ];
  const value = firstTokenNumber(...paths);
  return { value: value ?? 0, reported: value !== null };
}

function hasUsageNumbers(usage) {
  return [
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokenCount,
    usage.completion_tokens,
    usage.output_tokens,
    usage.candidatesTokenCount,
    usage.total_tokens,
    usage.totalTokenCount,
  ].some(value => firstTokenNumber(value) !== null);
}

function resolveUsageDir(options) {
  return path.resolve(options.dir || CFG.apiUsageDir);
}

function ensureUsageDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function appendUsageRecord(dir, timestamp, record) {
  const file = path.join(dir, "usage-" + beijingDate(timestamp) + ".jsonl");
  fs.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

function readUserEvents(dir, userKey, now) {
  if (!userKey || !fs.existsSync(dir)) return [];
  const earliest = now - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
  const events = [];
  for (const file of listUsageFiles(dir)) {
    for (const line of readUsageLines(path.join(dir, file))) {
      const event = parseUsageLine(line);
      if (!event || event.userKey !== userKey || Number(event.timestamp || 0) < earliest) continue;
      events.push(event);
    }
  }
  return events;
}

function listUsageFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(file => USAGE_FILE_RE.test(file)).sort();
  } catch {
    return [];
  }
}

function readUsageLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseUsageLine(line) {
  if (line.length > 4096) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function createAggregate() {
  return {
    calls: 0,
    cacheReportedCalls: 0,
    hitCalls: 0,
    promptTokens: 0,
    measuredPromptTokens: 0,
    cachedTokens: 0,
    missTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    providers: {},
    tasks: {},
  };
}

function addUsageRecord(aggregate, record) {
  addRecordTotals(aggregate, record);
  addRecordToBucket(aggregate.providers, safeId(record.provider, "unknown"), record);
  addRecordToBucket(aggregate.tasks, safeId(record.task, "direct"), record);
}

function addRecordToBucket(target, key, record) {
  if (!target[key]) target[key] = createAggregateLeaf();
  addRecordTotals(target[key], record);
}

function createAggregateLeaf() {
  const value = createAggregate();
  delete value.providers;
  delete value.tasks;
  return value;
}

function addRecordTotals(target, record) {
  target.calls++;
  if (record.cacheReported === true) {
    target.cacheReportedCalls++;
    target.measuredPromptTokens += boundedInteger(record.cachedTokens) + boundedInteger(record.missTokens);
  }
  if (boundedInteger(record.cachedTokens) > 0) target.hitCalls++;
  for (const key of [
    "promptTokens",
    "cachedTokens",
    "missTokens",
    "completionTokens",
    "reasoningTokens",
    "totalTokens",
    "durationMs",
  ]) {
    target[key] += boundedInteger(record[key]);
  }
}

function finalizeAggregate(aggregate, metadata) {
  const result = finalizeLeaf(aggregate, metadata);
  result.providers = Object.fromEntries(Object.entries(aggregate.providers).map(([key, value]) =>
    [key, finalizeLeaf(value, metadata)]));
  result.tasks = Object.fromEntries(Object.entries(aggregate.tasks).map(([key, value]) =>
    [key, finalizeLeaf(value, metadata)]));
  return result;
}

function finalizeLeaf(value, metadata) {
  const denominator = Number(value.measuredPromptTokens || 0);
  return {
    ...value,
    ...metadata,
    hitRate: denominator > 0 ? Number(value.cachedTokens || 0) / denominator : null,
  };
}

function formatPeriodLine(label, summary) {
  if (!summary.calls) return label + "：暂无请求";
  if (!summary.cacheReportedCalls || !summary.measuredPromptTokens) {
    return label + `：${summary.calls} 次请求，接口暂未返回缓存明细`;
  }
  return label + "：" + formatPercent(summary.hitRate) +
    `（命中 ${formatTokens(summary.cachedTokens)} / 输入 ${formatTokens(summary.measuredPromptTokens)}，${summary.calls} 次）`;
}

function sortedProviders(providers = {}) {
  return Object.entries(providers).sort((left, right) => right[1].promptTokens - left[1].promptTokens);
}

function providerLabel(provider) {
  if (provider === "mimo") return "MiMo";
  if (provider === "deepseek") return "DeepSeek";
  return provider;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "暂无命中率";
  return (value * 100).toFixed(1) + "%";
}

function formatTokens(value) {
  const number = boundedInteger(value);
  if (number >= 1_000_000) return (number / 1_000_000).toFixed(1) + "m";
  if (number >= 1_000) return (number / 1_000).toFixed(1) + "k";
  return String(number);
}

function readOrCreateSalt(dir) {
  ensureUsageDirectory(dir);
  const file = path.join(dir, ".user-salt");
  const existing = readSalt(file);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, generated + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (error?.code === "EEXIST") return readSalt(file) || generated;
    throw error;
  }
}

function readSalt(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value.length >= 32 ? value : "";
  } catch {
    return "";
  }
}

function cleanupExpiredUsageFiles(dir, now) {
  const today = beijingDate(now);
  if (cleanupDays.get(dir) === today) return;
  cleanupDays.set(dir, today);
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of listUsageFiles(dir)) {
    const match = file.match(USAGE_FILE_RE);
    const fileEnd = match ? Date.parse(match[1] + "T23:59:59+08:00") : NaN;
    if (!Number.isFinite(fileEnd) || fileEnd >= cutoff) continue;
    fs.rmSync(path.join(dir, file), { force: true });
  }
}

function firstTokenNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.min(MAX_TOKEN_VALUE, Math.floor(number));
  }
  return null;
}

function boundedInteger(value) {
  return firstTokenNumber(value) ?? 0;
}

function boundedDays(value) {
  const number = Math.floor(Number(value || DEFAULT_WINDOW_DAYS));
  return Math.max(1, Math.min(RETENTION_DAYS, Number.isFinite(number) ? number : DEFAULT_WINDOW_DAYS));
}

function safeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function safeId(value, fallback) {
  const clean = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  return clean || fallback;
}

function beijingDate(timestamp) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function beijingDayStart(timestamp) {
  return Date.parse(beijingDate(timestamp) + "T00:00:00+08:00");
}
