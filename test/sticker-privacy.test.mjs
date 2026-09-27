import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import test, { after, beforeEach } from "node:test";
import sharp from "sharp";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-privacy-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const catalog = await import("../bridge/features/stickers/catalog-store.mjs");
const capture = await import("../bridge/features/stickers/capture-service.mjs");
const { analyzePendingStickers, analyzeStickerEntry } = await import("../bridge/features/stickers/analyzer.mjs");
const { classifyStickerCandidate } = await import("../bridge/features/stickers/image-classifier.mjs");
const { selectSticker } = await import("../bridge/features/stickers/selector.mjs");
const { maybeSendStickerAfterReply } = await import("../bridge/features/stickers/index.mjs");
const { syncStickerFavorites, getStickerSyncStatus } = await import("../bridge/features/stickers/sync-service.mjs");
const { createAdminTaskManager } = await import("../bridge/admin-api/task-manager.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
let number = 0;
let filename;
CFG.stickerEnabled = true;
const picture = { buffer: Buffer.from("fixture"), mimeType: "image/png" };
const analysis = { classification: "sticker", confidence: 0.99, description: "开心", tags: ["开心"], fingerprint: "1111111111111111", md5: "a".repeat(32) };
const candidate = (url = "https://example.com/fixture.png", uid = 60100) => ({ groupId: 50100, userId: uid, image: { url } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

beforeEach(t => {
  capture.resetStickerCaptureForTest();
  filename = path.join(root, "catalog-" + (++number) + ".json");
  catalog.setStickerCatalogPath(filename);
  catalog.updateStickerSettings({ mode: "steady", captureMode: "auto", allowedGroups: [50100] });
  t.mock.method(globalThis, "fetch", () => assert.fail("no network is allowed"));
});
after(() => {
  capture.resetStickerCaptureForTest();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function add(md5, senderId, options = {}) {
  return catalog.upsertCapturedSticker({ ...analysis, md5, url: "https://example.com/" + md5 }, { groupId: 50100, senderId, ...options }).entry;
}

test("forget removes sender links durably, retires sole auto captures, and keeps shared/manual favorites", () => {
  const sole = add("a".repeat(32), 60100);
  const shared = add("b".repeat(32), 60100); add("b".repeat(32), 60101);
  const manual = add("c".repeat(32), 60100); catalog.updateStickerEntry(manual.id, { description: "人工维护" });
  catalog.upsertFavoriteStickers([{ url: "https://example.com/favorite", md5: "d".repeat(32) }]);
  const favorite = add("d".repeat(32), 60100);
  const oldHash = catalog.getStickerEntry(sole.id).senderHashes[0];
  assert.equal(forgetUserData(60100).ok, true);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), new RegExp(oldHash));
  catalog.resetStickerCatalogForTest();
  assert.equal(catalog.getStickerEntry(sole.id).enabled, false);
  assert.equal(catalog.getStickerEntry(sole.id).captureState, "retired");
  assert.equal(catalog.getStickerEntry(shared.id).distinctSenderCount, 1);
  assert.equal(catalog.getStickerEntry(shared.id).enabled, true);
  assert.equal(catalog.getStickerEntry(manual.id).description, "人工维护");
  assert.equal(catalog.getStickerEntry(manual.id).enabled, true);
  assert.equal(catalog.getStickerEntry(favorite.id).source, "qq-favorite");
  assert.equal(catalog.getStickerEntry(favorite.id).enabled, true);
});

test("a failed association write reports unconfirmed and retries even after the hash left memory", t => {
  const entry = add("a".repeat(32), 60100);
  const hash = entry.senderHashes[0];
  const rename = fs.renameSync;
  const stub = t.mock.method(fs, "renameSync", (...args) => {
    if (args[1] === filename) throw new Error("synthetic write failure");
    return rename(...args);
  });
  assert.equal(forgetUserData(60100).ok, false);
  assert.match(fs.readFileSync(filename, "utf8"), new RegExp(hash));
  assert.equal(catalog.getStickerEntry(entry.id).senderHashes.length, 0);
  stub.mock.restore();
  assert.equal(forgetUserData(60100).ok, true);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), new RegExp(hash));
});

test("corrupt catalogs and lost identity salts are not overwritten or called successfully erased", () => {
  for (const raw of ["{broken", JSON.stringify({ entries: [{ id: "x", url: "https://example.com/x", senderHashes: ["old-hash"] }], identitySalt: "invalid" })]) {
    fs.writeFileSync(filename, raw);
    catalog.resetStickerCatalogForTest();
    assert.equal(catalog.buildStickerCatalogSnapshot().available, false);
    assert.equal(forgetUserData(60100).ok, false);
    assert.throws(() => catalog.updateStickerSettings({ mode: "off" }), /停止覆盖/);
    assert.deepEqual(catalog.listSelectableStickers(), []);
    assert.deepEqual(catalog.listPendingStickerAnalysis(), []);
    assert.equal(fs.readFileSync(filename, "utf8"), raw);
  }
});

test("lossy entry identity normalization cannot silently drop records during a privacy write", () => {
  for (const entry of [
    { id: "kept-id", url: "not-a-url" }, { url: "https://example.com/missing-id" },
    { id: "kept-id", url: "https://example.com/x", senderHashes: ["unknown-identity-format"] },
    { id: "x".repeat(81), url: "https://example.com/x" },
  ]) {
    const raw = JSON.stringify({ schemaVersion: 2, identitySalt: "f".repeat(64), entries: [entry] });
    fs.writeFileSync(filename, raw); catalog.resetStickerCatalogForTest();
    assert.equal(catalog.stickerCatalogAvailable(), false);
    assert.throws(() => catalog.forgetStickerSender(60100), /未确认/);
    assert.equal(fs.readFileSync(filename, "utf8"), raw);
  }
});

test("new observations obey the existing 80-association schema limit before persistence", () => {
  const first = add("a".repeat(32), 60100);
  const stored = catalog.getStickerCatalog().entries.find(item => item.id === first.id);
  stored.senderHashes = Array.from({ length: 80 }, (_, index) => String(index).padStart(24, "0"));
  stored.distinctSenderCount = 80;
  add("a".repeat(32), 99999);
  assert.equal(catalog.getStickerEntry(first.id).senderHashes.length, 80);
  catalog.resetStickerCatalogForTest();
  assert.equal(catalog.stickerCatalogAvailable(), true);
  assert.equal(catalog.getStickerEntry(first.id).distinctSenderCount, 80);
});

test("queued and downloading captures keep their pre-forget generation and do not restart classification", async () => {
  const gate = deferred();
  let downloads = 0; let classifications = 0;
  const options = { download: async () => { downloads++; await gate.promise; return picture; },
    classify: async () => { classifications++; return analysis; }, addCloud: async () => assert.fail("cloud add after forget") };
  const event = { group_id: 50100, user_id: 60100, images: ["https://example.com/one", "https://example.com/two"] };
  assert.equal(capture.observeGroupStickerCandidates(event, options).accepted, 2);
  assert.equal(downloads, 1);
  assert.equal(forgetUserData(60100).ok, true);
  gate.resolve();
  for (let i = 0; i < 50 && capture.getStickerCaptureStatus().queue.processing; i++) await setImmediate();
  assert.equal(capture.getStickerCaptureStatus().queue.processing, false);
  assert.equal(downloads, 1); assert.equal(classifications, 0);
  assert.equal(catalog.getStickerCatalog().entries.length, 0);
  catalog.updateStickerSettings({ captureMode: "observe" });
  assert.equal(capture.observeGroupStickerCandidates({ ...event, images: [event.images[0]] }, {
    download: async () => picture, classify: async () => analysis,
  }).accepted, 1, "a new post-forget event is not blocked by the old sender cache");
  for (let i = 0; i < 50 && capture.getStickerCaptureStatus().queue.processing; i++) await setImmediate();
  assert.equal(catalog.getStickerCatalog().entries.length, 1);
});

test("forget during classification prevents catalog insertion and cloud promotion", async () => {
  const result = await capture.processCandidate(candidate(), {
    download: async () => picture,
    classify: async () => { assert.equal(forgetUserData(60100).ok, true); return analysis; },
    addCloud: async () => assert.fail("no late cloud add"),
  });
  assert.equal(result.reason, "privacy_changed");
  assert.equal(catalog.getStickerCatalog().entries.length, 0);
});

test("already completed cloud side effects retain their receipt but cannot reactivate a forgotten capture", async () => {
  let adds = 0;
  const result = await capture.processCandidate(candidate(), {
    download: async () => picture, classify: async () => analysis,
    addCloud: async () => {
      adds++;
      assert.equal(forgetUserData(60100).ok, true);
      return { ok: true, created: true, md5: analysis.md5, item: { resId: "synthetic-cloud-receipt", url: "https://example.com/cloud" } };
    },
  });
  assert.equal(adds, 1);
  assert.equal(result.ok, false); assert.equal(result.reason, "privacy_changed");
  const entry = catalog.getStickerCatalog().entries[0];
  assert.equal(entry.resId, "synthetic-cloud-receipt");
  assert.equal(entry.cloudManaged, true);
  assert.equal(entry.enabled, false); assert.equal(entry.captureState, "retired");
  assert.deepEqual(entry.senderHashes, []);
  assert.equal(catalog.listSelectableStickers().length, 0);
});

test("late sticker selection cannot start fallback or return its old candidate details", async () => {
  let calls = 0;
  await assert.rejects(selectSticker({ userId: 60100, userMessage: "开心", assistantText: "开心" }, {
    entries: [{ id: "one", tags: ["开心"], description: "旧资料", sendCount: 0 }],
    model: async () => { calls++; invalidateMemoryPrivacyGeneration(); return ""; },
  }), { code: "STICKER_PRIVACY_CHANGED" });
  assert.equal(calls, 1);
});

test("outside chat ALS, a stale injected sticker decision cannot send or refresh favorites", async () => {
  const result = await maybeSendStickerAfterReply({ private: true, userId: 60100, userMessage: "开心", assistantText: "开心" }, {
    policyOptions: { settings: { mode: "steady", privateEnabled: true, chance: 1, strongChance: 1 }, random: () => 0 },
    select: async () => { invalidateMemoryPrivacyGeneration(); return { action: "send", stickerId: "old" }; },
    send: async () => assert.fail("no stale send"),
  });
  assert.equal(result.ok, false); assert.equal(result.reason, "privacy_changed");
});

test("analysis cancels after download and after description without writing a result or a retry failure", async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toBuffer();
  catalog.upsertFavoriteStickers(["https://example.com/first", "https://example.com/second"]);
  const before = fs.readFileSync(filename, "utf8");
  let descriptions = 0;
  const result = await analyzePendingStickers({ download: async () => ({ buffer: png, mimeType: "image/png" }),
    describe: async () => { descriptions++; invalidateMemoryPrivacyGeneration(); return { description: "OLD_RESULT", tags: ["开心"] }; } });
  assert.equal(result.cancelled, true); assert.equal(descriptions, 1);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  await assert.rejects(analyzeStickerEntry(catalog.getStickerCatalog().entries[0], {
    download: async () => { invalidateMemoryPrivacyGeneration(); return { buffer: png, mimeType: "image/png" }; },
    describe: async () => assert.fail("no vision after stale download"),
  }), { code: "STICKER_PRIVACY_CHANGED" });
});

