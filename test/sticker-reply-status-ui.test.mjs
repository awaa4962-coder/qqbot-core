import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runVmTestFile } from "./vm-test-runner.mjs";
import { consoleHarness } from "./p5-ui-harness.mjs";

const counts = { skipped: 2, selected: 3, shadow: 1, cancelled: 1, knownfailed: 4, unknown: 5, partial: 6, sent: 7 };
const snapshot = (overrides = {}) => ({
  entries: [{ id: "synthetic-sticker", description: "Synthetic sticker", tags: ["synthetic"],
    allowedGroups: [], enabled: true, sendable: true, source: "qq-favorite" }],
  settings: { mode: "steady", captureMode: "observe", groupEnabled: true, privateEnabled: false,
    chance: 0.5, strongChance: 0.5, cooldownMs: 300000, allowedGroups: [], captureDailyLimit: 20,
    captureCatalogLimit: 300, captureMinConfidence: 0.82, captureMinDistinctSenders: 2 },
  counts: { total: 1, sendable: 1 }, stats: { sent: 1, sendFailures: 0 },
  capture: { classificationReused: 9 },
  replyStatus: { scope: "process", counts: { ...counts }, last: { stage: "sent", reasonCode: "sent", physicalReceipt: "sent" } },
  ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));
async function setup() {
  const h = consoleHarness();
  const [api] = await h.imports(["pages/stickers.js"]);
  h.get("stickerFilter").value = "all";
  return { h, api };
}

