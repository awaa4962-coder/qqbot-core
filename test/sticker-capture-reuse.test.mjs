import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import sharp from "sharp";
import { CFG } from "../bridge/config.mjs";
import { perceptualImageHash } from "../bridge/knowledge/memes/image-context.mjs";
import {
  findStickerClassificationCandidate, flushStickerCatalogSync, forgetStickerSender,
  getStickerCatalog, getStickerEntry, getStickerSettings, resetStickerCatalogForTest,
  setStickerCatalogPath, stickerCatalogAvailable, updateStickerEntry, updateStickerSettings,
  upsertCapturedSticker,
} from "../bridge/features/stickers/catalog-store.mjs";
import {
  getStickerCaptureStatus, processCandidate, resetStickerCaptureForTest, stopStickerCapture,
} from "../bridge/features/stickers/capture-service.mjs";
import { invalidateUserMemoryGeneration } from "../bridge/memory-profile/generation.mjs";

const NOW = Date.parse("2026-10-05T00:00:00Z");
const GROUP = 50100;
const USER = 60100;
const OTHER_USER = 60101;
let root;
let filename;
let originalEnabled;
let originalGroups;
let image;
let differentImage;
let analysis;

before(async () => {
  image = { buffer: await png("red"), mimeType: "image/png" };
  differentImage = { buffer: await png("blue"), mimeType: "image/png" };
  analysis = {
    md5: md5(image.buffer), fingerprint: await perceptualImageHash(image.buffer),
    classification: "sticker", confidence: 0.95, description: "synthetic public reaction", tags: ["other"],
  };
  assert.equal(await perceptualImageHash(differentImage.buffer), analysis.fingerprint);
  assert.notEqual(md5(differentImage.buffer), analysis.md5);
});

beforeEach(t => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-reuse-"));
  filename = path.join(root, "catalog.json");
  setStickerCatalogPath(filename);
  originalEnabled = CFG.stickerEnabled;
  originalGroups = CFG.stickerGroupWhitelist;
  CFG.stickerEnabled = true;
  CFG.stickerGroupWhitelist = [];
  resetStickerCaptureForTest();
  updateStickerSettings({ mode: "steady", captureMode: "observe", allowedGroups: [GROUP] });
  t.mock.method(globalThis, "fetch", () => assert.fail("no network is allowed"));
});

