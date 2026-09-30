import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const temporaryBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryBase, "qqfriend-sticker-privacy-retry-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const catalog = await import("../bridge/features/stickers/catalog-store.mjs");
const { applyStickerManagerAction, buildStickerManagerSnapshot } = await import("../bridge/admin-api/sticker-manager.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const senderA = 60100, senderB = 60101, senderC = 60102;
const now = 1800000000000;
let sequence = 0;
let filename;
let fixture;

test.beforeEach(t => {
  filename = path.join(root, "case-" + (++sequence), "catalog.json");
  catalog.setStickerCatalogPath(filename);
  t.mock.method(globalThis, "fetch", () => assert.fail("No network permitted"));
  fixture = seedCatalog();
});

test.after(() => {
  cleanupLogger();
  catalog.resetStickerCatalogForTest();
  assert.equal(path.dirname(root), temporaryBase);
  fs.rmSync(root, { recursive: true, force: true });
});

function seedCatalog() {
  catalog.updateStickerSettings({ mode: "steady", chance: 0.1, allowedGroups: [50100], captureMode: "observe" });
  function add(digit, sender) {
    return catalog.upsertCapturedSticker({ url: "https://fixture.invalid/" + digit + ".png",
      md5: digit.repeat(32), fingerprint: digit.repeat(16), description: "synthetic " + digit,
      tags: ["fixture", digit], classification: "sticker", confidence: 0.99 },
    { groupId: 50100, senderId: sender, now }).entry;
  }
  const soleA = add("a", senderA), soleB = add("b", senderB);
  const shared = add("c", senderA); add("c", senderB); add("c", senderC);
  const manual = add("d", senderA); add("d", senderB);
  catalog.markCapturedStickerCloudResult(shared.id, { ok: true, created: true,
    item: { resId: "synthetic-shared-receipt", key: "synthetic-shared-key" } }, { now });
  catalog.markCapturedStickerCloudResult(manual.id, { ok: true, created: true,
    item: { resId: "synthetic-manual-receipt", key: "synthetic-manual-key" } }, { now });
  catalog.updateStickerEntry(manual.id, { description: "synthetic manual annotation",
    tags: ["manual", "retained"], allowedGroups: [50100, 50101] });
  catalog.upsertFavoriteStickers([{ url: "https://fixture.invalid/e.png", md5: "e".repeat(32),
    resId: "synthetic-favorite-receipt", key: "synthetic-favorite-key", summary: "synthetic favorite" }], { now });
  const favorite = add("e", senderA); add("e", senderB);
  const untouched = add("f", senderC);
  return { soleA: soleA.id, soleB: soleB.id, shared: shared.id, manual: manual.id,
    favorite: favorite.id, untouched: untouched.id, hashA: soleA.senderHashes[0], hashB: soleB.senderHashes[0],
    baseline: readDisk() };
}

function bytes() { return fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null; }
function readDisk() { return JSON.parse(bytes()); }
function writeDisk(value) { fs.writeFileSync(filename, JSON.stringify(value, null, 2)); }
function editable(id) {
  const entry = buildStickerManagerSnapshot().entries.find(item => item.id === id);
  return { id, description: entry.description, tags: entry.tags, allowedGroups: entry.allowedGroups, enabled: entry.enabled };
}

function trackCatalogWrites(t) {
  const native = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, rename: fs.renameSync };
  const descriptors = new Map();
  const state = { failRename: false, syncFault: "", events: [], faults: 0 };
  const directory = path.dirname(filename);
  const mocks = [];
  function kind(file) {
    if (typeof file !== "string") return "";
    if (file === filename) return "catalog";
    if (file.startsWith(filename + ".tmp.")) return "staging";
    return file === directory ? "directory" : "";
  }
  mocks.push(t.mock.method(fs, "openSync", (...args) => {
    const descriptor = native.open(...args);
    const target = kind(args[0]);
    if (target) descriptors.set(descriptor, target);
    return descriptor;
  }));
  mocks.push(t.mock.method(fs, "closeSync", descriptor => {
    descriptors.delete(descriptor);
    return native.close(descriptor);
  }));
  mocks.push(t.mock.method(fs, "fsyncSync", descriptor => {
    const target = descriptors.get(descriptor);
    if ((state.syncFault === "before" && target === "staging") ||
        (state.syncFault === "after" && ["catalog", "directory"].includes(target))) {
      state.faults++;
      state.events.push("sync-failed-" + target);
      throw Object.assign(new Error("synthetic catalog fsync failure"), { code: "EIO" });
    }
    const result = native.sync(descriptor);
    if (target) state.events.push("sync-" + target);
    return result;
  }));
  mocks.push(t.mock.method(fs, "renameSync", (...args) => {
    if (args[1] !== filename || kind(args[0]) !== "staging") return native.rename(...args);
    if (state.failRename) {
      state.faults++;
      state.events.push("rename-failed");
      throw Object.assign(new Error("synthetic catalog rename failure"), { code: "EIO" });
    }
    const result = native.rename(...args);
    state.events.push("rename");
    // Windows skips directory fsync; inject the same uncertainty after a real rename.
    if (state.syncFault === "after" && process.platform === "win32") {
      const descriptor = fs.openSync(filename, "r+");
      try { fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
    return result;
  }));
  state.restore = () => { for (const mock of mocks.reverse()) mock.mock.restore(); };
  return state;
}

async function assertLocked(writes) {
  const before = bytes(), events = [...writes.events];
  assert.equal(catalog.buildStickerCatalogSnapshot().available, false);
  assert.equal(buildStickerManagerSnapshot().available, false);
  assert.deepEqual(catalog.listSelectableStickers(), []);
  assert.deepEqual(catalog.listPendingStickerAnalysis(), []);
  assert.throws(() => catalog.flushStickerCatalogSync());
  const payloads = [
    { action: "settings", expected: catalog.getStickerSettings(), settings: { mode: "off", chance: 0.99 } },
    { action: "update", id: fixture.manual, expected: editable(fixture.manual), patch: { description: "blocked edit" } },
    { action: "remove", id: fixture.shared, expected: editable(fixture.shared) },
  ];
  for (const payload of payloads) {
    await assert.rejects(applyStickerManagerAction(payload, { requireExpected: true,
      removeCloud: async () => assert.fail("No cloud mutation while unavailable") }), error => error.statusCode === 503);
  }
  assert.equal(bytes(), before, "blocked mutations must leave disk byte-for-byte intact");
  assert.deepEqual(writes.events, events, "blocked mutations must never start a catalog write");
}

function assertDurable(writes) {
  assert.equal(writes.faults, 0, "the confirmed retry must have no filesystem fault");
  assert.ok(writes.events.includes("sync-staging"), "retry must fsync the staged catalog");
  assert.ok(writes.events.indexOf("sync-staging") < writes.events.indexOf("rename"), "fsync must precede the real rename");
  assert.equal(writes.events.filter(event => event === "rename").length, 1);
  if (process.platform !== "win32") {
    assert.ok(writes.events.indexOf("sync-directory") > writes.events.indexOf("rename"), "Linux must confirm directory durability");
  }
}

function assertRecovered(diskBefore, hashes) {
  const expected = globalThis.structuredClone(diskBefore);
  for (const entry of expected.entries) {
    if (!entry.senderHashes.some(hash => hashes.includes(hash))) continue;
    entry.senderHashes = entry.senderHashes.filter(hash => !hashes.includes(hash));
    entry.distinctSenderCount = entry.senderHashes.length;
    if (!entry.distinctSenderCount && entry.source === "group-capture" && !entry.manual) {
      entry.enabled = false;
      entry.captureState = "retired";
    }
  }
  const actual = readDisk();
  assert.ok(actual.revision > diskBefore.revision);
  assert.equal(typeof actual.updatedAt, "string");
  expected.revision = actual.revision;
  expected.updatedAt = actual.updatedAt;
  assert.deepEqual(actual, expected, "only requested associations, retirement, and write metadata may change");
  assert.equal(actual.identitySalt, fixture.baseline.identitySalt);
  for (const hash of hashes) assert.ok(!bytes().includes(hash), "forgotten hash must be absent on disk");
  assert.equal(catalog.buildStickerCatalogSnapshot().available, true);
  catalog.resetStickerCatalogForTest();
  assert.equal(catalog.buildStickerCatalogSnapshot().available, true, "confirmed disk catalog must survive a cold read");
  assert.deepEqual(catalog.getStickerCatalog(), actual);
}

test("failed ordinary settings save blocks generic writes; explicit forget discards the failed settings", async t => {
  const original = bytes();
  const writes = trackCatalogWrites(t);
  writes.failRename = true;
  assert.throws(() => catalog.updateStickerSettings({ mode: "off", chance: 0.91 }), { code: "EIO" });
  assert.equal(writes.faults, 1);
  assert.equal(bytes(), original);
  writes.failRename = false;
  await assertLocked(writes);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderA).ok, true);
  assertDurable(writes);
  assertRecovered(fixture.baseline, [fixture.hashA]);
});

