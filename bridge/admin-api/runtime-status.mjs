// bridge/admin-api/runtime-status.mjs - sanitized runtime status for local console.

import { CFG, LONG_GROUPS } from "../config.mjs";
import { getStormStatus } from "../logger.mjs";
import { getAdmissionStatus } from "../event-admission.mjs";
import { getPipelineStatus } from "../pipeline-state.mjs";
import { getCachedNapCatReadiness } from "../napcat-readiness.mjs";
import { getMemeStore } from "../knowledge/memes/index.mjs";
import { linkPreviewStatus } from "../services/link-preview/index.mjs";
import { users, groupChats } from "../storage.mjs";
import { VERSION, VERSION_NAME } from "../version.mjs";
import { getCognitionStatus } from "../cognition/index.mjs";
import { getImageContextCacheStatus } from "../knowledge/memes/image-context.mjs";
import { getStickerRuntimeStatus } from "../features/stickers/index.mjs";
import { getJmRuntimeHealth } from "../jm-provider.mjs";
import { readApiProviderHealth } from "../api-providers/health.mjs";

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
    admission: getAdmissionStatus(),
    pipeline: getPipelineStatus(),
    napcat: getCachedNapCatReadiness(),
  };
}

function buildRuntimeModules(now, memeStore) {
  const nowMs = now.getTime();
  return {
    commands: { enabled: true, health: "ready" },
    jm: buildJmModule(nowMs),
    groupSummary: buildGroupSummaryModule(),
    conversationSummary: buildWhitelistModule(CFG.conversationSummaryGroupWhitelist),
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
    apiProviders: readApiProviderHealth(),
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
    sevenZipConfigured: health.sevenZipReady,
  };
}

function buildGroupSummaryModule() {
  return {
    ...buildWhitelistModule(CFG.summaryGroupWhitelist),
    groups: CFG.summaryGroupWhitelist,
    scheduler: CFG.summaryScheduler,
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
    conversationSummaryGroupWhitelist: CFG.conversationSummaryGroupWhitelist,
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
