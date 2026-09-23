import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import test from "node:test";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-usage-dimensions-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: workspace, QQBOT_DATA_DIR: path.join(workspace, "data"), QQBOT_LOG_DIR: path.join(workspace, "logs") });
const { recordApiUsage, getApiUsageSnapshot, getUserCacheUsage, clearUserCacheUsage, buildUserCacheStatsText, buildUserUsageKey } = await import("../bridge/api-providers/usage-metrics.mjs");
const { usageDimensions } = await import("../bridge/api-providers/usage-aggregate.mjs");
const { beijingDate } = await import("../bridge/api-providers/usage-records.mjs");
const { callTaskApi } = await import("../bridge/api-providers/gateway.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { createTraceRecorder, withMessageTrace } = await import("../bridge/diagnostics/message-trace.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const salt = "synthetic-usage-salt-no-real-identities";
const options = () => ({ dir: fs.mkdtempSync(path.join(workspace, "metrics-")), salt, now: Date.now() });
const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 };
const dimensions = { provider: "mimo", model: "synthetic-model", task: "group_chat", position: "primary", promptVersion: "chat-v8",
  promptFingerprint: "abcdef0123456789", configuredMode: "auto", effectiveMode: "economy", reasoningControl: "mimo-toggle", reasoningApplied: "yes" };
const event = extra => ({ ...dimensions, userId: "60100", usage, durationMs: 10, ...extra });
const windowOptions = o => ({ ...o, now: o.now + 1000 });

test("actual models, prompt versions and applied reasoning produce separate immutable historical groups", () => {
  const o = options();
  for (const extra of [{}, { model: "synthetic-model-b" }, { promptVersion: "chat-v9" }, { effectiveMode: "deep" }, { position: "fallback" }]) {
    assert.equal(recordApiUsage(event({ ...extra, timestamp: o.now }), o), true);
  }
  const snapshot = getApiUsageSnapshot(windowOptions(o));
  assert.equal(snapshot.rows.length, 5); assert.equal(snapshot.summary.calls, 5);
  assert.equal(getApiUsageSnapshot({ ...windowOptions(o), model: "synthetic-model-b" }).summary.calls, 1);
  assert.ok(snapshot.facets.models.includes("synthetic-model-b"));
  assert.equal(getApiUsageSnapshot({ ...windowOptions(o), effectiveMode: "deep" }).rows[0].effectiveMode, "deep");
});

test("token-weighted cache rate excludes unreported cache rather than averaging percentages", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now, usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 100 } } }), o);
  recordApiUsage(event({ timestamp: o.now, usage: { prompt_tokens: 900, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }), o);
  recordApiUsage(event({ timestamp: o.now, usage: { prompt_tokens: 1000, completion_tokens: 0 } }), o);
  recordApiUsage(event({ timestamp: o.now, usage: {} }), o);
  const value = getApiUsageSnapshot(windowOptions(o)).summary;
  assert.equal(value.calls, 4); assert.equal(value.cacheReportedCalls, 2); assert.equal(value.promptReportedCalls, 3);
  assert.equal(value.measuredPromptTokens, 1000); assert.equal(value.promptTokens, 2000); assert.equal(value.hitRate, 0.1);
  assert.equal(value.reasoningReportedCalls, 0);
});

test("unknown and genuine zero retain different coverage through persistence and query", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now, model: "unknown-usage", usage: {} }), o);
  recordApiUsage(event({ timestamp: o.now, model: "zero-usage", usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 } }), o);
  const rows = getApiUsageSnapshot(windowOptions(o)).rows;
  assert.equal(rows.find(row => row.model === "unknown-usage").usageReportedCalls, 0);
  const zero = rows.find(row => row.model === "zero-usage");
  assert.equal(zero.promptReportedCalls, 1); assert.equal(zero.cacheReportedCalls, 1); assert.equal(zero.hitRate, null);
});

test("legacy records remain unknown model/version/mode and do not claim retry or reasoning measurements", () => {
  const o = options();
  const userKey = buildUserUsageKey("60100", o);
  fs.writeFileSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl"), JSON.stringify({ kind: "usage", timestamp: o.now, userKey,
    provider: "mimo", task: "group_chat", position: "primary", promptTokens: 100, completionTokens: 10, totalTokens: 110,
    cachedTokens: 60, missTokens: 40, cacheReported: true, reasoningTokens: 0, durationMs: 12 }) + "\n");
  const row = getApiUsageSnapshot(windowOptions(o)).rows[0];
  assert.equal(row.model, "unknown"); assert.equal(row.promptVersion, "unknown"); assert.equal(row.effectiveMode, "unknown");
  assert.equal(row.reasoningReportedCalls, 0); assert.equal(row.transportReportedCalls, 0); assert.equal(row.legacyCalls, 1);
  assert.equal(row.hitRate, 0.6);
});

