// bridge/admin-api/runtime-status.mjs - sanitized runtime status for local console.

import { CFG, LONG_GROUPS } from "../config.mjs";
import { getStormStatus } from "../logger.mjs";
import { getMemeStore } from "../knowledge/memes/index.mjs";
import { linkPreviewStatus } from "../services/link-preview/index.mjs";
import { users, groupChats } from "../storage.mjs";
import { VERSION, VERSION_NAME } from "../version.mjs";
import { getCognitionStatus } from "../cognition/index.mjs";
import { getImageContextCacheStatus } from "../knowledge/memes/image-context.mjs";
import { getStickerRuntimeStatus } from "../features/stickers/index.mjs";
import { getBundledSevenZipPath, getJmRuntimeHealth } from "../jm-provider.mjs";
import { loadApiConfig, readProviderSecret } from "../api-providers/store.mjs";

export function buildRuntimeStatus(options = {}) {
  const now = options.now || new Date();
  const memory = process.memoryUsage();
  const memeStore = getMemeStore();
  const modules = buildRuntimeModules(now, memeStore);
  const moduleHealth = summarizeModuleHealth(modules);
  return {
    status: "ok",
    moduleHealth,
    generatedAt: now.toISOString(),
    version: VERSION,
    versionName: VERSION_NAME,
    process: {
      pid: process.pid,
      uptime: process.uptime(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    storage: {
      users: Object.keys(users).length,
      groups: Object.keys(groupChats).length,
    },
    config: buildConfigStatus(),
    modules,
    modelKeys: {
      mimo: Boolean(CFG.mimoKey),
      deepseek: Boolean(CFG.dsKey),
      tavily: Boolean(CFG.tavilyKey),
      doubao: Boolean(CFG.doubaoKey),
    },
    storm: getStormStatus(),
  };
}

function buildRuntimeModules(now, memeStore) {
  const nowMs = now.getTime();
  return {
    commands: { enabled: true, health: "ready" },
    jm: buildJmModule(nowMs),
    groupSummary: buildGroupSummaryModule(),
    relationship: { enabled: true, health: "ready", exportReserved: true },
    memory: {
      enabled: true,
      health: "ready",
      legacyRefreshEnabled: CFG.legacyProfileRefreshEnabled,
    },
    cognition: { ...getCognitionStatus({ now: nowMs }), health: "ready" },
    imageContext: { ...getImageContextCacheStatus({ now: nowMs }), health: "ready" },
    linkPreview: buildLinkPreviewModule(),
    wordcloud: buildWordcloudModule(),
    memeKnowledge: buildMemeKnowledgeModule(memeStore),
    resourceTransfer: buildWhitelistModule(CFG.resourceGroupWhitelist),
    apiProviders: buildApiProviderHealth(loadApiConfig()),
    stickers: getStickerRuntimeStatus(),
    outputSafety: { enabled: true, health: "ready" },
  };
}

function buildJmModule(now) {
  const health = getJmRuntimeHealth({ now });
  return {
    enabled: true,
    health: health.health,
    dependencyReady: health.dependencyReady,
    pythonReady: health.pythonReady,
    reason: health.reason,
    checkedAt: health.checkedAt,
    python: CFG.jmPython ? "configured" : "missing",
    source: health.source,
    domains: CFG.jmDomains.length,
    timeoutMs: CFG.jmTimeoutMs,
    zipPasswordConfigured: Boolean(CFG.jmZipPassword),
    sevenZipConfigured: Boolean(CFG.jmSevenZipPath || getBundledSevenZipPath()),
  };
}

function buildGroupSummaryModule() {
  return {
    ...buildWhitelistModule(CFG.summaryGroupWhitelist),
    groups: CFG.summaryGroupWhitelist,
    scheduler: "openclaw-cron",
  };
}

function buildLinkPreviewModule() {
  return {
    ...linkPreviewStatus(),
    enabled: CFG.linkPreviewEnabled,
    health: CFG.linkPreviewEnabled ? "ready" : "disabled",
  };
}

function buildWordcloudModule() {
  return {
    ...buildWhitelistModule(CFG.featureGroupWhitelist),
    groups: CFG.featureGroupWhitelist,
    maxMessages: CFG.wordcloudMaxMessages,
  };
}

function buildWhitelistModule(groups) {
  const enabled = groups.length > 0;
  return { enabled, health: enabled ? "ready" : "disabled" };
}

function buildMemeKnowledgeModule(memeStore) {
  const entries = Array.isArray(memeStore.entries) ? memeStore.entries : [];
  return {
    enabled: true,
    health: memeStore.sync?.error ? "degraded" : "ready",
    mode: memeStore.mode || CFG.memeLearningMode,
    entries: entries.length,
    webVerified: entries.filter(entry => entry.source === "web-verified").length,
    autoUpdate: CFG.memeAutoUpdateEnabled,
    lastUpdateAt: String(memeStore.sync?.lastSuccessAt || ""),
    updateError: Boolean(memeStore.sync?.error),
  };
}

function buildConfigStatus() {
  return {
    listenPort: CFG.listenPort,
    napcatApi: CFG.napcatApi,
    selfUin: CFG.selfUin,
    groupWhitelist: CFG.groupWhitelist,
    summaryGroupWhitelist: CFG.summaryGroupWhitelist,
    resourceGroupWhitelist: CFG.resourceGroupWhitelist,
    featureGroupWhitelist: CFG.featureGroupWhitelist,
    friendWhitelistCount: CFG.friendWhitelist.length,
    adminUins: CFG.adminUins,
    botNames: CFG.botNames,
    longGroups: LONG_GROUPS,
    linkPreviewEnabled: CFG.linkPreviewEnabled,
    legacyProfileRefreshEnabled: CFG.legacyProfileRefreshEnabled,
    stickerGroupWhitelist: CFG.stickerGroupWhitelist,
    stickerEnabled: CFG.stickerEnabled,
  };
}

function buildApiProviderHealth(config) {
  const issues = collectRouteIssues(config);
  issues.push(...collectVisionIssues(config));
  if (config.routes?.group_chat?.fallback !== "deepseek") issues.push("group_chat:fallback_not_protected");
  return {
    enabled: true,
    health: issues.length ? "degraded" : "ready",
    issues,
    routes: buildRouteSummary(config.routes),
  };
}

function collectRouteIssues(config) {
  const issues = [];
  for (const [task, route] of Object.entries(config.routes || {})) {
    collectProviderIssue(issues, config, task, "primary", route.primary);
    if (route.fallback) collectProviderIssue(issues, config, task, "fallback", route.fallback);
  }
  return issues;
}

function collectProviderIssue(issues, config, task, position, providerId) {
  const provider = config.providers?.[providerId];
  if (!provider?.enabled) {
    issues.push(task + ":" + position + "_unavailable");
    return;
  }
  if (provider.auth !== "none" && !readProviderSecret(provider)) {
    issues.push(task + ":" + position + "_credentials_missing");
  }
}

function collectVisionIssues(config) {
  const issues = [];
  const visionRoute = config.routes?.vision;
  for (const position of ["primary", "fallback"]) {
    const id = visionRoute?.[position];
    if (!id) continue;
    if (!config.providers?.[id]?.capabilities?.includes("vision")) issues.push("vision:" + position + "_not_multimodal");
  }
  return issues;
}

function buildRouteSummary(routes) {
  return Object.fromEntries(Object.entries(routes || {}).map(([task, route]) => [task, {
      primary: route.primary,
      fallback: route.fallback || null,
      reasoning: route.reasoning,
  }]));
}

function summarizeModuleHealth(modules) {
  const entries = Object.entries(modules);
  const degraded = entries.filter(([, module]) => module?.health === "degraded").map(([name]) => name);
  const disabled = entries.filter(([, module]) => module?.health === "disabled").map(([name]) => name);
  return {
    health: degraded.length ? "degraded" : "ready",
    degraded,
    disabled,
    ready: entries.length - degraded.length - disabled.length,
    total: entries.length,
  };
}