test("classification never turns privacy cancellation into heuristic data or a fallback call", async () => {
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
  let calls = 0;
  await assert.rejects(classifyStickerCandidate({ buffer, mimeType: "image/png" }, {
    callSlot: async () => { calls++; invalidateMemoryPrivacyGeneration(); return { ok: false }; },
  }), { code: "STICKER_PRIVACY_CHANGED" });
  assert.equal(calls, 1);
});

test("cancelled analysis remains a failed admin task instead of a completed empty analysis", async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "green" } }).png().toBuffer();
  catalog.upsertFavoriteStickers(["https://example.com/admin-analysis"]);
  const manager = createAdminTaskManager({ filename: path.join(root, "admin-cancel.json"), handlers: {
    stickers: async () => ({ result: await analyzePendingStickers({
      download: async () => ({ buffer: png, mimeType: "image/png" }),
      describe: async () => { invalidateMemoryPrivacyGeneration(); return { description: "STALE_ADMIN_RESULT" }; },
    }) }),
  } });
  const job = manager.start({ module: "stickers", payload: { action: "analyze" } });
  await manager.wait();
  const state = manager.snapshot({ id: job.jobId }).task;
  assert.equal(state.phase, "failed");
  assert.equal(state.result.result.cancelled, true);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /STALE_ADMIN_RESULT/);
});

test("favorite sync distinguishes a successful catalog fetch from cancelled follow-up analysis", async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "gray" } }).png().toBuffer();
  const result = await syncStickerFavorites({ fetchFavorites: async () => ({ ok: true, items: [{ url: "https://example.com/sync" }] }),
    analyzerOptions: { download: async () => ({ buffer: png, mimeType: "image/png" }),
      describe: async () => { invalidateMemoryPrivacyGeneration(); return { description: "STALE_SYNC_RESULT" }; } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.analysis.cancelled, true);
  assert.equal(result.items, 1);
  assert.equal(getStickerSyncStatus().supported, true);
  assert.match(getStickerSyncStatus().lastError, /停止/);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /STALE_SYNC_RESULT/);
});
