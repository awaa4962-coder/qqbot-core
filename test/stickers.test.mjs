import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setImmediate } from "node:timers";

import { CFG } from "../bridge/config.mjs";
import {
  applyStickerManagerAction,
  buildStickerManagerSnapshot,
} from "../bridge/admin-api/sticker-manager.mjs";
import {
  addBufferToCloudFavorites,
  applyStickerAnalysis,
  buildStickerCatalogSnapshot,
  createCandidateQueue,
  detectStickerCapabilities,
  evaluateStickerPolicy,
  markCapturedStickerCloudResult,
  maybeSendStickerAfterReply,
  normalizeFavoritePayload,
  observeGroupStickerCandidates,
  processCandidate,
  recordStickerCooldown,
  resetStickerCaptureForTest,
  resetStickerCatalogForTest,
  resetStickerPolicyForTest,
  resolveStickerAllowedGroups,
  selectSticker,
  sendStickerDecision,
  setStickerCatalogPath,
  updateStickerSettings,
  upsertCapturedSticker,
  upsertFavoriteStickers,
  withTemporaryStickerFile,
} from "../bridge/features/stickers/index.mjs";

const tempDirs = [];

afterEach(() => {
  setStickerCatalogPath(CFG.stickerCatalogFile);
  resetStickerCatalogForTest();
  resetStickerPolicyForTest();
  resetStickerCaptureForTest();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("收藏表情模块", () => {
  it("同步目录会落盘，并且不会向管理界面暴露发送 key", () => {
    const file = useTempCatalog();
    upsertFavoriteStickers([{
      url: "https://example.com/a.gif",
      emojiId: "emoji-a",
      packageId: "package-a",
      key: "secret-send-key",
    }], { now: 1000 });

    const snapshot = buildStickerManagerSnapshot();
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.entries[0].key, "configured");
    assert.equal(JSON.stringify(snapshot).includes("secret-send-key"), false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries[0].key, "secret-send-key");
  });

  it("重复 URL 不会创建第二条记录", () => {
    useTempCatalog();
    upsertFavoriteStickers(["https://example.com/a.gif"], { now: 1000 });
    const result = upsertFavoriteStickers(["https://example.com/a.gif"], { now: 2000 });

    assert.deepEqual(result, { added: 0, refreshed: 1, total: 1 });
  });

  it("相同图片指纹会合并成一个目录项", () => {
    useTempCatalog();
    upsertFavoriteStickers([
      "https://example.com/a.gif",
      "https://example.com/a-copy.gif",
    ], { now: 1000 });
    const [first, second] = buildStickerCatalogSnapshot().entries;
    applyStickerAnalysis(first.id, {
      fingerprint: "same-phash",
      description: "无语地看着对方",
      tags: ["无语"],
    }, { now: 2000 });
    applyStickerAnalysis(second.id, {
      fingerprint: "same-phash",
      description: "重复图片",
      tags: ["其他"],
    }, { now: 3000 });

    assert.equal(buildStickerCatalogSnapshot().counts.total, 1);
  });

  it("只在白名单范围和概率命中时允许发送，并执行冷却", () => {
    const settings = {
      mode: "steady",
      groupEnabled: true,
      privateEnabled: true,
      chance: 1,
      strongChance: 1,
      cooldownMs: 60000,
      allowedGroups: [123],
    };
    const context = {
      groupId: 123,
      userId: 456,
      userMessage: "哈哈哈",
      assistantText: "确实很好笑",
    };
    const first = evaluateStickerPolicy(context, { settings, now: 100000, random: () => 0 });
    assert.equal(first.ok, true);
    recordStickerCooldown(first.scopeKey, 100000);
    assert.equal(evaluateStickerPolicy(context, { settings, now: 120000, random: () => 0 }).reason, "冷却中");
    assert.equal(evaluateStickerPolicy({ ...context, groupId: 999 }, { settings, now: 200000, random: () => 0 }).reason, "群不在表情白名单");
  });

  it("先做本地语义召回，再接受模型从候选中选择", async () => {
    const entries = [{
      id: "funny",
      url: "https://example.com/funny.gif",
      description: "笑到停不下来",
      tags: ["搞笑"],
      enabled: true,
      indexed: true,
      allowedGroups: [],
      sendCount: 0,
    }];
    const result = await selectSticker({
      groupId: 123,
      userMessage: "哈哈哈笑死我了",
      assistantText: "我也绷不住了",
    }, {
      entries,
      model: async () => '{"selected":"funny"}',
    });

    assert.equal(result.action, "send");
    assert.equal(result.stickerId, "funny");
  });

  it("发送普通图片段时不会误用闪照", async () => {
    let call = null;
    const result = await sendStickerDecision({
      action: "send",
      sticker: {
        id: "plain",
        url: "https://example.com/plain.gif",
        description: "开心",
      },
    }, {
      groupId: 123,
      private: false,
    }, {
      sendGroup: async (groupId, message) => {
        call = { groupId, message };
        return { status: "ok", retcode: 0 };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(call.groupId, 123);
    assert.equal(call.message[0].type, "image");
    assert.equal("type" in call.message[0].data, false);
  });

  it("后置表情失败不会抛出到文字回复链路", async () => {
    const result = await maybeSendStickerAfterReply({
      groupId: 123,
      userId: 456,
      userMessage: "哈哈",
      assistantText: "确实",
    }, {
      policyOptions: {
        settings: {
          mode: "steady",
          groupEnabled: true,
          privateEnabled: true,
          chance: 1,
          strongChance: 1,
          cooldownMs: 0,
          allowedGroups: [123],
        },
        random: () => 0,
      },
      select: async () => {
        throw new Error("selection failed");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "error");
  });

  it("兼容 NapCat 字符串和对象两种收藏返回", () => {
    const normalized = normalizeFavoritePayload([
      "https://example.com/a.gif",
      {
        url: "https://example.com/b.gif",
        emoji_id: "b",
        emoji_package_id: "pkg",
        key: "key",
      },
    ]);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[1].emojiId, "b");
    assert.equal(normalized[1].packageId, "pkg");
  });

  it("采集目录只保存伪匿名发送者摘要，管理员快照不返回摘要", () => {
    useTempCatalog();
    upsertCapturedSticker({
      url: "https://example.com/capture-a.gif",
      fingerprint: "0123456789abcdef",
      classification: "sticker",
      confidence: 0.9,
    }, { groupId: 123, senderId: 456, now: 1000 });
    upsertCapturedSticker({
      url: "https://example.com/capture-b.gif",
      fingerprint: "0123456789abcdef",
      classification: "sticker",
      confidence: 0.9,
    }, { groupId: 123, senderId: 789, now: 2000 });

    const snapshot = buildStickerManagerSnapshot();
    assert.equal(snapshot.entries[0].distinctSenderCount, 2);
    assert.equal("senderHashes" in snapshot.entries[0], false);
    assert.equal(containsExactValue(snapshot, 456), false);
    assert.equal(containsExactValue(snapshot, 789), false);
    assert.equal(snapshot.privacy.storesSenderIds, false);
  });

  it("低置信候选在两名不同用户复用后才自动加入 QQ 云收藏", async () => {
    useTempCatalog();
    const settings = updateStickerSettings({
      captureMode: "auto",
      allowedGroups: [123],
      captureDailyLimit: 20,
      captureCatalogLimit: 300,
      captureMinConfidence: 0.82,
      captureMinDistinctSenders: 2,
    });
    const common = {
      settings,
      download: async () => ({ buffer: Buffer.from("candidate"), mimeType: "image/png" }),
      classify: async () => ({
        fingerprint: "1111111111111111",
        md5: "0123456789abcdef0123456789abcdef",
        classification: "sticker",
        confidence: 0.7,
        description: "看到离谱事情时使用",
        tags: ["吐槽"],
      }),
      now: 1000,
    };
    let cloudAdds = 0;
    const addCloud = async () => {
      cloudAdds++;
      return {
        ok: true,
        md5: "0123456789abcdef0123456789abcdef",
        item: {
          url: "https://example.com/cloud.gif",
          resId: "cloud-resource",
          md5: "0123456789abcdef0123456789abcdef",
        },
      };
    };

    const first = await processCandidate({
      groupId: 123,
      userId: 456,
      image: { url: "https://example.com/first.gif" },
    }, { ...common, addCloud });
    const second = await processCandidate({
      groupId: 123,
      userId: 789,
      image: { url: "https://example.com/second.gif" },
    }, { ...common, now: 2000, addCloud });

    assert.equal(first.promoted, false);
    assert.equal(second.promoted, true);
    assert.equal(cloudAdds, 1);
    assert.equal(buildStickerCatalogSnapshot().entries[0].captureState, "active");
  });

  it("群聊采集遵守白名单、关闭模式并忽略闪照", () => {
    useTempCatalog();
    const base = {
      group_id: 123,
      user_id: 456,
      imageSegments: [{ type: "image", url: "https://example.com/a.gif" }],
    };
    assert.equal(observeGroupStickerCandidates(base, {
      settings: { captureMode: "off", allowedGroups: [123] },
    }).reason, "capture_off");
    assert.equal(observeGroupStickerCandidates({ ...base, group_id: 999 }, {
      settings: { captureMode: "observe", allowedGroups: [123] },
    }).reason, "group_not_allowed");
    assert.equal(observeGroupStickerCandidates({
      ...base,
      imageSegments: [{ type: "flash", url: "https://example.com/a.gif" }],
    }, {
      settings: { captureMode: "observe", allowedGroups: [123] },
    }).accepted, 0);
  });

  it("采集群为空时与回复策略共用配置白名单", () => {
    const original = CFG.stickerGroupWhitelist.slice();
    CFG.stickerGroupWhitelist.splice(0, CFG.stickerGroupWhitelist.length, 123);
    try {
      assert.deepEqual(resolveStickerAllowedGroups({ allowedGroups: [] }), [123]);
    } finally {
      CFG.stickerGroupWhitelist.splice(0, CFG.stickerGroupWhitelist.length, ...original);
    }
  });

  it("候选队列限制容量并合并尚未处理的重复任务", async () => {
    const queue = createCandidateQueue({ maxSize: 1 });
    let release;
    const blocker = new Promise(resolve => { release = resolve; });
    assert.equal(queue.enqueue("a", async () => blocker).accepted, true);
    assert.equal(queue.enqueue("a", async () => {}).reason, "duplicate");
    assert.equal(queue.enqueue("b", async () => {}).reason, "queue_full");
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.status().completed, 1);
  });

  it("临时上传文件在成功和异常时都会立即删除", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-upload-"));
    tempDirs.push(dir);
    let successFile = "";
    await withTemporaryStickerFile({
      buffer: Buffer.from("success"),
      mimeType: "image/png",
    }, async file => {
      successFile = file.path;
      assert.equal(fs.existsSync(file.path), true);
    }, { tempDir: dir });
    assert.equal(fs.existsSync(successFile), false);

    let failureFile = "";
    await assert.rejects(withTemporaryStickerFile({
      buffer: Buffer.from("failure"),
      mimeType: "image/gif",
    }, async file => {
      failureFile = file.path;
      throw new Error("upload failed");
    }, { tempDir: dir }), /upload failed/);
    assert.equal(fs.existsSync(failureFile), false);
  });

  it("已存在的个人云收藏不会被标记为机器人创建", async () => {
    const existing = {
      url: "https://example.com/existing.gif",
      md5: "f4e0ac58eb46d88efc451c164db3b837",
      resId: "personal-resource",
    };
    let adds = 0;
    const result = await addBufferToCloudFavorites({
      buffer: Buffer.from("existing"),
      mimeType: "image/gif",
    }, {
      adapter: {
        add: async () => {
          adds++;
          return { ok: true };
        },
        details: async () => ({ ok: true, items: [existing] }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.created, false);
    assert.equal(adds, 0);
  });

  it("NapCat 详情接口可用时报告完整云收藏能力", async () => {
    const fetchImpl = async url => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).endsWith("/get_version_info")) {
          return {
            status: "ok",
            retcode: 0,
            data: { app_name: "NapCat", app_version: "4.18.13", protocol_version: "11" },
          };
        }
        return { status: "ok", retcode: 0, data: [] };
      },
    });
    const capabilities = await detectStickerCapabilities({ fetchImpl });
    assert.equal(capabilities.mode, "cloud");
    assert.equal(capabilities.add, true);
    assert.equal(capabilities.delete, true);
    assert.equal(capabilities.version.appVersion, "4.18.13");
  });

  it("管理员只能删除机器人采集项，不能删除个人 QQ 收藏", async () => {
    useTempCatalog();
    upsertFavoriteStickers(["https://example.com/personal.gif"], { now: 1000 });
    const personal = buildStickerCatalogSnapshot().entries[0];
    await assert.rejects(
      applyStickerManagerAction({ action: "remove", id: personal.id }),
      /个人 QQ 收藏/
    );

    const captured = upsertCapturedSticker({
      url: "https://example.com/captured.gif",
      fingerprint: "2222222222222222",
      classification: "sticker",
      confidence: 0.95,
    }, { groupId: 123, senderId: 456, now: 2000 }).entry;
    markCapturedStickerCloudResult(captured.id, {
      ok: true,
      created: true,
      md5: "0123456789abcdef0123456789abcdef",
      item: {
        url: captured.url,
        resId: "captured-resource",
        md5: "0123456789abcdef0123456789abcdef",
      },
    }, { now: 3000 });
    let cloudRemoved = "";
    const result = await applyStickerManagerAction({
      action: "remove",
      id: captured.id,
    }, {
      removeCloud: async entry => {
        cloudRemoved = entry.resId;
        return { ok: true };
      },
    });
    assert.equal(cloudRemoved, "captured-resource");
    assert.equal(result.snapshot.entries.some(entry => entry.id === captured.id), false);
    assert.equal(result.snapshot.entries.some(entry => entry.id === personal.id), true);
  });

  it("复用既有个人收藏的采集项只删本地记录，不删 QQ 云收藏", async () => {
    useTempCatalog();
    const captured = upsertCapturedSticker({
      url: "https://example.com/reused.gif",
      fingerprint: "3333333333333333",
      classification: "sticker",
      confidence: 0.95,
    }, { groupId: 123, senderId: 456, now: 2000 }).entry;
    markCapturedStickerCloudResult(captured.id, {
      ok: true,
      created: false,
      item: {
        url: captured.url,
        resId: "personal-resource",
        md5: "0123456789abcdef0123456789abcdef",
      },
    }, { now: 3000 });
    let removals = 0;
    const result = await applyStickerManagerAction({
      action: "remove",
      id: captured.id,
    }, {
      removeCloud: async () => {
        removals++;
        return { ok: true };
      },
    });

    assert.equal(removals, 0);
    assert.equal(result.cloud.reason, "not_bot_managed");
  });
});

function useTempCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-stickers-"));
  tempDirs.push(dir);
  const file = path.join(dir, "catalog.json");
  setStickerCatalogPath(file);
  return file;
}

function containsExactValue(value, expected) {
  if (value === expected || value === String(expected)) return true;
  if (Array.isArray(value)) return value.some(item => containsExactValue(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(item => containsExactValue(item, expected));
}
