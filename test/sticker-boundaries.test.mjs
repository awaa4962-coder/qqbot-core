import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import sharp from "sharp";
import { CFG } from "../bridge/config.mjs";
import {
  applyStickerAnalysis, getStickerCatalog, getStickerCaptureQuota, getStickerEntry,
  markCapturedStickerCloudResult, retireStaleCapturedStickers, setStickerCatalogPath,
  updateStickerEntry, updateStickerSettings, upsertCapturedSticker, upsertFavoriteStickers,
} from "../bridge/features/stickers/catalog-store.mjs";
import {
  observeGroupStickerCandidates, processCandidate, resetStickerCaptureForTest,
  stopStickerCapture,
} from "../bridge/features/stickers/capture-service.mjs";
import { addBufferToCloudFavorites } from "../bridge/features/stickers/cloud-favorites.mjs";
import { classifyStickerCandidate } from "../bridge/features/stickers/image-classifier.mjs";
import { maybeSendStickerAfterReply } from "../bridge/features/stickers/index.mjs";
import { withChatRun } from "../bridge/cognition/chat-run.mjs";
import { invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";

const NOW = Date.parse("2026-09-17T00:00:00Z");
let root;
let originalEnabled;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-boundaries-"));
  setStickerCatalogPath(path.join(root, "catalog.json"));
  originalEnabled = CFG.stickerEnabled;
  CFG.stickerEnabled = true;
  resetStickerCaptureForTest();
  updateStickerSettings({ mode: "steady", captureMode: "auto", allowedGroups: [123] });
});

afterEach(() => {
  resetStickerCaptureForTest();
  CFG.stickerEnabled = originalEnabled;
  setStickerCatalogPath(CFG.stickerCatalogFile);
  fs.rmSync(root, { recursive: true, force: true });
});

test("global sticker off blocks enqueue and direct workers before external calls", async () => {
  CFG.stickerEnabled = false;
  let downloads = 0;
  const options = { download: async () => { downloads++; throw new Error("unexpected download"); } };
  const observed = observeGroupStickerCandidates({
    group_id: 123, user_id: 456, images: ["https://example.com/off.png"],
  }, options);
  const result = await processCandidate(candidate(), options);
  assert.equal(observed.reason, "sticker_off");
  assert.equal(result.reason, "sticker_off");
  assert.equal(downloads, 0);
});

test("late chat sticker selection cannot send or refresh favorites after a privacy clear", async () => {
  let selections = 0;
  const result = await withChatRun({ surface: "private", userId: 456 }, () => maybeSendStickerAfterReply({
    private: true, userId: 456, userMessage: "hello", assistantText: "hello back",
  }, {
    policyOptions: { settings: { mode: "steady", privateEnabled: true, chance: 1 }, random: () => 0 },
    select: async () => {
      selections++;
      invalidateMemoryPrivacyGeneration();
      return { action: "send", stickerId: "synthetic" };
    },
    send: async () => assert.fail("a stale selection must not send"),
  }), { cfg: { ...CFG, friendWhitelist: [456], botBlacklist: [] } });
  assert.equal(selections, 1);
  assert.equal(result.kind, "cancelled");
});

test("workers recheck live settings between download, vision and cloud calls", async () => {
  for (const stage of ["download", "classify"]) {
    updateStickerSettings({ mode: "steady" });
    let classifications = 0;
    let cloudAdds = 0;
    const result = await processCandidate(candidate(), {
      now: NOW,
      download: async () => {
        if (stage === "download") updateStickerSettings({ mode: "off" });
        return { buffer: Buffer.from("synthetic"), mimeType: "image/png" };
      },
      classify: async () => {
        classifications++;
        updateStickerSettings({ mode: "off" });
        return capturedImage();
      },
      addCloud: async () => { cloudAdds++; return { ok: true }; },
    });
    assert.equal(result.reason, "sticker_off");
    assert.equal(classifications, stage === "download" ? 0 : 1);
    assert.equal(cloudAdds, 0);
  }
});

test("stopping capture invalidates an in-flight worker and clears queued jobs", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let downloads = 0;
  let classifications = 0;
  const options = {
    download: async () => { downloads++; await pending; return { buffer: Buffer.from("synthetic") }; },
    classify: async () => { classifications++; return capturedImage(); },
  };
  observeGroupStickerCandidates({
    group_id: 123, user_id: 456,
    images: ["https://example.com/first.png", "https://example.com/queued.png"],
  }, options);
  stopStickerCapture();
  release();
  await setImmediate();
  assert.equal(downloads, 1);
  assert.equal(classifications, 0);
});

test("cloud preflight cannot start an add after capture is disabled", async () => {
  let allowed = true;
  let adds = 0;
  await assert.rejects(addBufferToCloudFavorites({ buffer: Buffer.from("image") }, {
    tempDir: root,
    ensureAllowed: () => { if (!allowed) throw new Error("sticker_off"); },
    adapter: {
      details: async () => { allowed = false; return { ok: true, items: [] }; },
      add: async () => { adds++; return { ok: true }; },
    },
  }), /sticker_off/);
  assert.equal(adds, 0);
});