test("anonymous admin projection contains no user identities, salt, raw content, endpoints or filesystem paths", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now, userId: "123456789", prompt: "PRIVATE_PROMPT", reasoning: "PRIVATE_REASONING", endpoint: "https://private.invalid" }), o);
  recordApiUsage(event({ timestamp: o.now, userId: "987654321", model: "sk-private-secret-material-v1", promptVersion: "PRIVATE_PROMPT" }), o);
  const text = JSON.stringify(getApiUsageSnapshot(windowOptions(o)));
  assert.doesNotMatch(text, /"(?:123456789|987654321)"|userKey|userId|PRIVATE_|private.invalid|private-secret|user-salt/);
  const record = fs.readFileSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl"), "utf8");
  assert.doesNotMatch(record, /"(?:123456789|987654321)"|PRIVATE_|private.invalid|private-secret/);
  assert.equal(getUserCacheUsage("123456789", windowOptions(o)).calls, 1);
  assert.equal(getUserCacheUsage("987654321", windowOptions(o)).calls, 1);
});

test("future timestamps are excluded and reset markers hide earlier personal records without erasing aggregate costs", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now - 100 }), o);
  assert.equal(clearUserCacheUsage("60100", o), true);
  recordApiUsage(event({ timestamp: o.now + 10 }), o);
  recordApiUsage(event({ timestamp: o.now + 10000 }), o);
  const user = getUserCacheUsage("60100", windowOptions(o));
  assert.equal(user.calls, 1);
  assert.equal(getApiUsageSnapshot(windowOptions(o)).summary.calls, 2);
});

test("incomplete reads cannot hide a forgotten-user reset and revive old personal totals", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now - 100 }), o);
  const file = path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl");
  fs.appendFileSync(file, "{broken-record\n");
  const user = getUserCacheUsage("60100", windowOptions(o));
  assert.equal(user.calls, 0); assert.equal(user.coverage.complete, false);
  assert.match(buildUserCacheStatsText("60100", windowOptions(o)), /无法完整读取/);
  const aggregate = getApiUsageSnapshot(windowOptions(o));
  assert.equal(aggregate.summary.calls, 1); assert.equal(aggregate.coverage.invalidRecords, 1);
});

test("a reset in a future day remains a privacy barrier after the wall clock moves backward", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now - 100 }), o);
  clearUserCacheUsage("60100", { ...o, now: o.now + 2 * 86400000 });
  const user = getUserCacheUsage("60100", windowOptions(o));
  assert.equal(user.calls, 0); assert.equal(user.coverage.futureReset, true); assert.equal(user.coverage.complete, false);
  assert.equal(getApiUsageSnapshot(windowOptions(o)).summary.calls, 1);
});

test("bounded files and corrupt salt fail closed without overwriting existing data", () => {
  const o = options();
  const file = path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl");
  const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, 17 * 1024 * 1024 + 1); fs.closeSync(fd);
  const snapshot = getApiUsageSnapshot(windowOptions(o));
  assert.equal(snapshot.coverage.truncated, true); assert.equal(snapshot.coverage.complete, false);
  assert.equal(recordApiUsage(event({ timestamp: o.now }), o), false);
  assert.equal(getApiUsageSnapshot(windowOptions(o)).coverage.writeFailuresSinceStart, 1);
  const other = options(); delete other.salt;
  fs.writeFileSync(path.join(other.dir, ".user-salt"), "broken");
  assert.equal(recordApiUsage(event({ timestamp: other.now }), other), false);
  assert.equal(fs.readFileSync(path.join(other.dir, ".user-salt"), "utf8"), "broken");
  assert.equal(getUserCacheUsage("60100", windowOptions(other)).coverage.complete, false);
});

