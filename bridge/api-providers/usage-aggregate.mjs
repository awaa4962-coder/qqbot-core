import { redactSensitiveText } from "../privacy.mjs";
import { normalizeProviderUsage } from "./usage-values.mjs";

const REPORTED = ["prompt", "completion", "reasoning", "total"];
const DIMENSIONS = ["provider", "model", "task", "position", "promptVersion", "promptFingerprint", "configuredMode", "effectiveMode", "reasoningControl", "reasoningApplied"];
const FACETS = { providers: "provider", models: "model", tasks: "task", positions: "position", promptVersions: "promptVersion", configuredModes: "configuredMode", effectiveModes: "effectiveMode" };

export function usageDimensions(event = {}) {
  return {
    provider: safeIdentity(event.provider), model: safeIdentity(event.model, true), task: safeIdentity(event.task),
    position: oneOf(event.position, ["primary", "fallback", "direct"]),
    promptVersion: safePromptVersion(event.promptVersion),
    promptFingerprint: typeof event.promptFingerprint === "string" && /^[a-f0-9]{16}$/.test(event.promptFingerprint) ? event.promptFingerprint : "",
    configuredMode: oneOf(event.configuredMode, ["economy", "auto", "deep"]),
    effectiveMode: oneOf(event.effectiveMode, ["economy", "deep", "provider_default", "not_supported"]),
    reasoningControl: oneOf(event.reasoningControl, ["none", "provider-default", "mimo-toggle", "deepseek-toggle", "effort"]),
    reasoningApplied: oneOf(event.reasoningApplied, ["yes", "no"]),
  };
}

export function aggregateUsage(events, filters = {}) {
  const summary = emptyUsageLeaf();
  const providers = new Map();
  const tasks = new Map();
  const groups = new Map();
  const facets = Object.fromEntries(Object.keys(FACETS).map(key => [key, new Set()]));
  for (const event of events) {
    if (event.kind !== "usage") continue;
    const row = normalizedRecord(event);
    for (const [key, field] of Object.entries(FACETS)) facets[key].add(row[field]);
    if (!DIMENSIONS.every(key => !filters[key] || filters[key] === row[key])) continue;
    addTotals(summary, row);
    addBucket(providers, row.provider, row);
    addBucket(tasks, row.task, row);
    const key = JSON.stringify(DIMENSIONS.map(field => row[field]));
    if (!groups.has(key)) groups.set(key, { ...usageDimensions(row), ...emptyUsageLeaf() });
    addTotals(groups.get(key), row);
  }
  const ordered = [...groups.values()].sort((a, b) => b.promptTokens - a.promptTokens || b.calls - a.calls || a.model.localeCompare(b.model));
  return { summary: finalizeUsageLeaf(summary), rows: ordered.slice(0, 200).map(finalizeUsageLeaf),
    rowsOmitted: Math.max(0, ordered.length - 200),
    providers: Object.fromEntries([...providers].map(([key, value]) => [key, finalizeUsageLeaf(value)])),
    tasks: Object.fromEntries([...tasks].map(([key, value]) => [key, finalizeUsageLeaf(value)])),
    facets: Object.fromEntries(Object.entries(facets).map(([key, values]) => [key, [...values].sort().slice(0, 200)])) };
}

export function emptyUsageLeaf() {
  return { calls: 0, successfulCalls: 0, failedCalls: 0, transportAttempts: 0, transportReportedCalls: 0, durationReportedCalls: 0, legacyCalls: 0, usageReportedCalls: 0,
    promptReportedCalls: 0, completionReportedCalls: 0, reasoningReportedCalls: 0, totalReportedCalls: 0,
    cacheReportedCalls: 0, hitCalls: 0, promptTokens: 0, measuredPromptTokens: 0, cachedTokens: 0, missTokens: 0,
    completionTokens: 0, reasoningTokens: 0, totalTokens: 0, durationMs: 0 };
}

function normalizedRecord(event) {
  const legacy = event.schema !== 2;
  const counts = Object.fromEntries(REPORTED.map(type => [type + "Tokens", tokenNumber(event[type + "Tokens"])]));
  const cachedTokens = tokenNumber(event.cachedTokens);
  const missTokens = tokenNumber(event.missTokens);
  const usage = normalizeProviderUsage({ ...counts, cachedTokens, missTokens,
    usageReported: legacy || event.usageReported === true,
    ...Object.fromEntries(REPORTED.map(type => [type + "Reported", legacy
      ? counts[type + "Tokens"] !== null && counts[type + "Tokens"] > 0
      : event[type + "Reported"] === true])),
    cacheReported: event.cacheReported === true && cachedTokens !== null && missTokens !== null,
  });
  const transportAttempts = tokenNumber(event.transportAttempts);
  const durationMs = tokenNumber(event.durationMs);
  const row = { ...usageDimensions(event), status: event.status === "error" ? "error" : "ok", legacy,
    transportAttempts: transportAttempts ?? 0,
    transportReported: transportAttempts !== null,
    durationMs: durationMs ?? 0,
    durationReported: (legacy || event.durationReported === true) && durationMs !== null,
    ...usage };
  return row;
}

function addBucket(map, key, row) {
  if (!map.has(key)) map.set(key, emptyUsageLeaf());
  addTotals(map.get(key), row);
}

function addTotals(target, row) {
  target.calls++;
  target[row.status === "error" ? "failedCalls" : "successfulCalls"]++;
  if (row.legacy) target.legacyCalls++;
  if (row.transportReported) { target.transportReportedCalls++; target.transportAttempts += row.transportAttempts; }
  if (row.durationReported) { target.durationReportedCalls++; target.durationMs += row.durationMs; }
  if (row.usageReported) target.usageReportedCalls++;
  for (const type of REPORTED) {
    if (!row[type + "Reported"]) continue;
    target[type + "ReportedCalls"]++;
    target[type + "Tokens"] += row[type + "Tokens"];
  }
  if (!row.cacheReported) return;
  target.cacheReportedCalls++;
  target.measuredPromptTokens += row.promptTokens;
  target.cachedTokens += row.cachedTokens;
  target.missTokens += row.missTokens;
  if (row.cachedTokens > 0) target.hitCalls++;
}

export function finalizeUsageLeaf(value) {
  return { ...value, hitRate: value.measuredPromptTokens > 0 ? value.cachedTokens / value.measuredPromptTokens : null,
    avgDurationMs: value.durationReportedCalls ? value.durationMs / value.durationReportedCalls : null };
}

export function tokenNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function safeIdentity(value, model = false) {
  if (typeof value !== "string" || !value || value.length > (model ? 96 : 64)) return "unknown";
  const pattern = model ? /^[a-z0-9][a-z0-9._:/+-]*$/i : /^[a-z][a-z0-9_-]*$/;
  return pattern.test(value) && !value.includes("://") && !/^(?:sk-|bearer|token|secret)/i.test(value) &&
    !/^[a-z]:\//i.test(value) && redactSensitiveText(value) === value ? value : "unknown";
}

function safePromptVersion(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}-v\d{1,4}$/.test(value) && !/^(?:sk-|token|secret)/i.test(value) ? value : "unknown";
}

function oneOf(value, values) { return values.includes(value) ? value : "unknown"; }