test("vision does not start its fallback provider after capture is disabled", async () => {
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } })
    .png().toBuffer();
  let allowed = true;
  const positions = [];
  await classifyStickerCandidate({ buffer, mimeType: "image/png" }, {
    ensureAllowed: () => { if (!allowed) throw new Error("sticker_off"); },
    callSlot: async (_task, position) => {
      positions.push(position);
      allowed = false;
      return { ok: false, error: "synthetic failure" };
    },
  });
  assert.deepEqual(positions, ["primary"]);
});

test("cloud add completion retains ownership without further requests after shutdown", async () => {
  let allowed = true;
  let details = 0;
  const result = await addBufferToCloudFavorites({
    buffer: Buffer.from("image"), url: "https://example.com/image.png",
  }, {
    tempDir: root,
    ensureAllowed: () => { if (!allowed) throw new Error("sticker_off"); },
    adapter: {
      details: async () => { details++; return { ok: true, items: [] }; },
      add: async () => { allowed = false; return { ok: true }; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.detailPending, true);
  assert.equal(details, 1);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith("sticker-")), false);
});

test("perceptually close images never replace a favorite or inherit its identity", () => {
  const first = capturedImage();
  upsertFavoriteStickers([{ ...first, url: "https://example.com/canonical.png", resId: "personal" }]);
  const favorite = getStickerCatalog().entries[0];
  applyStickerAnalysis(favorite.id, first);
  updateStickerEntry(favorite.id, { description: "manual meaning" });
  const different = upsertCapturedSticker({
    ...first, url: "https://example.com/different.png", fingerprint: "1111111111111110",
    md5: "22222222222222222222222222222222", description: "different meaning",
  }, { groupId: 123, senderId: 456 }).entry;
  assert.notEqual(different.id, favorite.id);
  assert.equal(getStickerEntry(favorite.id).url, "https://example.com/canonical.png");
  assert.equal(getStickerEntry(favorite.id).description, "manual meaning");
  assert.equal(different.resId, "");
  const exact = upsertCapturedSticker({ ...first, url: "https://example.com/temporary.png" }, {
    groupId: 123, senderId: 789,
  });
  assert.equal(exact.duplicate, true);
  assert.equal(exact.entry.url, "https://example.com/canonical.png");
});

test("analysis does not merge identical perceptual hashes with different bytes", () => {
  upsertFavoriteStickers(["https://example.com/a.png", "https://example.com/b.png"]);
  const [a, b] = getStickerCatalog().entries;
  applyStickerAnalysis(a.id, capturedImage());
  applyStickerAnalysis(b.id, { ...capturedImage(), md5: "22222222222222222222222222222222" });
  assert.equal(getStickerCatalog().entries.length, 2);
});

test("analyzed content is not discarded into an unindexed MD5 duplicate", () => {
  upsertFavoriteStickers([
    "https://example.com/legacy.png",
    { url: "https://example.com/pending.png", md5: capturedImage().md5 },
  ]);
  const [legacy, pending] = getStickerCatalog().entries;
  applyStickerAnalysis(legacy.id, capturedImage());
  assert.equal(getStickerEntry(legacy.id).indexed, true);
  applyStickerAnalysis(pending.id, capturedImage());
  assert.equal(getStickerCatalog().entries.length, 1);
  assert.equal(getStickerEntry(legacy.id).description, "synthetic image");
  assert.equal(getStickerEntry(legacy.id).url, "https://example.com/legacy.png");
});

test("indexed candidates expire but active and manually curated entries survive candidate TTL", () => {
  const old = NOW - 8 * 86400000;
  const expired = upsertCapturedSticker(capturedImage(), { now: old }).entry;
  const active = upsertCapturedSticker(capturedImage("active"), { now: old }).entry;
  markCapturedStickerCloudResult(active.id, { ok: true, created: true }, { now: old });
  const manual = upsertCapturedSticker(capturedImage("manual"), { now: old }).entry;
  updateStickerEntry(manual.id, { description: "curated" });
  assert.equal(retireStaleCapturedStickers({ now: NOW }).retired, 1);
  assert.equal(getStickerEntry(expired.id).captureState, "retired");
  assert.equal(getStickerEntry(active.id).captureState, "active");
  assert.equal(getStickerEntry(manual.id).enabled, true);
});

test("full catalog blocks downloads and vision; expired candidates free capacity first", async () => {
  updateStickerSettings({ captureCatalogLimit: 1, captureMode: "observe" });
  upsertCapturedSticker(capturedImage(), { now: NOW });
  let calls = 0;
  const options = {
    now: NOW,
    download: async () => { calls++; return { buffer: Buffer.from("new") }; },
    classify: async () => { calls++; return capturedImage("new"); },
  };
  assert.equal((await processCandidate(candidate(), options)).reason, "catalog_limit");
  assert.equal(calls, 0);
  const next = await processCandidate(candidate(), { ...options, now: NOW + 8 * 86400000 });
  assert.equal(next.ok, true);
  assert.equal(calls, 2);
  assert.equal(getStickerCaptureQuota().capturedTotal, 1);
});

function candidate() {
  return { groupId: 123, userId: 456, image: { url: "https://example.com/candidate.png" } };
}

function capturedImage(id = "default") {
  return {
    url: "https://example.com/" + id + ".png", fingerprint: "1111111111111111",
    md5: crypto.createHash("md5").update(id).digest("hex"), classification: "sticker",
    description: "synthetic image", tags: ["other"], confidence: 0.95,
  };
}