test("a full usage journal cannot prevent a durable personal reset across process restart", () => {
  const o = options();
  const userKey = buildUserUsageKey("60100", o);
  const row = JSON.stringify({ kind: "usage", timestamp: o.now - 100, userKey, promptTokens: 10, completionTokens: 1 });
  const line = row + " ".repeat(4095 - Buffer.byteLength(row)) + "\n";
  fs.writeFileSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl"), line.repeat(4096));
  assert.equal(getUserCacheUsage("60100", windowOptions(o)).calls, 4096);
  assert.equal(clearUserCacheUsage("60100", o), true);
  const source = `import { getUserCacheUsage, getApiUsageSnapshot } from ${JSON.stringify(new URL("../bridge/api-providers/usage-metrics.mjs", import.meta.url).href)};
    const options = JSON.parse(process.argv[1]);
    const user = getUserCacheUsage("60100", options);
    if (user.calls !== 0 || !user.coverage.complete) process.exit(2);
    if (getApiUsageSnapshot(options).summary.calls !== 4096) process.exit(3);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(windowOptions(o))], { encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const size = fs.statSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl")).size;
  assert.ok(size > 16 * 1024 * 1024 && size < 16 * 1024 * 1024 + 4096);
  assert.equal(recordApiUsage(event({ timestamp: o.now + 1 }), o), false);
});

test("forget reports failure when the reserved reset capacity is exhausted", () => {
  const o = options();
  const file = path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl");
  const descriptor = fs.openSync(file, "w"); fs.ftruncateSync(descriptor, 17 * 1024 * 1024); fs.closeSync(descriptor);
  const users = { "60100": { chats: [{ text: "synthetic" }], preferences: {} } };
  const result = forgetUserData("60100", { users, groupChats: {}, cacheUsageOptions: o });
  assert.equal(result.ok, false); assert.match(result.text, /个人用量统计清除未能确认/);
  assert.deepEqual(users["60100"].chats, []);
  assert.equal(clearUserCacheUsage("60100", o), false);
});

test("a short append cannot swallow the next successful reset in its unterminated fragment", t => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now - 100 }), o);
  const original = fs.writeSync;
  const write = t.mock.method(fs, "writeSync", (descriptor, bytes) => original(descriptor, bytes.subarray(0, 20)));
  assert.equal(recordApiUsage(event({ timestamp: o.now - 50 }), o), false);
  write.mock.restore();
  assert.equal(clearUserCacheUsage("60100", o), true);
  const rows = fs.readFileSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl"), "utf8").split("\n").filter(Boolean);
  const reset = JSON.parse(rows.at(-1));
  assert.equal(reset.kind, "reset"); assert.equal(reset.userKey, buildUserUsageKey("60100", o));
  assert.equal(reset.timestamp, o.now);
  assert.throws(() => JSON.parse(rows[1]));
  const user = getUserCacheUsage("60100", windowOptions(o));
  assert.equal(user.calls, 0); assert.equal(user.coverage.complete, false);
});

test("malformed persisted metadata is isolated instead of breaking healthy aggregate records", () => {
  const o = options();
  recordApiUsage(event({ timestamp: o.now }), o);
  const bad = { kind: "usage", timestamp: o.now, userKey: "", promptFingerprint: { toString: null } };
  fs.appendFileSync(path.join(o.dir, "usage-" + beijingDate(o.now) + ".jsonl"), JSON.stringify(bad) + "\n");
  const result = getApiUsageSnapshot(windowOptions(o));
  assert.equal(result.summary.calls, 1); assert.equal(result.coverage.invalidRecords, 1);
  assert.equal(result.coverage.complete, false);
});

test("read-only empty queries do not create a salt or files", () => {
  const o = options(); delete o.salt;
  assert.equal(getUserCacheUsage("60100", o).calls, 0);
  assert.deepEqual(fs.readdirSync(o.dir), []);
});

test("prototype-looking identifiers remain ordinary dimensions and invalid filters reject", () => {
  const o = options();
  recordApiUsage(event({ provider: "constructor", task: "constructor", timestamp: o.now }), o);
  const result = getUserCacheUsage("60100", windowOptions(o));
  assert.equal(result.providers.constructor.calls, 1); assert.equal(Object.prototype.calls, undefined);
  assert.throws(() => getApiUsageSnapshot({ ...o, model: "https://private.invalid" }), /筛选参数无效/);
  assert.equal(usageDimensions({ model: "org/model-v1" }).model, "org/model-v1");
});

function configure(root, model = "mimo-unit-a", capabilities = ["text", "reasoning"]) {
  saveApiProvider({ id: "mimo", model, presetId: "custom-openai-chat", auth: "none", endpoint: "https://example.com/chat", capabilities }, { root });
  saveApiRoutes({ group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "auto" } }, { root });
}
const request = () => ({ messages: [{ role: "user", content: "hello" }], usageContext: { userId: "60100" },
  promptMetadata: { promptVersion: "chat-v8", promptFingerprint: "abcdef0123456789" }, retryDelayMs: 0 });

test("gateway records actual requested model, prompt version and applied task mode outside the wire", async t => {
  const root = fs.mkdtempSync(path.join(workspace, "api-")); const o = options(); configure(root);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ model: "unverified-upstream-label", choices: [{ message: { content: "正常回复" } }], usage }) };
  });
  await callTaskApi("group_chat", "primary", request(), { root, usageMetricsDir: o.dir, usageMetricsSalt: salt });
  configure(root, "mimo-unit-b");
  await callTaskApi("group_chat", "primary", { ...request(), messages: [{ role: "user", content: "分析这个问题" }] }, { root, usageMetricsDir: o.dir, usageMetricsSalt: salt });
  const rows = getApiUsageSnapshot({ ...o, now: Date.now() + 1000 }).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.model === "mimo-unit-a").effectiveMode, "economy");
  assert.equal(rows.find(row => row.model === "mimo-unit-b").effectiveMode, "deep");
  assert.ok(rows.every(row => row.promptVersion === "chat-v8" && row.configuredMode === "auto" && row.reasoningApplied === "yes"));
  assert.doesNotMatch(JSON.stringify(bodies), /promptMetadata|onUsageAttempt|usageIdentity|promptVersion/);
  assert.equal(bodies[0].thinking.type, "disabled"); assert.equal(bodies[1].thinking.type, "enabled");
});

test("a retried request records both physical attempts without treating unreported failure as zero cost", async t => {
  const root = fs.mkdtempSync(path.join(workspace, "retry-")); const o = options(); configure(root);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? { ok: false, status: 503, json: async () => ({ error: { message: "private body" } }) }
    : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "正常回复" } }], usage }) });
  const result = await callTaskApi("group_chat", "primary", request(), { root, usageMetricsDir: o.dir, usageMetricsSalt: salt });
  assert.equal(result.ok, true); assert.equal(calls, 2);
  const value = getApiUsageSnapshot({ ...o, now: Date.now() + 1000 }).summary;
  assert.equal(value.calls, 2); assert.equal(value.transportAttempts, 2); assert.equal(value.failedCalls, 1);
  assert.equal(value.usageReportedCalls, 1); assert.equal(value.cacheReportedCalls, 1); assert.equal(value.hitRate, 0.5);
});

test("forget during a direct non-chat API response removes late personal attribution but keeps anonymous cost", async t => {
  const root = fs.mkdtempSync(path.join(workspace, "forget-")); const o = options(); configure(root);
  t.mock.method(globalThis, "fetch", async () => {
    invalidateMemoryPrivacyGeneration();
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "正常回复" } }], usage }) };
  });
  await callTaskApi("group_chat", "primary", request(), { root, usageMetricsDir: o.dir, usageMetricsSalt: salt });
  assert.equal(getUserCacheUsage("60100", { ...o, now: Date.now() + 1000 }).calls, 0);
  assert.equal(getApiUsageSnapshot({ ...o, now: Date.now() + 1000 }).summary.calls, 1);
});

test("diagnostic metadata distinguishes unavailable cache and reasoning from reported zero", async t => {
  const root = fs.mkdtempSync(path.join(workspace, "trace-")); const o = options(); configure(root);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "正常回复" } }], usage: { prompt_tokens: 12, completion_tokens: 0 } }) }));
  const recorder = createTraceRecorder();
  await withMessageTrace({ message_type: "private", user_id: 60100 }, () => callTaskApi("group_chat", "primary", request(), { root, usageMetricsDir: o.dir, usageMetricsSalt: salt }), recorder);
  const finished = recorder.list().items[0].stages.find(stage => stage.stage === "model" && stage.httpStatus === 200);
  assert.equal(finished.cacheReported, false); assert.equal(finished.reasoningReported, false);
  assert.equal(finished.completionReported, true); assert.equal(finished.completionTokens, 0);
  assert.equal(finished.effectiveMode, "economy");
});

test("aggregate API is admin-authorized, read-only and rejects user/path filters", async () => {
  const o = options(); const previous = CFG.apiUsageDir; CFG.apiUsageDir = o.dir;
  recordApiUsage(event({ timestamp: o.now }), o);
  async function query(url, token = "test-admin") {
    let response;
    await handleAdminApiRequest({ method: "GET", url, headers: { "x-qqfriend-admin-token": token }, socket: { remoteAddress: "127.0.0.1" } }, {}, {
      pathname: "/admin/api-usage", url: new URL(url, "http://localhost"), requiredToken: "test-admin",
      sendJson(_res, status, body) { response = { status, body }; },
    });
    return response;
  }
  try {
    assert.equal((await query("/admin/api-usage?days=7", "wrong")).status, 403);
    assert.equal((await query("/admin/api-usage?userId=60100")).status, 400);
    assert.equal((await query("/admin/api-usage?dir=private")).status, 400);
    assert.equal((await query("/admin/api-usage?days=100")).status, 400);
    const accepted = await query("/admin/api-usage?days=7");
    assert.equal(accepted.status, 200); assert.equal(accepted.body.summary.calls, 1);
    assert.doesNotMatch(JSON.stringify(accepted.body), /userKey|60100|user-salt/);
  } finally { CFG.apiUsageDir = previous; }
});
