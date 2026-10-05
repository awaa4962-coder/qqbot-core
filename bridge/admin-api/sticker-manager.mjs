// bridge/admin-api/sticker-manager.mjs - sanitized sticker catalog controls.
import { isDeepStrictEqual } from "node:util";
import { publicStickerEntry } from "../features/stickers/schema.mjs";
import { stickerCatalogAvailable } from "../features/stickers/catalog-store.mjs";

import {
  analyzePendingStickers,
  buildStickerCatalogSnapshot,
  cleanupTemporaryStickerFiles,
  deleteCapturedCloudFavorite,
  getStickerEntry,
  getStickerSettings,
  getStickerSyncStatus,
  getStickerReplyStatus,
  refreshStickerCapabilities,
  removeStickerEntry,
  simulateStickerSelection,
  syncStickerFavorites,
  updateStickerEntry,
  updateStickerSettings,
} from "../features/stickers/index.mjs";

const EDIT_ACTIONS = new Set(["settings", "update", "remove"]);

export function buildStickerManagerSnapshot() {
  const sync = getStickerSyncStatus();
  return {
    ...buildStickerCatalogSnapshot(),
    sync,
    capture: sync.capture,
    capabilities: sync.capabilities,
    replyStatus: getStickerReplyStatus(),
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
  if (!Object.hasOwn(ACTION_HANDLERS, action)) throw new Error("unknown sticker action");
  const handler = ACTION_HANDLERS[action];
  assertStickerEditCurrent(payload, action, options);
  try { return await handler(payload, options); }
  catch (error) {
    if (options.requireExpected && EDIT_ACTIONS.has(action) && !stickerCatalogAvailable()) throw unavailableCatalog(error);
    throw error;
  }
}

function unavailableCatalog(cause) {
  return Object.assign(new Error("表情目录暂不可用，保存结果未确认；请重新读取核实。", { cause }), { statusCode: 503 });
}

function assertStickerEditCurrent(payload, action, options) {
  if (!options.requireExpected || !EDIT_ACTIONS.has(action)) return;
  if (!stickerCatalogAvailable()) throw unavailableCatalog();
  const expected = payload.expected;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw Object.assign(new Error("请先读取表情目录再保存，旧值校验信息缺失。"), { statusCode: 400 });
  }
  const rawEntry = action === "settings" ? null : getStickerEntry(payload.id);
  const entry = rawEntry ? publicStickerEntry(rawEntry) : null;
  const current = action === "settings" ? getStickerSettings() : entry && {
    id: entry.id, description: entry.description, tags: entry.tags,
    allowedGroups: entry.allowedGroups, enabled: entry.enabled,
  };
  if (!isDeepStrictEqual(expected, current)) {
    throw Object.assign(new Error("表情内容已在别处更新，未覆盖本轮修改；请重新读取核对。"), { statusCode: 409 });
  }
}

const ACTION_HANDLERS = Object.freeze({
  refresh: async () => buildStickerManagerSnapshot(),
  sync: async (payload, options) => {
    const result = await (options.sync || syncStickerFavorites)({
      analyze: payload.analyze !== false,
      analysisLimit: boundedBatchSize(payload.analysisLimit),
      signal: options.signal,
    });
    return { result, snapshot: buildStickerManagerSnapshot() };
  },
  analyze: async (payload, options) => {
    const result = await (options.analyze || analyzePendingStickers)({
      limit: boundedBatchSize(payload.limit),
      signal: options.signal,
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
    try {
      assertStickerEditCurrent(payload, "remove", options);
      const current = getStickerEntry(entry.id);
      if (options.requireExpected && (!current || current.source !== entry.source || current.resId !== entry.resId || current.cloudManaged !== entry.cloudManaged)) {
        throw new Error("表情来源已改变");
      }
    }
    catch {
      throw Object.assign(new Error("收藏处理已返回，但本地表情内容已改变，未继续删除；请刷新核实。"), { statusCode: 409 });
    }
    const removed = removeStickerEntry(entry.id);
    return { removed: publicStickerEntry(removed), cloud: publicCloudRemovalResult(cloud), snapshot: buildStickerManagerSnapshot() };
  },
  simulate: async (payload, options) => {
    const result = await (options.simulate || simulateStickerSelection)({
      groupId: payload.groupId,
      userMessage: payload.userMessage,
      assistantText: payload.assistantText,
      contextMessages: [],
      private: payload.private === true,
    });
    const safeResult = { ...result, sticker: result.sticker ? publicStickerEntry(result.sticker) : null };
    return { result: safeResult, snapshot: buildStickerManagerSnapshot() };
  },
});

function publicCloudRemovalResult(cloud) {
  return { ok: cloud.ok === true, skipped: cloud.skipped === true,
    ...(cloud.reason === "not_bot_managed" ? { reason: "not_bot_managed" } : {}) };
}

function boundedBatchSize(value) {
  return Math.max(1, Math.min(4, Number(value || 4)));
}