afterEach(() => {
  resetStickerCaptureForTest();
  CFG.stickerEnabled = originalEnabled;
  CFG.stickerGroupWhitelist = originalGroups;
  setStickerCatalogPath(CFG.stickerCatalogFile);
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

test("exact downloaded MD5 and actual hash reuse classification and persist every occurrence", async t => {
  const original = seed();
  const hashes = countPerceptualHashes(t);
  const calls = counters();
  for (const userId of [USER, OTHER_USER]) {
    const result = await processCandidate(candidate(userId), fakeOptions(calls));
    assert.equal(result.ok, true);
    assert.equal(result.entry.id, original.id);
    assert.equal(result.entry.url, original.url);
    assert.equal(result.entry.description, analysis.description);
  }
  assert.deepEqual(calls, { downloads: 2, models: 0, clouds: 0 });
  assert.equal(hashes(), 2);
  assert.equal(getStickerCaptureStatus().classificationReused, 2);
  resetStickerCatalogForTest();
  const entry = getStickerEntry(original.id);
  assert.equal(entry.seenCount, 3);
  assert.equal(entry.distinctSenderCount, 2);
  assert.equal(entry.senderHashes.length, 2);
  assert.deepEqual(entry.sourceGroups, [GROUP]);
  assert.equal(entry.lastObservedAt, NOW + 1000);
  assert.equal(getStickerCatalog().stats.captureDuplicates, 2);
  assert.equal(getStickerCatalog().stats.captured, 1);
  resetStickerCaptureForTest();
  assert.equal(getStickerCaptureStatus().classificationReused, 0);
});

test("reused low-confidence classification keeps distinct-sender promotion and cloud receipt", async () => {
  updateStickerSettings({ captureMode: "auto", captureMinConfidence: 0.82, captureMinDistinctSenders: 2 });
  const original = seed({ confidence: 0.7 });
  const calls = counters();
  const options = fakeOptions(calls);
  options.addCloud = async (input, runtime) => {
    calls.clouds++;
    runtime.ensureAllowed();
    assert.equal(input.buffer, image.buffer);
    return { ok: true, created: true, md5: analysis.md5,
      item: { url: "https://example.com/cloud.png", resId: "fake-cloud" } };
  };
  const first = await processCandidate(candidate(), options);
  assert.equal(first.reason, "promotion_threshold");
  const second = await processCandidate(candidate(OTHER_USER), options);
  assert.equal(second.promoted, true);
  assert.deepEqual(calls, { downloads: 2, models: 0, clouds: 1 });
  assert.equal(second.entry.id, original.id);
  assert.equal(second.entry.captureState, "active");
  assert.equal(second.entry.cloudManaged, true);
  assert.equal(second.entry.resId, "fake-cloud");
  assert.equal(second.entry.seenCount, 3);
  assert.equal(second.entry.distinctSenderCount, 2);
});

test("a complete shared favorite is reused without replacing its identity or adding cloud ownership", async () => {
  const original = seed({ source: "qq-favorite", captureState: "favorite", resId: "personal-favorite" });
  updateStickerSettings({ captureMode: "auto" });
  const calls = counters();
  const result = await processCandidate(candidate(OTHER_USER), fakeOptions(calls));
  assert.equal(result.reason, "existing_favorite");
  assert.equal(result.entry.id, original.id);
  assert.equal(result.entry.resId, "personal-favorite");
  assert.equal(result.entry.cloudManaged, false);
  assert.equal(result.entry.seenCount, 2);
  assert.deepEqual(calls, { downloads: 1, models: 0, clouds: 0 });
});

test("cancellation after the verified live projection does not increment classification reuse", async () => {
  const original = seed();
  const calls = counters();
  revokeAfterReuseProjection(original.id, stopStickerCapture, 2);
  const result = await processCandidate(candidate(), fakeOptions(calls));
  assert.equal(result.reason, "capture_stopped");
  assert.deepEqual(calls, { downloads: 1, models: 0, clouds: 0 });
  assert.equal(getStickerCaptureStatus().classificationReused, 0);
  assert.equal(getStickerEntry(original.id).seenCount, 1);
});

test("candidate query is group-bound and returns only an independent unverified projection", () => {
  seed({ allowedGroups: [GROUP] });
  assert.equal(findStickerClassificationCandidate(analysis.md5), null);
  assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: 0 }), null);
  assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: GROUP + 1 }), null);
  assert.equal(findStickerClassificationCandidate("invalid", { groupId: GROUP }), null);
  const found = findStickerClassificationCandidate(analysis.md5, { groupId: GROUP });
  assert.deepEqual(Object.keys(found).sort(), ["classification", "confidence", "description", "fingerprint", "md5", "tags"]);
  found.tags.push("changed copy");
  assert.deepEqual(getStickerCatalog().entries[0].tags, analysis.tags);
});

test("an empty catalog reaches the original classifier with just one actual hash", async t => {
  const hashes = countPerceptualHashes(t);
  const calls = counters();
  const result = await processCandidate(candidate(), fakeOptions(calls));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, { downloads: 1, models: 1, clouds: 0 });
  assert.equal(hashes(), 1);
  assert.equal(getStickerCaptureStatus().classificationReused, 0);
});

test("matching perceptual hashes and claimed MD5 cannot reuse different downloaded bytes", async t => {
  const original = seed();
  const hashes = countPerceptualHashes(t);
  const calls = counters();
  const options = fakeOptions(calls);
  options.download = async () => {
    calls.downloads++;
    return { ...differentImage, md5: analysis.md5, fingerprint: analysis.fingerprint };
  };
  const result = await processCandidate({ ...candidate(), image: { ...candidate().image, md5: analysis.md5 } }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, { downloads: 1, models: 1, clouds: 0 });
  assert.equal(hashes(), 1);
  assert.notEqual(result.entry.id, original.id);
  assert.equal(result.entry.md5, md5(differentImage.buffer));
  assert.equal(getStickerEntry(original.id).seenCount, 1);
  assert.equal(getStickerCaptureStatus().classificationReused, 0);
});

for (const conflict of ["later hash conflict", "incomplete first MD5 target"]) {
  test(conflict + " cannot borrow classification from another MD5 duplicate", async () => {
    const original = seed(conflict === "incomplete first MD5 target" ? { description: "" } : {});
    getStickerCatalog().entries.push({ ...original, id: original.id + "_duplicate",
      description: analysis.description,
      fingerprint: conflict === "later hash conflict" ? "f".repeat(16) : analysis.fingerprint,
    });
    flushStickerCatalogSync();
    resetStickerCatalogForTest();
    assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: GROUP }), null);
    const calls = counters();
    const result = await processCandidate(candidate(OTHER_USER), fakeOptions(calls));
    assert.equal(result.entry.id, original.id);
    assert.deepEqual(calls, { downloads: 1, models: 1, clouds: 0 });
    assert.equal(getStickerEntry(original.id + "_duplicate").seenCount, 1);
    assert.equal(getStickerCaptureStatus().classificationReused, 0);
  });
}