test("failed entry save is discarded while newer disk settings, entry edits, additions and removals survive retry", async t => {
  const writes = trackCatalogWrites(t);
  writes.failRename = true;
  assert.throws(() => catalog.updateStickerEntry(fixture.manual, { description: "FAILED CACHED EDIT", tags: ["failed"] }), { code: "EIO" });
  writes.failRename = false;
  const newer = globalThis.structuredClone(fixture.baseline);
  newer.revision += 50;
  newer.settings.chance = 0.42;
  const manual = newer.entries.find(entry => entry.id === fixture.manual);
  Object.assign(manual, { description: "newer disk annotation", tags: ["disk", "retained"], allowedGroups: [50102], sendCount: 7 });
  newer.entries = newer.entries.filter(entry => entry.id !== fixture.untouched);
  newer.entries.push({ ...globalThis.structuredClone(newer.entries.find(entry => entry.id === fixture.favorite)),
    id: "synthetic-new-disk-entry", url: "https://fixture.invalid/newer.png", md5: "9".repeat(32),
    resId: "synthetic-newer-receipt", senderHashes: [], distinctSenderCount: 0 });
  writeDisk(newer);
  await assertLocked(writes);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderA).ok, true);
  assertDurable(writes);
  assertRecovered(newer, [fixture.hashA]);
  assert.ok(!bytes().includes("FAILED CACHED EDIT"));
});

