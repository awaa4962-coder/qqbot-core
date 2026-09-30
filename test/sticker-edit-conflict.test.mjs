import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import test from "node:test";
import { URL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-edit-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const catalog = await import("../bridge/features/stickers/catalog-store.mjs");
const { applyStickerManagerAction, buildStickerManagerSnapshot } = await import("../bridge/admin-api/sticker-manager.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/index.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
let sequence = 0;
let filename;
test.beforeEach(t => {
  filename = path.join(root, "catalog-" + (++sequence) + ".json");
  catalog.setStickerCatalogPath(filename);
  catalog.updateStickerSettings({ mode: "steady", chance: 0.1 });
  t.mock.method(globalThis, "fetch", () => assert.fail("No network permitted"));
});
test.after(() => { cleanupLogger(); fs.rmSync(root, { recursive: true, force: true }); });

function favorite() {
  catalog.upsertFavoriteStickers([{ url: "https://fixture.invalid/favorite.png", resId: "synthetic-res-id", key: "synthetic-send-key" }]);
  return catalog.getStickerCatalog().entries[0].id;
}
function captured() {
  return catalog.upsertCapturedSticker({ url: "https://fixture.invalid/captured.png", description: "original",
    tags: ["fixture"], confidence: 0.99, md5: "a".repeat(32), fingerprint: "1".repeat(16) },
  { groupId: 50100, senderId: 60100 }).entry.id;
}
function editable(id) {
  const entry = catalog.getStickerEntry(id);
  return { id: entry.id, description: entry.description, tags: entry.tags, allowedGroups: entry.allowedGroups, enabled: entry.enabled };
}
const expectedGuard = { requireExpected: true };
const bytes = () => fs.readFileSync(filename, "utf8");

test("HTTP sticker mutation requires an original editable value and reports 409 without writing", async () => {
  async function post(payload) {
    const req = Readable.from([JSON.stringify(payload)]);
    Object.assign(req, { method: "POST", url: "/admin/stickers", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    let result;
    await handleAdminApiRequest(req, {}, { pathname: req.url, url: new URL("http://localhost" + req.url),
      root, requiredToken: "", sendJson(_res, status, value) { result = { status, value }; } });
    return result;
  }
  const before = bytes();
  assert.equal((await post({ action: "settings", settings: { mode: "off" } })).status, 400);
  assert.equal(bytes(), before);
  const old = catalog.getStickerSettings();
  catalog.updateStickerSettings({ chance: 0.4 });
  const changed = bytes();
  assert.equal((await post({ action: "settings", expected: old, settings: { mode: "off" } })).status, 409);
  assert.equal(bytes(), changed);
  const result = await post({ action: "settings", expected: catalog.getStickerSettings(), settings: { mode: "off" } });
  assert.equal(result.status, 200);
  assert.equal(result.value.settings.mode, "off");
});

test("settings conflicts compare editable settings, not unrelated catalog counters", async () => {
  const expected = catalog.getStickerSettings();
  favorite();
  const result = await applyStickerManagerAction({ action: "settings", expected, settings: { chance: 0.3 } }, expectedGuard);
  assert.equal(result.settings.chance, 0.3);
  assert.deepEqual(result.settings, result.snapshot.settings);
});

for (const expected of [undefined, null, [], "bad", 42]) {
  test("missing or malformed settings baseline never mutates: " + String(expected), async () => {
    const before = bytes();
    await assert.rejects(applyStickerManagerAction({ action: "settings", expected, settings: { mode: "off" } }, expectedGuard),
      error => error.statusCode === 400);
    assert.equal(bytes(), before);
  });
}

test("old entry edits conflict; unrelated sends do not invalidate the original editable fields", async () => {
  const id = favorite(), expected = editable(id);
  catalog.recordStickerSend(id, true);
  const first = await applyStickerManagerAction({ action: "update", id, expected, patch: { description: "first edit" } }, expectedGuard);
  assert.equal(first.entry.description, "first edit");
  const before = bytes();
  await assert.rejects(applyStickerManagerAction({ action: "update", id, expected, patch: { description: "stale edit" } }, expectedGuard),
    error => error.statusCode === 409);
  assert.equal(bytes(), before);
  assert.equal(catalog.getStickerEntry(id).description, "first edit");
});

test("entry baselines cannot be reused for another target or a removed entry", async () => {
  const id = favorite(), expected = editable(id);
  const other = captured();
  for (const target of [other, "missing"]) {
    const before = bytes();
    await assert.rejects(applyStickerManagerAction({ action: "update", id: target, expected, patch: { enabled: false } }, expectedGuard),
      error => error.statusCode === 409);
    assert.equal(bytes(), before);
  }
});

test("a fresh public baseline stays valid after stored descriptions contain control characters", async () => {
  const id = favorite();
  catalog.updateStickerEntry(id, { description: "New\ntext\twith spacing" });
  const publicEntry = buildStickerManagerSnapshot().entries.find(entry => entry.id === id);
  const expected = { id, description: publicEntry.description, tags: publicEntry.tags, allowedGroups: publicEntry.allowedGroups, enabled: publicEntry.enabled };
  const result = await applyStickerManagerAction({ action: "update", id, expected, patch: { description: "Next" } }, expectedGuard);
  assert.equal(result.entry.description, "Next");
});

test("stale removal rejects before any cloud action and a matching removal is confirmed", async () => {
  const id = captured(), expected = editable(id);
  catalog.markCapturedStickerCloudResult(id, { ok: true, created: true, item: { resId: "synthetic-cloud-id" } });
  catalog.updateStickerEntry(id, { description: "changed" });
  let calls = 0;
  const options = { ...expectedGuard, removeCloud: async () => { calls++; return { ok: true }; } };
  const before = bytes();
  await assert.rejects(applyStickerManagerAction({ action: "remove", id, expected }, options), error => error.statusCode === 409);
  assert.equal(calls, 0);
  assert.equal(bytes(), before);
  const result = await applyStickerManagerAction({ action: "remove", id, expected: editable(id) }, options);
  assert.equal(calls, 1);
  assert.equal(result.removed.id, id);
  assert.equal(result.snapshot.entries.some(entry => entry.id === id), false);
});

test("a concurrent local edit during cloud removal is never deleted or silently retried", async () => {
  const id = captured();
  catalog.markCapturedStickerCloudResult(id, { ok: true, created: true, item: { resId: "synthetic-cloud-id" } });
  const expected = editable(id);
  let calls = 0;
  await assert.rejects(applyStickerManagerAction({ action: "remove", id, expected }, { ...expectedGuard,
    removeCloud: async () => { calls++; catalog.updateStickerEntry(id, { description: "newer local edit" }); return { ok: true }; } }),
  error => error.statusCode === 409 && error.message.includes("未继续删除"));
  assert.equal(calls, 1);
  assert.equal(catalog.getStickerEntry(id).description, "newer local edit");
});

test("internal legacy callers keep their narrow contract; no expected data leaks private cloud fields", async () => {
  const id = favorite();
  const result = await applyStickerManagerAction({ action: "update", id, patch: { description: "legacy caller" } });
  assert.equal(result.entry.description, "legacy caller");
  const snapshot = buildStickerManagerSnapshot();
  assert.doesNotMatch(JSON.stringify(snapshot.entries), /synthetic-send-key/);
  assert.equal(snapshot.entries[0].key, "configured");
  assert.doesNotMatch(JSON.stringify(editable(id)), /synthetic-res-id|resId|"key"/);
});

test("removed records use the public view and never expose original send keys or sender hashes", async () => {
  const id = captured();
  catalog.markCapturedStickerCloudResult(id, { ok: true, created: true, item: { resId: "synthetic-cloud-id", key: "synthetic-private-send-key" } });
  const result = await applyStickerManagerAction({ action: "remove", id, expected: editable(id) }, {
    ...expectedGuard, removeCloud: async () => ({ ok: true, key: "synthetic-private-cloud-key", senderHashes: ["a".repeat(24)] }),
  });
  assert.equal(result.removed.id, id);
  assert.equal(result.removed.key, "configured");
  assert.equal(Object.hasOwn(result.removed, "senderHashes"), false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-send-key|synthetic-private-cloud-key|senderHashes/);
});

for (const action of ["settings", "update", "remove"]) {
  test(action + " disk failure closes cache authority and never overwrites the original on flush", async t => {
    const id = captured();
    const before = bytes();
    const payload = action === "settings"
      ? { action, expected: catalog.getStickerSettings(), settings: { mode: "off" } }
      : { action, id, expected: editable(id), patch: { description: "failed edit" } };
    const mock = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("synthetic disk failure"), { code: "EIO" }); });
    await assert.rejects(applyStickerManagerAction(payload, expectedGuard), error => error.statusCode === 503 && error.cause?.code === "EIO");
    assert.equal(bytes(), before);
    assert.equal(buildStickerManagerSnapshot().available, false);
    assert.deepEqual(catalog.listSelectableStickers(), []);
    assert.deepEqual(catalog.listPendingStickerAnalysis(), []);
    mock.mock.restore();
    await assert.rejects(applyStickerManagerAction({ action: "settings", expected: catalog.getStickerSettings(), settings: { mode: "off" } }, expectedGuard),
      error => error.statusCode === 503);
    assert.throws(() => catalog.flushStickerCatalogSync(), /暂不可读/);
    assert.equal(bytes(), before);
    catalog.setStickerCatalogPath(filename);
    assert.equal(buildStickerManagerSnapshot().available, true);
    assert.equal(catalog.getStickerSettings().mode, "steady");
    assert.equal(catalog.getStickerEntry(id).description, "original");
  });
}