const nonReusable = [
  ["same MD5 with conflicting hash", { fingerprint: "f".repeat(16) }, 2],
  ["missing stored hash", { fingerprint: "" }],
  ["disabled", { enabled: false }],
  ["retired but enabled", { captureState: "retired" }],
  ["different group allowlist", { allowedGroups: [GROUP + 1] }],
  ["unindexed", { indexed: false }],
  ["empty description", { description: "" }],
  ["missing description", { description: undefined }],
  ["blank description", { description: "   " }],
  ["missing tags", { tags: [] }],
  ["absent tags", { tags: undefined }],
  ["unknown classification", { classification: "unknown" }],
  ["missing classification", { classification: undefined }],
  ["missing confidence", { confidence: undefined }],
  ["zero confidence", { confidence: 0 }],
  ["non-finite confidence", { confidence: NaN }],
  ["non-shared source", { source: "private-capture" }],
];
for (const [label, patch, expectedHashes = 1] of nonReusable) {
  test(label + " still invokes the original classifier", async t => {
    seed(patch);
    const hashes = countPerceptualHashes(t);
    const calls = counters();
    const result = await processCandidate(candidate(OTHER_USER), fakeOptions(calls));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, { downloads: 1, models: 1, clouds: 0 });
    assert.equal(hashes(), expectedHashes);
    assert.equal(getStickerCatalog().stats.captureDuplicates, 1);
    assert.equal(getStickerCaptureStatus().classificationReused, 0);
  });
}

test("unknown entries cannot manufacture a certain sticker when fresh classification rejects it", async () => {
  const original = seed({ classification: "unknown" });
  const calls = counters();
  const options = fakeOptions(calls, { classification: "photo" });
  const result = await processCandidate(candidate(OTHER_USER), options);
  assert.equal(result.reason, "not_sticker");
  assert.equal(result.analysis.classification, "photo");
  assert.equal(calls.models, 1);
  assert.equal(calls.clouds, 0);
  assert.equal(getStickerEntry(original.id).classification, "unknown");
  assert.equal(getStickerEntry(original.id).seenCount, 1);
});

test("a cleared description is not resurrected by reuse", async () => {
  const original = seed();
  const calls = counters();
  const options = fakeOptions(calls, { classification: "unknown", description: "", confidence: 0.45 });
  options.download = async () => {
    calls.downloads++;
    updateStickerEntry(original.id, { description: "", tags: [] });
    return image;
  };
  const result = await processCandidate(candidate(OTHER_USER), options);
  assert.equal(result.ok, true);
  assert.equal(calls.models, 1);
  assert.equal(result.entry.description, "");
  assert.equal(result.entry.indexed, false);
  assert.equal(result.entry.classification, "unknown");
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /synthetic public reaction/);
});

test("a description cleared during actual hashing cannot be restored from the candidate projection", async t => {
  const original = seed();
  const calls = counters();
  let cleared = false;
  const hashes = countPerceptualHashes(t, () => {
    if (cleared) return;
    cleared = true;
    updateStickerEntry(original.id, { description: "", tags: [] });
  });
  const result = await processCandidate(candidate(OTHER_USER), fakeOptions(calls, {
    classification: "unknown", description: "", confidence: 0.45,
  }));
  assert.equal(result.ok, true);
  assert.equal(cleared, true);
  assert.equal(hashes(), 2);
  assert.equal(calls.models, 1);
  assert.equal(result.entry.description, "");
  assert.equal(result.entry.indexed, false);
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /synthetic public reaction/);
});

