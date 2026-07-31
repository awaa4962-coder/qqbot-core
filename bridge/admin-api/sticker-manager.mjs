// bridge/admin-api/sticker-manager.mjs - sanitized sticker catalog controls.

import {
  analyzePendingStickers,
  buildStickerCatalogSnapshot,
  cleanupTemporaryStickerFiles,
  deleteCapturedCloudFavorite,
  getStickerEntry,
  getStickerSyncStatus,
  refreshStickerCapabilities,
  removeStickerEntry,
  simulateStickerSelection,
  syncStickerFavorites,
  updateStickerEntry,
  updateStickerSettings,
} from "../features/stickers/index.mjs";

export function buildStickerManagerSnapshot() {
  const sync = getStickerSyncStatus();
  return {
    ...buildStickerCatalogSnapshot(),
    sync,
    capture: sync.capture,
    capabilities: sync.capabilities,
    privacy: {
      storesImageFiles: false,
      exposesSendKeys: false,
      storesSenderIds: false,
      temporaryFiles: "QQ 上传完成后立即删除；异常残留会在启动时清理",
      source: "QQ 收藏表情",
    },
  };
}

export async function applyStickerManagerAction(payload = {}, options = {}) {
  const action = String(payload.action || "refresh").trim().toLowerCase();
  const handler = ACTION_HANDLERS[action];
  if (!handler) throw new Error("unknown sticker action");
  return await handler(payload, options);
}

const ACTION_HANDLERS = Object.freeze({
  refresh: async () => buildStickerManagerSnapshot(),
  sync: async (payload, options) => {
    const result = await (options.sync || syncStickerFavorites)({
      analyze: payload.analyze !== false,
      analysisLimit: boundedBatchSize(payload.analysisLimit),
    });
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
  analyze: async (payload, options) => {
    const result = await (options.analyze || analyzePendingStickers)({
      limit: boundedBatchSize(payload.limit),
    });
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
  capabilities: async (payload, options) => {
    const result = await (options.refreshCapabilities || refreshStickerCapabilities)();
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
  cleanup: async (payload, options) => {
    const result = await (options.cleanup || cleanupTemporaryStickerFiles)();
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
  settings: async payload => {
    const settings = updateStickerSettings(payload.settings || {});
    return { settings, snapshot: buildStickerManagerSnapshot() };
  },
  update: async payload => {
    const entry = updateStickerEntry(payload.id, payload.patch || {});
    return { entry, snapshot: buildStickerManagerSnapshot() };
  },
  remove: async (payload, options) => {
    const entry = getStickerEntry(payload.id);
    if (!entry) throw new Error("找不到这张表情");
    if (entry.source !== "group-capture") {
      throw new Error("个人 QQ 收藏只能在 QQ 内管理，控制台不会删除");
    }
    let cloud = { ok: true, skipped: true };
    if (entry.cloudManaged && entry.resId) {
      cloud = await (options.removeCloud || deleteCapturedCloudFavorite)(entry, options.cloudOptions);
      if (!cloud.ok) throw new Error(cloud.error || "QQ 云收藏删除失败");
    } else if (entry.resId) {
      cloud = { ok: true, skipped: true, reason: "not_bot_managed" };
    }
    const removed = removeStickerEntry(entry.id);
    return { removed, cloud, snapshot: buildStickerManagerSnapshot() };
  },
  simulate: async (payload, options) => {
    const result = await (options.simulate || simulateStickerSelection)({
      groupId: payload.groupId,
      userMessage: payload.userMessage,
      assistantText: payload.assistantText,
      contextMessages: [],
      private: payload.private === true,
    });
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
});

function boundedBatchSize(value) {
  return Math.max(1, Math.min(4, Number(value || 4)));
}
