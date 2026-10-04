import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runVmTestFile } from "./vm-test-runner.mjs";
import { consoleHarness } from "./p5-ui-harness.mjs";

const snapshot = (overrides = {}) => ({
  entries: [{ id: "synthetic-sticker", description: "Synthetic sticker", tags: ["synthetic"],
    allowedGroups: [], enabled: true, sendable: true, source: "qq-favorite" }],
  settings: { mode: "steady", captureMode: "observe", groupEnabled: true, privateEnabled: false,
    chance: 0.2, strongChance: 0.5, cooldownMs: 60000, allowedGroups: [], captureDailyLimit: 20,
    captureCatalogLimit: 300, captureMinConfidence: 0.82, captureMinDistinctSenders: 2 },
  counts: { total: 1, sendable: 1 }, stats: { sent: 1 },
  capture: { observed: 8, promoted: 2, rejected: 3, classificationReused: 4,
    queue: { queued: 1, maxSize: 24 }, quota: { todayAdded: 2, dailyLimit: 20, capturedTotal: 5, catalogLimit: 300 } },
  capabilities: { version: { appVersion: "synthetic-version" }, add: true, detail: true, delete: true },
  ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));
const reuseLabel = h => h.get("stickerCaptureStatus").textContent.split("\n").find(line => line.includes("分类复用"));

async function setup() {
  const h = consoleHarness();
  const [api] = await h.imports(["pages/stickers.js"]);
  h.get("stickerFilter").value = "all";
  return { h, api };
}

if (!vm.SourceTextModule) {
  test("isolated sticker cache status UI tests", () => {
    runVmTestFile(import.meta.url, { minTests: 6 });
  });
} else {
test("capture status displays nonnegative safe integer reuse counts in the existing text", async () => {
  const { h, api } = await setup();
  for (const count of [7, Number.MAX_SAFE_INTEGER]) {
    api.renderStickerCaptureStatus(snapshot({ capture: { ...snapshot().capture, classificationReused: count } }));
    assert.equal(reuseLabel(h), `本进程分类复用 ${count} 次`);
    assert.match(h.get("stickerCaptureStatus").textContent, /观察 8 张 · 已收录 2 张 · 已拒绝 3 张/);
    assert.match(h.get("stickerCaptureStatus").textContent, /队列 1\/24/);
    assert.equal(h.get("stickerCaptureCapability").textContent, "NapCat synthetic-version · QQ 云收藏可用");
  }
  assert.equal(h.calls.length, 0);
});

test("a real zero reuse count is displayed as zero rather than unmeasured", async () => {
  const { h, api } = await setup();
  api.renderStickerCaptureStatus(snapshot({ capture: { classificationReused: 0 } }));
  assert.equal(reuseLabel(h), "本进程分类复用 0 次");
  assert.equal(h.calls.length, 0);
});

test("legacy snapshots with a missing counter or capture object display unmeasured", async () => {
  const { h, api } = await setup();
  for (const input of [snapshot({ capture: { observed: 8 } }), snapshot({ capture: undefined }), {}]) {
    api.renderStickerCaptureStatus(input);
    assert.equal(reuseLabel(h), "分类复用：未统计");
  }
  api.renderStickerCaptureStatus(snapshot({ capture: undefined, sync: { capture: { classificationReused: 2 } } }));
  assert.equal(reuseLabel(h), "本进程分类复用 2 次");
  assert.equal(h.calls.length, 0);
});

test("invalid reuse counters are not coerced or echoed into public status", async () => {
  const { h, api } = await setup();
  const opaque = { toString() { assert.fail("an invalid counter must not be stringified"); } };
  for (const invalid of [null, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", "not-a-counter", true, {}, [], opaque]) {
    api.renderStickerCaptureStatus(snapshot({ capture: { classificationReused: invalid } }));
    assert.equal(reuseLabel(h), "分类复用：未统计");
    assert.doesNotMatch(h.get("stickerCaptureStatus").textContent, /NaN|Infinity|not-a-counter|\[object Object\]/);
  }
  assert.equal(h.calls.length, 0);
});

test("refreshing only reuse statistics preserves clean settings, entry payloads and controls", async () => {
  const { h, api } = await setup();
  const initial = snapshot();
  const original = JSON.stringify(initial);
  api.renderStickers(initial);
  const settings = plain(api.stickerSettingsPayload());
  const entry = plain(api.stickerEntryPayload());
  const writable = api.canWriteStickers("saveSticker");
  const disabled = h.get("stickerChance").disabled;
  api.renderStickers(snapshot({ capture: { ...initial.capture, classificationReused: 9 } }));
  assert.equal(reuseLabel(h), "本进程分类复用 9 次");
  assert.deepEqual(plain(api.stickerSettingsPayload()), settings);
  assert.deepEqual(plain(api.stickerEntryPayload()), entry);
  assert.deepEqual(plain(api.updateStickerDirty()), { settings: false, entry: false });
  assert.equal(api.canWriteStickers("saveSticker"), writable);
  assert.equal(h.get("stickerChance").disabled, disabled);
  assert.equal(JSON.stringify(initial), original);
  assert.equal(h.calls.length, 0);
});

test("background reuse refresh preserves unsaved settings and entry drafts without writes", async () => {
  const { h, api } = await setup();
  const initial = snapshot();
  api.renderStickers(initial);
  h.get("stickerChance").value = "37";
  h.get("stickerCaptureDailyLimit").value = "11";
  h.get("stickerPrivateEnabled").checked = true;
  h.get("stickerDescription").value = "Unsaved description";
  const settings = plain(api.stickerSettingsPayload());
  const entry = plain(api.stickerEntryPayload());
  api.renderStickers(snapshot({ capture: { ...initial.capture, classificationReused: 12 },
    settings: { ...initial.settings, mode: "off", captureMode: "auto", chance: 0.9, captureDailyLimit: 99 },
    entries: [{ ...initial.entries[0], description: "External change" }] }));
  assert.equal(reuseLabel(h), "本进程分类复用 12 次");
  assert.deepEqual(plain(api.stickerSettingsPayload()), settings);
  assert.deepEqual(plain(api.stickerEntryPayload()), entry);
  assert.deepEqual(plain(api.updateStickerDirty()), { settings: true, entry: true });
  assert.equal(api.canWriteStickers("saveSticker"), true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations.length, 0);
});
}