const changes = ["forget", "permission", "stop", "signal", "classifier-signal", "catalog"];
for (const stage of ["download", "reuse", "hash"]) {
  for (const change of changes) {
    test(change + " after " + stage + " blocks stale writes, classification and cloud requests", async t => {
      const original = seed();
      const calls = counters();
      const options = fakeOptions(calls);
      // A supplied settings snapshot must not bypass a later live permission change.
      options.settings = getStickerSettings();
      const controller = new globalThis.AbortController();
      if (change === "signal") options.signal = controller.signal;
      if (change === "classifier-signal") options.classifierOptions.signal = controller.signal;
      let changed = false;
      let afterChange;
      const revoke = () => {
        changed = true;
        revokeAtBoundary(change, original.id, controller, t);
        afterChange = fs.readFileSync(filename, "utf8");
      };
      if (stage === "download") {
        options.download = async () => { calls.downloads++; revoke(); return image; };
      } else if (stage === "hash") {
        countPerceptualHashes(t, revoke);
      } else {
        revokeAfterReuseProjection(original.id, revoke);
      }
      const result = await processCandidate(candidate(), options);
      assert.equal(changed, true, "the intended reuse boundary was reached");
      assert.equal(result.ok, false);
      assert.equal(result.reason, reasonFor(change));
      assert.deepEqual(calls, { downloads: 1, models: 0, clouds: 0 });
      assert.equal(getStickerEntry(original.id).seenCount, 1);
      assert.equal(getStickerCatalog().stats.captureDuplicates, 0);
      assert.equal(getStickerCaptureStatus().classificationReused, 0);
      assert.equal(fs.readFileSync(filename, "utf8"), afterChange);
      if (change === "forget") {
        const entry = getStickerEntry(original.id);
        assert.deepEqual(entry.senderHashes, []);
        assert.equal(entry.enabled, false);
        assert.equal(entry.captureState, "retired");
      }
    });
  }
}

for (const gate of ["global-off", "mode-off", "capture-off", "no-configured-groups", "private-scope", "corrupt-catalog"]) {
  test(gate + " cannot become a successful reuse or make external requests", async () => {
    seed();
    if (gate === "global-off") CFG.stickerEnabled = false;
    if (gate === "mode-off") updateStickerSettings({ mode: "off" });
    if (gate === "capture-off") updateStickerSettings({ captureMode: "off" });
    if (gate === "no-configured-groups") updateStickerSettings({ allowedGroups: [] });
    if (gate === "corrupt-catalog") {
      fs.writeFileSync(filename, "{broken");
      resetStickerCatalogForTest();
    }
    const snapshot = fs.readFileSync(filename, "utf8");
    const calls = counters();
    const input = gate === "private-scope" ? { ...candidate(), groupId: 0 } : candidate();
    const result = await processCandidate(input, fakeOptions(calls));
    assert.equal(result.ok, false);
    assert.deepEqual(calls, { downloads: 0, models: 0, clouds: 0 });
    assert.equal(fs.readFileSync(filename, "utf8"), snapshot);
    if (gate === "corrupt-catalog") {
      assert.equal(result.reason, "catalog_unavailable");
      assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: GROUP }), null);
    }
  });
}

test("an unreadable catalog cannot supply a reuse result", async () => {
  setStickerCatalogPath(root);
  const calls = counters();
  assert.equal(stickerCatalogAvailable(), false);
  assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: GROUP }), null);
  const result = await processCandidate(candidate(), fakeOptions(calls));
  assert.equal(result.reason, "catalog_unavailable");
  assert.deepEqual(calls, { downloads: 0, models: 0, clouds: 0 });
});

test("a failed occurrence write cannot report successful reuse or promote to cloud", async t => {
  seed();
  updateStickerSettings({ captureMode: "auto" });
  const snapshot = fs.readFileSync(filename, "utf8");
  failWrites(t);
  const calls = counters();
  const result = await processCandidate(candidate(), fakeOptions(calls));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "synthetic_catalog_write_failure");
  assert.deepEqual(calls, { downloads: 1, models: 0, clouds: 0 });
  assert.equal(stickerCatalogAvailable(), false);
  assert.equal(findStickerClassificationCandidate(analysis.md5, { groupId: GROUP }), null);
  assert.equal(fs.readFileSync(filename, "utf8"), snapshot);
});

