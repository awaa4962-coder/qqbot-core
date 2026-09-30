import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { normalizeStickerSettings, normalizeStickerTags, normalizeNumberList } from "../bridge/features/stickers/schema.mjs";

const previewPixels = Buffer.alloc(32 * 32 * 3);
for (let index = 0; index < 32 * 32; index++) {
  const light = (Math.floor(index / 32 / 8) + Math.floor(index % 32 / 8)) % 2;
  previewPixels.set(light ? [245, 245, 245] : [30, 100, 160], index * 3);
}
export const UI_PREVIEW_PNG = await sharp(previewPixels, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();

export const UI_WIDTHS = [320, 390, 1440];
export const UI_ORIGIN = "http://p5-ui.test";
export const UI_EXPECTED = {
  capabilities: { notice: "#capabilityNotice", ready: "能力目录已刷新", denied: "无权读取能力目录", empty: "暂无能力记录" },
  configuration: { notice: "#configStatus", ready: "当前配置已载入", conflict: "别处更新", unknown: "结果未确认" },
  api: { notice: "#apiNotice", ready: "API 配置已读取", conflict: "409", failedTest: "API 操作失败" },
  usage: { notice: "#apiUsageNotice", empty: "无记录", failed: "读取失败" },
  memory: { notice: "#memoryNotice", ready: "记忆已刷新", conflict: "草稿已保留", unknown: "未能确认操作结果" },
  diagnostics: { notice: "#traceNotice", empty: "当前显示 0 条" },
  tasks: { notice: "#managedTaskNotice", unknown: "勿重复提交", cancelled: "已取消", overdue: "尚未确认停止" },
  summaries: { notice: "#summaryProgress", conflict: "草稿已保留", unknown: "结果未确认" },
};

const AT = Date.parse("2026-09-28T04:00:00Z");
const clone = value => JSON.parse(JSON.stringify(value));
const fieldNames = ["botNames", "groupWhitelist", "summaryGroupWhitelist", "resourceGroupWhitelist", "featureGroupWhitelist",
  "conversationSummaryGroupWhitelist", "stickerGroupWhitelist", "longGroups", "friendWhitelist", "jmUserWhitelist", "botBlacklist", "adminUins"];

export function uiFixtureData() {
  const config = { revision: "c".repeat(64), editable: Object.fromEntries(fieldNames.map(name => [name,
    name === "botNames" ? ["夜星"] : name === "friendWhitelist" ? ["1000000002"] : name === "jmUserWhitelist" ? ["1000000003"] :
      ["botBlacklist", "longGroups"].includes(name) ? [] : ["2000000001"]])),
    files: Object.fromEntries(fieldNames.map(name => [name, { writable: true, status: "editable" }])), pendingRestart: false, restartRequiredAfterSave: true };
  const provider = (id, name) => ({ id, name, model: `${id}-synthetic-model`, protocol: "openai-chat", endpoint: "https://synthetic.invalid/v1/chat/completions",
    enabled: true, keyConfigured: true, auth: "bearer", tokenField: "max_tokens", capabilities: ["text", "reasoning"], reasoningControl: { configurable: true }, presetId: "custom-openai-chat" });
  const api = { revision: 7, configurationRevision: "a".repeat(64), providers: [provider("mimo", "合成主模型"), provider("deepseek", "合成备用模型")],
    routes: { group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "deep" }, private_chat: { primary: "mimo", fallback: "deepseek", reasoning: "auto" } },
    tasks: [{ id: "group_chat", name: "群聊", protectedFallback: "deepseek" }, { id: "private_chat", name: "私聊" }],
    protocols: [{ id: "openai-chat", name: "OpenAI Chat" }], presets: [{ id: "custom-openai-chat", name: "合成兼容接口", protocol: "openai-chat", auth: "bearer", tokenField: "max_tokens", capabilities: ["text"] }],
    rollbackAvailable: true, configurationError: null };
  const leaf = { calls: 3, successfulCalls: 2, failedCalls: 1, transportAttempts: 4, transportReportedCalls: 3,
    usageReportedCalls: 3, promptReportedCalls: 3, completionReportedCalls: 3, reasoningReportedCalls: 1, totalReportedCalls: 3, cacheReportedCalls: 2,
    promptTokens: 600, completionTokens: 30, reasoningTokens: 0, totalTokens: 630, measuredPromptTokens: 400, cachedTokens: 100,
    durationMs: 2000, avgDurationMs: 2000 / 3, durationReportedCalls: 3 };
  const usage = { schema: 2, days: 7, since: AT - 7 * 86400000, now: AT, summary: leaf,
    rows: [{ ...leaf, model: "synthetic-model-" + "long".repeat(24), provider: "synthetic-provider", task: "group_chat", position: "primary",
      promptVersion: "p5-fixture-v1", promptFingerprint: "fixture-only", configuredMode: "deep", effectiveMode: "provider_default", reasoningControl: "none", reasoningApplied: "no" }],
    facets: { models: ["synthetic-model"], tasks: ["group_chat"], providers: ["synthetic-provider"], positions: ["primary"], promptVersions: ["p5-fixture-v1"], effectiveModes: ["provider_default"] },
    coverage: { complete: true, truncated: false, filesRead: 7, invalidRecords: 0, unreadableFiles: 0, rowsOmitted: 0 },
    localCaches: { imageDescription: { enabled: true, persistent: false, entries: 1, hits: 2, misses: 3 } } };
  const memory = { ok: true, groupId: "2000000001", userId: "1000000002", revision: "memory-v1",
    items: [{ id: "note-1", title: "合成待办", text: "合成测试记录", kind: "user_statement", recordType: "todo", status: "pending", state: "active",
      source: { kind: "user_command", at: AT, messageId: "synthetic-message" }, revision: 1, createdAt: AT, updatedAt: AT, expiresAt: AT + 30 * 86400000 }],
    preferences: { displayName: "合成用户", styleText: "简短回复" }, inferences: [], limits: { maxItems: 32, maxTextChars: 300, maxTitleChars: 32, ttlDays: 90 },
    semantics: { recordTypes: [{ id: "unclassified", label: "未分类", statuses: [{ id: "recorded", label: "已记录" }] },
      { id: "todo", label: "待办", statuses: [{ id: "pending", label: "待处理" }, { id: "done", label: "已完成" }, { id: "cancelled", label: "已取消" }] },
      { id: "event", label: "事件", statuses: [{ id: "recorded", label: "已记录" }] }] } };
  const summaryRevision = { id: "summary-v1", summary: "合成日报正文", createdAt: AT, provider: "synthetic", kind: "generated", evidence: [], document: { topics: [{ id: "topic-1", title: "合成讨论" }] } };
  const replay = { todayRuns: 0, dailyLimit: 3, cases: [{ id: "case-1", name: "合成样例", input: "合成问题", expectations: ["不虚构操作成功"], review: "unreviewed",
    packet: { messages: [{ role: "user", content: "合成问题" }], sources: [], fingerprint: "fixture" },
    candidate: { text: "合成候选", version: "fixture", provider: "synthetic", position: "primary", durationMs: 20, fingerprint: "fixture" } }] };
  return {
    status: { status: "ok", generatedAt: "2026-09-28T04:00:00Z", version: "1.4.39-fixture-only", config: { ...config.editable, listenPort: 3000, selfUin: "1000000001" },
      process: { pid: 123, rss: 10000000, uptime: 123 }, storage: { groups: 1, users: 2 }, modules: { cognition: { enabled: true, groupThreads: 1, privateThreads: 0 } }, storm: { processingCount: 0 } },
    config, api, usage, memory, replay,
    capabilities: { categories: [{ id: "chat", name: "对话", number: 1 }], capabilities: [
      { id: "chat", category: "chat", name: "聊天回复", summary: "合成能力", status: "available", statusLabel: "已配置", scopes: ["group", "private"], state: { installed: true, enabled: true, permitted: null, health: "configured" } },
      { id: "export", category: "chat", name: "导出", summary: "预留能力", status: "reserved", statusLabel: "预留", scopes: ["console"], state: { installed: true, enabled: false, permitted: false, health: "not_checked" } },
    ], agentTools: { tools: [
      { name: "recall_memory", label: "查自己的记忆", mode: "read", available: true, access: "current_scope" },
      { name: "read_bot_status", label: "查看机器人状态", mode: "read", available: true, access: "current_scope" },
      { name: "web_search", label: "搜索公开资料", mode: "read", available: true, access: "public_query" },
      { name: "calculate", label: "计算", mode: "read", available: true, access: "agent_group" },
      { name: "read_public_page", label: "读取公开原文", mode: "read", available: true, access: "agent_public_source" },
    ], limits: { modelRounds: 4, toolCalls: 4, durationMs: 90000, transportAttempts: 8 },
    rollout: { groups: ["2000000001"], mentionedOnly: true, privateEnabled: false }, compatibility: { status: "unknown" } } },
    summaries: { groupId: "2000000001", dateText: "2026-09-27", groups: ["2000000001"], revisions: [summaryRevision], jobs: [],
      coverage: { captured: 3, source: "retained-only" }, delivery: { status: "not_sent", revisionId: summaryRevision.id } },
    traces: { items: [{ id: "trace-1", scope: "group", groupId: "2000000001", userId: "1000000002", messageId: "message-1", at: AT, route: "group_at", status: "unknown", durationMs: 42,
      stages: [{ stage: "send", status: "failed", reason: "send_unknown", elapsedMs: 42 }] }], total: 1, capacity: 100, retentionHours: 24 },
    deliveries: { health: "ready", items: [{ id: "delivery-1", createdAt: AT, surface: "group", status: "unknown", confirmed: 1, uncertain: 1, active: false }], total: 1, stored: 1, capacity: 100, retentionHours: 24 },
    conversation: { tasks: [] }, stickers: { available: true, entries: [], settings: {
      mode: "steady", groupEnabled: true, privateEnabled: true, chance: 0.1, strongChance: 0.25, cooldownMs: 300000,
      allowedGroups: [2000000001], captureMode: "observe", captureDailyLimit: 20, captureCatalogLimit: 300,
      captureMinConfidence: 0.82, captureMinDistinctSenders: 2,
    }, counts: { total: 0, sendable: 0, candidates: 0 }, stats: {}, sync: {} },
    logs: { current: { lines: ["[INFO] synthetic UI fixture"] } }, memes: { available: true, entries: [], count: 0 },
  };
}

