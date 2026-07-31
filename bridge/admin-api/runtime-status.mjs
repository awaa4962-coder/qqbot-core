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
import { getBundledSevenZipPath } from "../jm-provider.mjs";

export function buildRuntimeStatus(options = {}) {
  const now = options.now || new Date();
  const memory = process.memoryUsage();
  const memeStore = getMemeStore();
  return {
    status: "ok",
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
    config: {
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
    },
    modules: {
      jm: {
        enabled: true,
        python: CFG.jmPython ? "configured" : "missing",
        source: CFG.jmcomicSrc ? "configured" : "not_configured",
        domains: CFG.jmDomains.length,
        timeoutMs: CFG.jmTimeoutMs,
        zipPasswordConfigured: Boolean(CFG.jmZipPassword),
        sevenZipConfigured: Boolean(CFG.jmSevenZipPath || getBundledSevenZipPath()),
      },
      groupSummary: {
        enabled: true,
        groups: CFG.summaryGroupWhitelist,
      },
      relationship: {
        enabled: true,
        exportReserved: true,
      },
      memory: {
        enabled: true,
        legacyRefreshEnabled: CFG.legacyProfileRefreshEnabled,
      },
      cognition: getCognitionStatus({ now: now.getTime() }),
      imageContext: getImageContextCacheStatus({ now: now.getTime() }),
      linkPreview: linkPreviewStatus(),
      wordcloud: {
        enabled: true,
        groups: CFG.featureGroupWhitelist,
        maxMessages: CFG.wordcloudMaxMessages,
      },
      memeKnowledge: {
        enabled: true,
        mode: memeStore.mode || CFG.memeLearningMode,
        entries: Array.isArray(memeStore.entries) ? memeStore.entries.length : 0,
        webVerified: Array.isArray(memeStore.entries)
          ? memeStore.entries.filter(entry => entry.source === "web-verified").length
          : 0,
        autoUpdate: CFG.memeAutoUpdateEnabled,
        lastUpdateAt: String(memeStore.sync?.lastSuccessAt || ""),
        updateError: Boolean(memeStore.sync?.error),
      },
      stickers: getStickerRuntimeStatus(),
    },
    modelKeys: {
      mimo: Boolean(CFG.mimoKey),
      deepseek: Boolean(CFG.dsKey),
      tavily: Boolean(CFG.tavilyKey),
      doubao: Boolean(CFG.doubaoKey),
    },
    storm: getStormStatus(),
  };
}