const promotionChanges = ["observe", "confidence", "senders"];
for (const cached of [true, false]) {
  const kind = cached ? "cached" : "fresh";
  for (const change of promotionChanges) {
    for (const stage of ["download", "analysis"]) {
      test(kind + " capture keeps observations but blocks " + change + " promotion after " + stage, async () => {
        const fixture = promotionFixture(cached, change);
        const { options, original, calls } = fixture;
        let changed = false;
        const tighten = () => { changed = true; updateStickerSettings(tighterPromotionPolicy(change)); };
        if (stage === "download") {
          options.download = async () => { calls.downloads++; tighten(); return image; };
        } else if (cached) {
          revokeAfterReuseProjection(original.id, tighten, 2);
        } else {
          const classify = options.classifierOptions.classify;
          options.classifierOptions.classify = async (...args) => {
            const result = await classify(...args);
            tighten();
            return result;
          };
        }
        const result = await processCandidate(candidate(), options);
        assert.equal(changed, true);
        assert.equal(result.ok, true);
        assert.equal(result.promoted, false);
        assert.equal(result.reason, "promotion_threshold");
        assertObservedWithoutCloud(fixture, cached);
      });
    }

    for (const existingCloudItem of [true, false]) {
      test(kind + " " + change + " at cloud preflight blocks " + (existingCloudItem ? "existing receipt" : "new add"), async () => {
        const fixture = promotionFixture(cached, change);
        const { options, calls } = fixture;
        let details = 0;
        delete options.addCloud;
        options.cloudOptions = { tempDir: path.join(root, "uploads"), adapter: {
          details: async () => {
            details++;
            updateStickerSettings(tighterPromotionPolicy(change));
            return { ok: true, items: existingCloudItem ? [{
              md5: analysis.md5, url: "https://example.com/preexisting.png", resId: "fake-preexisting",
            }] : [] };
          },
          add: async () => { calls.clouds++; assert.fail("no cloud add after live policy tightened"); },
        } };
        const result = await processCandidate(candidate(), options);
        assert.equal(result.ok, false);
        assert.equal(result.promoted, false);
        assert.equal(result.reason, "promotion_threshold");
        assert.equal(details, 1, "only the already authorized preflight read occurred");
        assertObservedWithoutCloud(fixture, cached);
        assert.equal(fs.existsSync(options.cloudOptions.tempDir), false);
      });
    }

    test(kind + " injected " + change + " policy cannot be bypassed by permissive live auto", async () => {
      const fixture = promotionFixture(cached, change);
      Object.assign(fixture.options.settings, tighterPromotionPolicy(change));
      assert.equal(getStickerSettings().captureMode, "auto");
      const result = await processCandidate(candidate(), fixture.options);
      assert.equal(result.ok, true);
      assert.equal(result.promoted, false);
      assert.equal(result.reason, "promotion_threshold");
      assertObservedWithoutCloud(fixture, cached);
    });

    test(kind + " committed cloud add keeps its receipt after live " + change + " policy tightened", async () => {
      const fixture = promotionFixture(cached, change);
      const { options, calls } = fixture;
      let details = 0;
      delete options.addCloud;
      options.cloudOptions = { tempDir: path.join(root, "uploads"), adapter: {
        details: async () => { details++; assert.equal(details, 1); return { ok: true, items: [] }; },
        add: async () => {
          calls.clouds++;
          updateStickerSettings(tighterPromotionPolicy(change));
          return { ok: true };
        },
      } };
      const result = await processCandidate(candidate(), options);
      assert.equal(result.ok, true);
      assert.equal(result.promoted, true);
      assert.deepEqual(calls, { downloads: 1, models: cached ? 0 : 1, clouds: 1 });
      assert.equal(details, 1, "revoked policy prevents post-commit requests, not receipt recording");
      resetStickerCatalogForTest();
      const entry = getStickerEntry(result.entry.id);
      assert.equal(entry.captureState, "active");
      assert.equal(entry.cloudManaged, true);
      assert.equal(entry.cloudAddedAt, NOW + 1000);
      assert.equal(entry.md5, analysis.md5);
      assert.equal(entry.seenCount, cached ? 2 : 1);
      assert.equal(getStickerCatalog().stats.cloudAdded, 1);
      assert.deepEqual(fs.readdirSync(options.cloudOptions.tempDir), []);
    });
  }
}

test("live and injected policy intersection preserves each policy's original alternative promotion paths", async () => {
  updateStickerSettings({ captureMode: "auto", captureMinConfidence: 0.82, captureMinDistinctSenders: 5 });
  seed({ confidence: 0.9 });
  const calls = counters();
  const options = fakeOptions(calls);
  options.settings = { ...getStickerSettings(), captureMinConfidence: 0.99, captureMinDistinctSenders: 2 };
  options.addCloud = async (_input, runtime) => {
    runtime.ensureAllowed();
    calls.clouds++;
    return { ok: true, created: true, md5: analysis.md5 };
  };
  const result = await processCandidate(candidate(OTHER_USER), options);
  assert.equal(result.promoted, true);
  assert.deepEqual(calls, { downloads: 1, models: 0, clouds: 1 });
  assert.equal(result.entry.distinctSenderCount, 2);
});