// All requests are intercepted. No server, production state, model API, or QQ connection is opened.
export async function installMockConsole(page) {
  const root = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
  const data = uiFixtureData();
  const calls = []; const unexpected = []; const errors = []; const dialogs = [];
  const faults = new Map(); const gates = new Map(); const jobs = new Map();
  let acceptConfirm = true; let jobMode = "done"; let sequence = 1;
  const keys = { "/admin/status": "status", "/admin/config": "config", "/admin/api-providers": "api", "/admin/api-usage": "usage", "/admin/memory": "memory",
    "/admin/summaries": "summaries", "/admin/diagnose/traces": "traces", "/admin/diagnose/replay": "replay", "/admin/diagnose/deliveries": "deliveries",
    "/admin/conversation-summaries": "conversation", "/admin/stickers": "stickers", "/admin/logs": "logs", "/admin/capabilities": "capabilities", "/admin/memes": "memes" };
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === "prompt" || !acceptConfirm) await dialog.dismiss(); else await dialog.accept();
  });
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== UI_ORIGIN) { unexpected.push(url.origin); await route.abort(); return; }
    if (url.pathname.startsWith("/console/")) {
      const name = url.pathname.slice(9) || "index.html";
      const filename = path.resolve(root, name);
      assert.ok(filename.startsWith(root) && !name.includes(".."), "fixture asset escaped Web root");
      await route.fulfill({ body: await fs.readFile(filename), contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" }); return;
    }
    const key = request.method() + " " + url.pathname;
    const payload = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), payload });
    if (gates.has(key)) await gates.get(key).promise;
    const fault = faults.get(key);
    if (fault) {
      if (fault.abort) { await route.abort("failed"); return; }
      await route.fulfill({ status: fault.status || 200, ...(fault.raw !== undefined ? { body: fault.raw, contentType: "text/html" } : { json: clone(fault.body ?? { error: "synthetic failure" }) }) }); return;
    }
    const respond = async (value, status = 200) => route.fulfill({ status, json: clone(value) });
    if (url.pathname === "/health") { await respond({ status: "ok", uptime: 123 }); return; }
    if (url.pathname === "/admin/stickers/image") {
      await route.fulfill({ status: 200, contentType: "image/png", body: UI_PREVIEW_PNG });
      return;
    }
    if (url.pathname === "/admin/tasks") {
      if (request.method() === "POST") {
        const id = `00000000-0000-0000-0000-${String(sequence++).padStart(12, "0")}`;
        const result = payload.module === "replay" ? data.replay : { ok: true, result: { ok: true, analyzed: 1 } };
        jobs.set(id, { id, module: payload.module, action: payload.payload.action, phase: jobMode === "result-false" || jobMode === "expired" ? "done" : jobMode,
          resultAvailable: jobMode !== "expired", result: jobMode === "result-false" ? { ok: false, error: "synthetic operation failure" } : result });
        await respond({ jobId: id, module: payload.module, phase: "queued" }, 202); return;
      }
      if (url.searchParams.has("id")) { await respond({ task: jobs.get(url.searchParams.get("id")) }); return; }
      await respond({ tasks: [...jobs.values()].map(job => ({ id: job.id, module: job.module, action: job.action, phase: job.phase, error: job.error || "" })) }); return;
    }
    const dataKey = keys[url.pathname];
    if (request.method() === "GET" && dataKey) { await respond(data[dataKey]); return; }
    if (request.method() === "POST" && url.pathname === "/admin/config") {
      if (payload.revision !== data.config.revision) { await respond({ error: "synthetic config conflict" }, 409); return; }
      data.config.editable = { ...data.config.editable, ...payload.editable }; data.config.revision = "d".repeat(64); data.config.pendingRestart = true;
      await respond({ ok: true, message: "配置已保存", revision: data.config.revision }); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/stickers") {
      const entry = data.stickers.entries.find(item => item.id === payload.id);
      const current = payload.action === "settings" ? data.stickers.settings : entry && {
        id: entry.id, description: entry.description, tags: entry.tags, allowedGroups: entry.allowedGroups, enabled: entry.enabled,
      };
      if (["settings", "update", "remove"].includes(payload.action) && !isDeepStrictEqual(payload.expected, current)) {
        await respond({ error: "synthetic sticker value conflict" }, 409); return;
      }
      if (payload.action === "settings") {
        data.stickers.settings = normalizeStickerSettings(payload.settings, data.stickers.settings);
        await respond({ settings: data.stickers.settings, snapshot: data.stickers }); return;
      }
      if (payload.action === "update") {
        Object.assign(entry, payload.patch, { description: String(payload.patch.description).trim().slice(0, 240),
          tags: normalizeStickerTags(payload.patch.tags), allowedGroups: normalizeNumberList(payload.patch.allowedGroups) });
        await respond({ entry, snapshot: data.stickers }); return;
      }
      if (payload.action === "remove") {
        data.stickers.entries = data.stickers.entries.filter(item => item.id !== payload.id);
        await respond({ removed: entry, cloud: { ok: true, skipped: true }, snapshot: data.stickers }); return;
      }
      await respond({ result: { action: "skip", reason: "synthetic no match" }, snapshot: data.stickers }); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/backups") {
      await respond({ schemaVersion: 1, mode: "safe-non-secret", name: "safe-synthetic", createdAt: new Date(AT).toISOString(), included: ["package.json"] }); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/api-providers") {
      if (payload.action === "test-provider") { await respond({ ok: true, durationMs: 10, output: "OK" }); return; }
      if (payload.configurationRevision !== data.api.configurationRevision) { await respond({ error: "synthetic API configuration conflict" }, 409); return; }
      if (payload.action === "save-routes") data.api.routes = payload.routes;
      if (payload.action === "save-provider") {
        const provider = Object.fromEntries(Object.entries(payload.provider).filter(([field]) => field !== "key"));
        data.api.providers = [...data.api.providers.filter(item => item.id !== provider.id), { ...provider, keyConfigured: true, reasoningControl: { configurable: true } }];
      }
      if (payload.action === "delete-provider") data.api.providers = data.api.providers.filter(item => item.id !== payload.providerId);
      data.api.revision++; data.api.configurationRevision = String(data.api.revision).padStart(64, "0");
      await respond({ ok: true, message: "合成 API 变更已保存", snapshot: data.api }); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/memory") {
      if (payload.revision !== data.memory.revision) { await respond({ error: "synthetic memory conflict" }, 409); return; }
      const index = data.memory.items.findIndex(item => item.id === payload.id);
      if (payload.action === "remove") data.memory.items = data.memory.items.filter(item => item.id !== payload.id);
      else if (payload.action === "create") data.memory.items.push({ ...data.memory.items[0], ...payload, id: "note-new", kind: "operator_note", state: "active" });
      else if (index >= 0) data.memory.items[index] = { ...data.memory.items[index], ...payload, kind: "operator_note" };
      data.memory.revision = "memory-v" + sequence++; await respond(data.memory); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/summaries") {
      if (payload.action === "save") {
        const id = "summary-v" + sequence++; data.summaries.revisions.push({ ...data.summaries.revisions.at(-1), id, summary: payload.summary, kind: "edited" });
        await respond({ revisionId: id, ...data.summaries }); return;
      }
      const id = "summary-job-" + sequence++;
      data.summaries.jobs.push({ id, phase: jobMode, action: payload.action }); await respond({ jobId: id }); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/diagnose/deliveries") {
      const item = data.deliveries.items.find(entry => entry.id === payload.id);
      if (item) { item.status = "resolved"; item.resolution = payload.action === "confirm-delivered" ? "checked_delivered" : "checked_not_delivered"; }
      await respond(data.deliveries); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/diagnose/replay") {
      if (payload.action === "check") { await respond({ checks: [{ name: "synthetic boundary", ok: true }] }); return; }
      const item = data.replay.cases.find(entry => entry.id === payload.caseId);
      if (payload.action === "review" && item) item.review = payload.review;
      if (payload.action === "baseline" && item) item.baseline = item.candidate;
      await respond(data.replay); return;
    }
    if (request.method() === "POST" && url.pathname === "/admin/diagnose/reply") {
      await respond({ ok: true, dryRun: true, gates: { allowed: false, blockedReasons: ["合成群不在白名单"] }, replyPlan: { action: "blocked" }, safety: { sendsMessage: false, writesStorage: false, callsModel: false } }); return;
    }
    if (url.pathname === "/favicon.ico") { await route.fulfill({ status: 404, body: "" }); return; }
    unexpected.push(key); await respond({ error: "Unexpected fixture request" }, 500);
  });
  return {
    data, calls, errors, dialogs, unexpected,
    setFault(method, urlPath, value) { const key = method + " " + urlPath; if (value) faults.set(key, value); else faults.delete(key); },
    hold(method, urlPath) {
      let release; const promise = new Promise(resolve => { release = resolve; }); const key = method + " " + urlPath;
      gates.set(key, { promise, release }); return () => { gates.delete(key); release(); };
    },
    setConfirm(value) { acceptConfirm = value; }, setJobMode(value) { jobMode = value; },
    setJobPhase(id, phase, overrides = {}) { Object.assign(jobs.get(id), { phase, ...overrides }); },
    async open() { await page.goto(UI_ORIGIN + "/console/"); await page.waitForFunction(() => globalThis.document.getElementById("lastUpdated").textContent.includes("刷新")); },
    dispose() { for (const gate of gates.values()) gate.release(); gates.clear(); },
  };
}