if (!vm.SourceTextModule) {
  test("isolated sticker reply status UI tests", () => runVmTestFile(import.meta.url, { minTests: 9 }));
} else {
test("existing status text renders stage, Chinese reason and all eight process counters", async () => {
  const { h, api } = await setup();
  api.renderStickers(snapshot());
  const text = h.get("stickerStatus").textContent;
  assert.match(text, /\u6700\u8fd1\u540e\u7f6e\u8868\u60c5\uff1a\u5df2\u786e\u8ba4\u53d1\u9001 \u00b7 \u53d1\u9001\u5df2\u786e\u8ba4/);
  assert.match(text, /\u8df3\u8fc7 2 \u00b7 \u5df2\u9009 3 \u00b7 \u5f71\u5b50 1 \u00b7 \u53d6\u6d88 1/);
  assert.match(text, /\u5df2\u77e5\u5931\u8d25 4 \u00b7 \u7ed3\u679c\u672a\u77e5 5 \u00b7 \u90e8\u5206\u5df2\u53d1 6 \u00b7 \u5df2\u53d1 7/);
  assert.match(h.get("stickerCaptureStatus").textContent, /\u672c\u8fdb\u7a0b\u5206\u7c7b\u590d\u7528 9 \u6b21/);
  assert.equal(h.calls.length, 0);
});

test("selection reason codes have fixed Chinese labels rather than unknown reasons", async () => {
  const { api } = await setup();
  for (const reasonCode of ["selection_none", "selection_invalid", "selection_selected", "selection_failed"]) {
    const text = api.stickerReplyStatusText({ replyStatus: { counts, last: { stage: "skipped", reasonCode } } });
    assert.doesNotMatch(text, /\u672a\u77e5\u539f\u56e0/);
    assert.doesNotMatch(text, /selection_/);
  }
});

test("legacy or partial snapshots show unmeasured, never fabricated zero", async () => {
  const { api } = await setup();
  for (const input of [{}, { replyStatus: null }, { replyStatus: { last: null } }, { replyStatus: { counts: {} } }]) {
    const text = api.stickerReplyStatusText(input);
    assert.match(text, /\u6700\u8fd1\u540e\u7f6e\u8868\u60c5\uff1a\u672a\u7edf\u8ba1/);
    assert.match(text, /\u8df3\u8fc7 \u672a\u7edf\u8ba1/);
    assert.match(text, /\u5df2\u53d1 \u672a\u7edf\u8ba1/);
    assert.doesNotMatch(text, /\u8df3\u8fc7 0|\u5df2\u53d1 0/);
  }
});

test("valid process zero is distinct from unmeasured", async () => {
  const { api } = await setup();
  const text = api.stickerReplyStatusText({ replyStatus: { counts: Object.fromEntries(Object.keys(counts).map(key => [key, 0])), last: null } });
  assert.match(text, /\u8df3\u8fc7 0/);
  assert.match(text, /\u5df2\u53d1 0/);
  assert.match(text, /\u6700\u8fd1\u540e\u7f6e\u8868\u60c5\uff1a\u672a\u7edf\u8ba1/);
});

test("invalid counters are not coerced, printed or interpreted as zero", async () => {
  const { api } = await setup();
  const opaque = { toString() { assert.fail("invalid counters must not be stringified"); } };
  for (const invalid of [undefined, null, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "7", true, {}, [], opaque]) {
    const text = api.stickerReplyStatusText({ replyStatus: { counts: { ...counts, sent: invalid } } });
    assert.match(text, /\u5df2\u53d1 \u672a\u7edf\u8ba1/);
    assert.doesNotMatch(text, /NaN|Infinity|object Object/);
  }
});

test("unknown stage, reason, body, URL, key and receipt stay opaque", async () => {
  const { api } = await setup();
  const opaque = { toString() { assert.fail("opaque diagnostic fields must not be stringified"); } };
  for (const reason of ["PRIVATE_BODY https://private.invalid/123?key=secret", "__proto__", "constructor", opaque]) {
    const text = api.stickerReplyStatusText({ replyStatus: { counts, last: { stage: "__proto__", reasonCode: reason, physicalReceipt: "__proto__",
      body: "PRIVATE_BODY", stickerId: "PRIVATE_ID", key: "PRIVATE_KEY", candidates: ["PRIVATE_CANDIDATE"] } } });
    assert.match(text, /\u672a\u77e5\u9636\u6bb5 \u00b7 \u672a\u77e5\u539f\u56e0/);
    assert.doesNotMatch(text, /PRIVATE|https|secret|proto|constructor|object Object/);
  }
});

test("cancelled sent, partial and unknown receipts remain visible", async () => {
  const { api } = await setup();
  for (const [receipt, label] of [["sent", "\u5df2\u786e\u8ba4\u53d1\u9001"], ["partial", "\u90e8\u5206\u53d1\u9001\u5df2\u786e\u8ba4"], ["unknown", "\u6295\u9012\u672a\u786e\u8ba4"]]) {
    const text = api.stickerReplyStatusText({ replyStatus: { counts, last: {
      stage: "cancelled", reasonCode: "privacy_changed", physicalReceipt: receipt } } });
    assert.match(text, /\u53d6\u6d88 \u00b7 \u8d44\u6599\u5df2\u66f4\u65b0\uff0c\u65e7\u4efb\u52a1\u5df2\u505c\u6b62/);
    assert.ok(text.includes(label));
    assert.doesNotMatch(text, /\u672a\u53d1\u751f\u53d1\u9001/);
  }
});

test("mode off uses existing settings without inventing reply counters or exposing sync error bodies", async () => {
  const { h, api } = await setup();
  api.renderStickers(snapshot({ settings: { ...snapshot().settings, mode: "off" }, replyStatus: undefined,
    sync: { lastError: "PRIVATE_BODY https://private.invalid/" } }));
  const text = h.get("stickerStatus").textContent;
  assert.match(text, /\u6a21\u5f0f\uff1a\u5173\u95ed/);
  assert.match(text, /\u6700\u8fd1\u540e\u7f6e\u8868\u60c5\uff1a\u672a\u7edf\u8ba1/);
  assert.match(text, /\u6700\u8fd1\u540c\u6b65\u95ee\u9898\uff1a\u672a\u77e5\u539f\u56e0/);
  assert.doesNotMatch(text, /PRIVATE|https/);
  assert.equal(h.calls.length, 0);
});

test("reply-stat refresh preserves clean forms and creates no controls or host requests", async () => {
  const { h, api } = await setup();
  const initial = snapshot();
  api.renderStickers(initial);
  const settings = plain(api.stickerSettingsPayload());
  const entry = plain(api.stickerEntryPayload());
  const summary = h.get("stickerSummary").innerHTML;
  api.renderStickers(snapshot({ replyStatus: { counts: { ...counts, sent: 8 }, last: { stage: "sent", reasonCode: "sent", physicalReceipt: "sent" } } }));
  assert.deepEqual(plain(api.stickerSettingsPayload()), settings);
  assert.deepEqual(plain(api.stickerEntryPayload()), entry);
  assert.equal(h.get("stickerSummary").innerHTML, summary);
  assert.deepEqual(plain(api.updateStickerDirty()), { settings: false, entry: false });
  assert.equal(api.canWriteStickers("saveSticker"), true);
  assert.equal(h.calls.length, 0);
});

test("reply-stat refresh preserves unsaved settings and entry drafts", async () => {
  const { h, api } = await setup();
  api.renderStickers(snapshot());
  h.get("stickerChance").value = "37";
  h.get("stickerDescription").value = "Unsaved description";
  const settings = plain(api.stickerSettingsPayload());
  const entry = plain(api.stickerEntryPayload());
  api.renderStickers(snapshot({ replyStatus: { counts, last: { stage: "unknown", reasonCode: "send_unknown", physicalReceipt: "unknown" } },
    settings: { ...snapshot().settings, chance: 0.1 },
    entries: [{ ...snapshot().entries[0], description: "External change" }] }));
  assert.deepEqual(plain(api.stickerSettingsPayload()), settings);
  assert.deepEqual(plain(api.stickerEntryPayload()), entry);
  assert.deepEqual(plain(api.updateStickerDirty()), { settings: true, entry: true });
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations.length, 0);
});
}
