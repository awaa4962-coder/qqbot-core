import { normalizeProviderUsage } from "./usage-values.mjs";
import { aggregateUsage, usageDimensions, tokenNumber } from "./usage-aggregate.mjs";
import { appendUsageEvent, readUsageEvents, usageUserKey, usageDirectory, validTimestamp, beijingDayStart, RETENTION_DAYS } from "./usage-records.mjs";
import { getVisionDescriptionCacheStatus } from "../vision/description-cache.mjs";
import { taskName } from "./store.mjs";

export { normalizeProviderUsage };

const DEFAULT_WINDOW_DAYS = 7;
const FILTERS = ["provider", "model", "task", "position", "promptVersion", "configuredMode", "effectiveMode"];
const writeFailures = new Map();

export function recordApiUsage(event = {}, options = {}) {
  try {
    const usage = normalizeProviderUsage(event.usage);
    const timestamp = currentTime(event.timestamp ?? options.now);
    appendUsageEvent({
      schema: 2, kind: "usage", timestamp, ...usageDimensions(event),
      status: event.status === "error" ? "error" : "ok",
      userKey: event.userId === undefined || event.userId === null || event.userId === ""
        ? "" : usageUserKey(event.userId, { ...options, createSalt: true }),
      transportAttempts: tokenNumber(event.transportAttempts) ?? 1,
      durationReported: typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0,
      durationMs: Math.max(0, Math.min(1e9, Math.round(Number(event.durationMs) || 0))),
      ...usage,
    }, options);
    return true;
  } catch { recordWriteFailure(options); return false; }
}

export function getUserCacheUsage(userId, options = {}) {
  const window = usageWindow(options);
  const read = readMeasuredWindow({ ...options, includeFutureResets: true }, window);
  let key = "";
  try { key = usageUserKey(userId, options); }
  catch { read.coverage.complete = false; read.coverage.unreadableFiles++; }
  // Incomplete input might hide a reset marker. Do not resurrect old personal totals.
  const events = key && read.coverage.complete ? read.events.filter(event => event.userKey === key) : [];
  const resetAt = events.reduce((at, event) => event.kind === "reset" ? Math.max(at, event.timestamp) : at, 0);
  if (resetAt > window.now) { read.coverage.futureReset = true; read.coverage.complete = false; }
  const since = Math.max(window.since, resetAt);
  const selected = events.filter(event => event.kind === "usage" && event.timestamp > since);
  const result = aggregateUsage(selected);
  return { ...result.summary, ...window, since, providers: result.providers, tasks: result.tasks, rows: result.rows,
    coverage: read.coverage, today: aggregateUsage(selected.filter(event => event.timestamp > beijingDayStart(window.now))).summary };
}

export function getApiUsageSnapshot(options = {}) {
  const window = usageWindow(options);
  const filters = normalizeUsageFilters(options);
  const read = readMeasuredWindow(options, window);
  const result = aggregateUsage(read.events, filters);
  return { schema: 2, ...window, summary: result.summary, rows: result.rows, facets: result.facets,
    taskLabels: Object.fromEntries(result.facets.tasks.map(task => [task, taskName(task)])),
    coverage: { ...read.coverage, rowsOmitted: result.rowsOmitted },
    localCaches: { imageDescription: getVisionDescriptionCacheStatus() } };
}

export function normalizeUsageFilters(options = {}) {
  const result = {};
  for (const key of FILTERS) {
    const value = options[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > 96 || usageDimensions({ [key]: value })[key] !== value) throw new Error("用量筛选参数无效");
    result[key] = value;
  }
  return result;
}

export function clearUserCacheUsage(userId, options = {}) {
  try {
    const userKey = usageUserKey(userId, { ...options, createSalt: true });
    if (!userKey) return false;
    appendUsageEvent({ schema: 2, kind: "reset", timestamp: currentTime(options.now), userKey }, options);
    return true;
  } catch { recordWriteFailure(options); return false; }
}

export function buildUserUsageKey(userId, options = {}) {
  return usageUserKey(userId, { ...options, createSalt: true });
}

export function buildUserCacheStatsText(userId, options = {}) {
  const recent = getUserCacheUsage(userId, { ...options, days: 7 });
  if (!recent.coverage.complete) return "我的缓存命中\n\n统计记录暂时无法完整读取，不能准确计算。请稍后再试或联系管理员。";
  if (!recent.calls) return [
    "我的缓存命中", "", "暂时还没有可统计的模型请求。和夜星正常聊几次后再来看看。",
    "这里统计的是供应商 Prompt Cache，不会保存你的聊天答案或提示词。",
  ].join("\n");
  const lines = ["我的缓存命中", "", formatPeriodLine("今天", recent.today), formatPeriodLine("近 7 天", recent)];
  for (const [provider, value] of Object.entries(recent.providers).sort((a, b) => b[1].promptTokens - a[1].promptTokens).slice(0, 6)) {
    lines.push(formatPeriodLine(providerLabel(provider), value));
  }
  lines.push("", "按已记录的接口调用统计，重试尝试数不等于成功回答数；缺少用量不按零费用处理。命中率只计算已报告缓存明细的输入 token，非节费比例。",
    "这里只统计匿名用量和模型/提示词版本，最多回看30天，不保存提示词或回复正文；过期日文件在后续写入时清理。");
  return lines.join("\n");
}

function formatPeriodLine(label, value) {
  if (!value.calls) return label + "：暂无调用";
  const coverage = value.cacheReportedCalls + "/" + value.calls + " 次有缓存明细";
  if (value.hitRate === null) return label + "：" + value.calls + " 次调用，缓存命中率未知（" + coverage + "）";
  return label + "：" + (value.hitRate * 100).toFixed(1) + "%（命中 " + formatTokens(value.cachedTokens) +
    " / 已测输入 " + formatTokens(value.measuredPromptTokens) + "；" + coverage + "）";
}

function providerLabel(value) { return value === "mimo" ? "MiMo" : value === "deepseek" ? "DeepSeek" : value; }
function formatTokens(value) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "m";
  if (value >= 1000) return (value / 1000).toFixed(1) + "k";
  return String(value);
}

function currentTime(value) { return validTimestamp(value) ? value : Date.now(); }
function usageWindow(options) {
  const now = currentTime(options.now);
  const days = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(Number(options.days) || DEFAULT_WINDOW_DAYS)));
  const since = Math.max(now - RETENTION_DAYS * 86400000, validTimestamp(options.since) ? options.since : now - days * 86400000);
  return { since: Math.min(since, now), now, days };
}

function readMeasuredWindow(options, window) {
  const result = readUsageEvents({ ...options, ...window });
  const missingWrites = writeFailures.get(usageDirectory(options)) || 0;
  result.coverage.writeFailuresSinceStart = missingWrites;
  if (missingWrites) result.coverage.complete = false;
  return result;
}

function recordWriteFailure(options) {
  try {
    const key = usageDirectory(options);
    writeFailures.set(key, (writeFailures.get(key) || 0) + 1);
    if (writeFailures.size > 64) writeFailures.delete(writeFailures.keys().next().value);
  } catch { /* Invalid caller paths do not interrupt the model response. */ }
}