test("skipSave queues A and B across failure without restoring generic write authority before durable retry", async t => {
  const original = bytes();
  const writes = trackCatalogWrites(t);
  assert.equal(forgetUserData(senderA, { skipSave: true }).ok, true);
  assert.equal(bytes(), original, "skipSave must not persist A");
  writes.failRename = true;
  assert.equal(forgetUserData(senderB).ok, false);
  assert.equal(bytes(), original);
  writes.failRename = false;
  await assertLocked(writes);
  const events = [...writes.events];
  forgetUserData(senderB, { skipSave: true });
  assert.equal(bytes(), original, "deferred retry must not persist pending A/B");
  assert.deepEqual(writes.events, events);
  await assertLocked(writes);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderA).ok, true, "full persistence must confirm both queued removals");
  assertDurable(writes);
  assertRecovered(fixture.baseline, [fixture.hashA, fixture.hashB]);
});

test("failed forget A then failed fsync for B remains unconfirmed and a B retry durably removes both", async t => {
  const original = bytes();
  const writes = trackCatalogWrites(t);
  writes.failRename = true;
  assert.equal(forgetUserData(senderA).ok, false);
  assert.equal(bytes(), original);
  writes.failRename = false;
  await assertLocked(writes);
  writes.syncFault = "before";
  assert.equal(forgetUserData(senderB).ok, false);
  assert.ok(writes.events.includes("sync-failed-staging"));
  assert.equal(bytes(), original, "failed staging fsync must never rename over disk");
  writes.syncFault = "";
  await assertLocked(writes);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderB).ok, true);
  assertDurable(writes);
  assertRecovered(fixture.baseline, [fixture.hashA, fixture.hashB]);
});

test("fsync failure after an actual rename stays unavailable and unconfirmed until an explicit durable retry", async t => {
  const writes = trackCatalogWrites(t);
  writes.syncFault = "after";
  assert.equal(forgetUserData(senderA).ok, false, "visible removal alone is not full write confirmation");
  assert.equal(writes.events.filter(event => event === "rename").length, 1, "the native rename must actually complete");
  assert.ok(writes.events.some(event => event.startsWith("sync-failed-")));
  assert.ok(!bytes().includes(fixture.hashA), "the fault occurs after the erasure reaches disk");
  const unconfirmedDisk = readDisk();
  writes.syncFault = "";
  await assertLocked(writes);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderA).ok, true, "zero newly changed associations still require confirmation of pending erasure");
  assertDurable(writes);
  assertRecovered(unconfirmedDisk, [fixture.hashA]);
});

test("retry refuses corrupt, missing, lossy, or changed-salt disk catalogs without dropping pending erasure", async t => {
  const writes = trackCatalogWrites(t);
  writes.failRename = true;
  assert.equal(forgetUserData(senderA).ok, false);
  writes.failRename = false;
  const missingSalt = globalThis.structuredClone(fixture.baseline); delete missingSalt.identitySalt;
  const replacedSalt = { ...fixture.baseline, identitySalt: fixture.baseline.identitySalt === "8".repeat(64) ? "7".repeat(64) : "8".repeat(64) };
  const lossy = globalThis.structuredClone(fixture.baseline); lossy.entries[0].url = "not-a-url";
  const variants = ["{broken", null, JSON.stringify(missingSalt),
    JSON.stringify({ ...fixture.baseline, identitySalt: "invalid" }), JSON.stringify(replacedSalt), JSON.stringify(lossy)];
  for (const raw of variants) {
    if (raw === null) fs.unlinkSync(filename);
    else fs.writeFileSync(filename, raw);
    const events = [...writes.events];
    assert.equal(forgetUserData(senderA).ok, false, "invalid recovery must never confirm erasure");
    assert.equal(bytes(), raw, "invalid disk content must not be replaced");
    assert.deepEqual(writes.events, events, "invalid recovery must refuse before any write");
    await assertLocked(writes);
  }
  writeDisk(fixture.baseline);
  writes.events.length = 0; writes.faults = 0;
  assert.equal(forgetUserData(senderA).ok, true);
  assertDurable(writes);
  assertRecovered(fixture.baseline, [fixture.hashA]);
});