function promotionFixture(cached, change) {
  const confidence = change === "senders" ? 0.7 : 0.9;
  updateStickerSettings({ captureMode: "auto", captureMinConfidence: 0.82,
    captureMinDistinctSenders: change === "senders" ? 1 : 10 });
  const original = cached ? seed({ confidence }) : null;
  const calls = counters();
  const options = fakeOptions(calls, { confidence });
  options.settings = getStickerSettings();
  return { original, calls, options };
}

function tighterPromotionPolicy(change) {
  return { observe: { captureMode: "observe" }, confidence: { captureMinConfidence: 0.99 },
    senders: { captureMinDistinctSenders: 3 } }[change];
}

function assertObservedWithoutCloud(fixture, cached) {
  assert.deepEqual(fixture.calls, { downloads: 1, models: cached ? 0 : 1, clouds: 0 });
  resetStickerCatalogForTest();
  const entry = getStickerCatalog().entries.find(item => item.md5 === analysis.md5);
  assert.equal(entry.seenCount, cached ? 2 : 1);
  assert.equal(entry.distinctSenderCount, 1);
  assert.equal(entry.captureState, "candidate");
  assert.equal(entry.cloudManaged, false);
  assert.equal(entry.cloudAddedAt, 0);
  assert.equal(getStickerCatalog().stats.cloudAdded, 0);
}

function seed(patch = {}) {
  const result = upsertCapturedSticker({ ...analysis, url: "https://example.com/canonical.png" }, {
    groupId: GROUP, senderId: USER, now: NOW,
  });
  Object.assign(getStickerCatalog().entries.find(entry => entry.id === result.entry.id), patch);
  flushStickerCatalogSync();
  resetStickerCatalogForTest();
  return getStickerEntry(result.entry.id);
}

function fakeOptions(calls, patch = {}) {
  return {
    now: NOW + 1000,
    download: async () => { calls.downloads++; return image; },
    classifierOptions: {
      classify: async () => { calls.models++; return { ...analysis, ...patch }; },
    },
    addCloud: async () => { calls.clouds++; assert.fail("unexpected cloud request"); },
  };
}

function counters() { return { downloads: 0, models: 0, clouds: 0 }; }
function candidate(userId = USER) {
  return { groupId: GROUP, userId, image: { url: "https://example.com/temporary.png" } };
}
function md5(buffer) { return crypto.createHash("md5").update(buffer).digest("hex"); }
function png(background) {
  return sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer();
}

function revokeAtBoundary(change, id, controller, t) {
  if (change === "forget") {
    invalidateUserMemoryGeneration(USER);
    forgetStickerSender(USER);
    assert.equal(getStickerEntry(id).enabled, false);
  } else if (change === "permission") {
    updateStickerSettings({ allowedGroups: [GROUP + 1] });
  } else if (change === "stop") {
    stopStickerCapture();
  } else if (change === "catalog") {
    failWrites(t);
    assert.throws(() => updateStickerSettings({}), /synthetic_catalog_write_failure/);
  } else {
    controller.abort(new Error("synthetic_capture_cancelled"));
  }
}

function reasonFor(change) {
  return ({ forget: "privacy_changed", permission: "group_not_allowed", stop: "capture_stopped",
    catalog: "catalog_unavailable" })[change] || "synthetic_capture_cancelled";
}

function revokeAfterReuseProjection(id, revoke, projection = 1) {
  const entry = getStickerCatalog().entries.find(item => item.id === id);
  const descriptor = Object.getOwnPropertyDescriptor(entry, "description");
  let reads = 0;
  // Each query checks the description twice, then reads it to build the projection.
  Object.defineProperty(entry, "description", { configurable: true, enumerable: true, get() {
    if (++reads === 3 * projection) {
      Object.defineProperty(entry, "description", descriptor);
      revoke();
    }
    return descriptor.value;
  } });
}

function failWrites(t) {
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args) => {
    if (args[1] === filename) throw new Error("synthetic_catalog_write_failure");
    return rename(...args);
  });
}

function countPerceptualHashes(t, onHash = () => {}) {
  const resize = sharp.prototype.resize;
  let count = 0;
  t.mock.method(sharp.prototype, "resize", function (width, height, ...rest) {
    if (width === 9 && height === 8) {
      count++;
      onHash();
    }
    return resize.call(this, width, height, ...rest);
  });
  return () => count;
}
