import assert from "node:assert/strict";
import test from "node:test";
import { consoleHarness, deferred, Element, flush } from "./p5-ui-harness.mjs";

const entry = (id, overrides = {}) => ({ id, description: `Description ${id}`, tags: [id], allowedGroups: [101],
  enabled: true, sendable: true, source: "qq-favorite", ...overrides });
const snapshot = (overrides = {}) => ({ entries: [entry("one"), entry("two", { source: "group-capture" })],
  settings: { mode: "steady", captureMode: "observe", groupEnabled: true, privateEnabled: true, chance: 0.2,
    strongChance: 0.5, cooldownMs: 60000, allowedGroups: [101], captureDailyLimit: 20, captureCatalogLimit: 300,
    captureMinConfidence: 0.82, captureMinDistinctSenders: 2 }, counts: { total: 2, sendable: 2 }, stats: { sent: 1 },
  ...overrides });
const button = (h, action) => h.select(`[data-action='${action}']`);
const dirty = api => JSON.parse(JSON.stringify(api.updateStickerDirty()));

function mockDetailImages(h) {
  const preview = h.get("stickerPreview");
  let images = [];
  Object.defineProperty(preview, "innerHTML", { get() { return this._html; }, set(html) {
    this._html = html;
    images = [];
    if (html.includes("data-sticker-preview")) {
      const image = new Element("img"); image.dataset = { previewId: "one", previewVersion: "0" };
      image.nextElementSibling = new Element("span"); images.push(image);
    }
  } });
  preview.querySelectorAll = () => images;
  return () => images;
}

async function setup({ mode = "browser", load = true, notice = true } = {}) {
  const h = consoleHarness();
  h.host.mode = mode;
  if (!notice) h.document.getElementById = id => id === "stickerDraftState" ? null : h.get(id);
  const [api, { uiState }, activity] = await h.imports(["pages/stickers.js", "ui/state.js", "ui/activity.js"]);
  h.get("stickerFilter").value = "all";
  if (load) api.renderStickers(snapshot());
  return { h, api, uiState, activity };
}

test("the parent contract is exported and a readable catalog establishes clean baselines", async () => {
  const { h, api, uiState } = await setup();
  for (const name of ["stickerHasDrafts", "canDiscardStickerDrafts", "updateStickerDirty", "stickerReadFailed", "syncStickerControls", "canWriteStickers", "stickerRemovalPayload"]) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.deepEqual(dirty(api), { settings: false, entry: false });
  assert.equal(api.stickerHasDrafts(), false);
  assert.equal(api.canWriteStickers("saveSticker"), true);
  assert.equal(uiState.selectedStickerId, "one");
  assert.equal(h.get("stickerId").value, "one");
  assert.equal(h.get("stickerDraftState").dataset.state, "ready");
  assert.equal(h.calls.length, 0);
});

test("unread and busy controls lock mutations but do not lock refresh or rewrite task status", async () => {
  const { h, api, activity } = await setup({ load: false });
  h.get("stickerStatus").textContent = "Task still running";
  api.syncStickerControls();
  assert.equal(api.canWriteStickers(), false);
  for (const action of ["saveSticker", "saveStickerSettings", "setStickerMode", "setStickerCaptureMode", "syncStickers",
    "analyzeStickers", "removeCapturedSticker", "simulateSticker", "cleanupStickerTemp", "refreshStickerCapabilities"]) {
    assert.equal(button(h, action).disabled, true, action);
  }
  assert.equal(h.get("stickerDescription").disabled, true);
  assert.equal(h.get("stickerChance").disabled, true);
  assert.equal(button(h, "refreshStickers").disabled, false);
  assert.equal(button(h, "refreshManagedTasks").disabled, false);
  assert.equal(h.get("stickerStatus").textContent, "Task still running");
  assert.throws(() => api.stickerEntryPayload());
  assert.throws(() => api.stickerSettingsPayload());
  api.renderStickers(snapshot(), { force: true });
  activity.beginAction("refreshStickers", null, true);
  api.syncStickerControls();
  assert.equal(api.canWriteStickers(), false);
  assert.equal(button(h, "saveStickerSettings").disabled, true);
  activity.endAction("refreshStickers");
  api.syncStickerControls();
  assert.equal(api.canWriteStickers(), true);
  assert.equal(h.get("stickerDescription").disabled, false);
});

test("settings and entry drafts survive cached and background renders with updated status", async () => {
  const { h, api, uiState } = await setup();
  h.get("stickerDescription").value = "  Unsaved description  ";
  h.get("stickerChance").value = "37";
  h.get("stickerGroups").value = " 101  202 ";
  assert.deepEqual(dirty(api), { settings: true, entry: true });
  api.renderStickers(uiState.stickerSnapshot);
  const fresh = snapshot({ stats: { sent: 9 }, entries: [entry("one", { description: "Server edit" }), entry("two")],
    settings: { ...snapshot().settings, chance: 0.9, mode: "off", captureMode: "auto" } });
  api.renderStickers(fresh);
  assert.equal(h.get("stickerDescription").value, "  Unsaved description  ");
  assert.equal(h.get("stickerChance").value, "37");
  assert.equal(h.get("stickerGroups").value, " 101  202 ");
  assert.deepEqual(dirty(api), { settings: true, entry: true });
  assert.match(h.get("stickerStatus").textContent, /9/);
  assert.match(h.get("stickerSummary").innerHTML, /9/);
  assert.equal(api.stickerSettingsPayload().settings.mode, "steady");
  assert.equal(api.stickerSettingsPayload().settings.captureMode, "observe");
  assert.equal(api.stickerEntryPayload().id, "one");
  assert.equal(api.stickerEntryPayload().patch.description, "Unsaved description");
  assert.equal(api.canWriteStickers(), true, "this protection does not claim server CAS");
});

test("raw form values detect edits and reverting each field clears only its own draft", async () => {
  const { h, api } = await setup();
  for (const id of ["stickerChance", "stickerStrongChance", "stickerCooldown", "stickerGroups", "stickerCaptureDailyLimit",
    "stickerCaptureCatalogLimit", "stickerCaptureConfidence", "stickerCaptureSenders", "stickerDescription", "stickerTags", "stickerAllowedGroups"]) {
    const original = h.get(id).value;
    h.get(id).value = `${original} `;
    assert.equal(api.stickerHasDrafts(), true, id);
    h.get(id).value = original;
    assert.equal(api.stickerHasDrafts(), false, id);
  }
  for (const id of ["stickerGroupEnabled", "stickerPrivateEnabled", "stickerEntryEnabled"]) {
    h.get(id).checked = !h.get(id).checked;
    assert.equal(api.stickerHasDrafts(), true, id);
    h.get(id).checked = !h.get(id).checked;
    assert.equal(api.stickerHasDrafts(), false, id);
  }
});

test("scoped discard confirmation is cancelable and never clears a draft by itself", async () => {
  const { h, api } = await setup();
  assert.equal(api.canDiscardStickerDrafts(), true);
  assert.equal(h.confirmations.length, 0);
  h.get("stickerChance").value = "41";
  assert.equal(api.canDiscardStickerDrafts({ section: "entry" }), true);
  assert.equal(h.confirmations.length, 0);
  h.get("stickerTags").value = "Local tags";
  for (const section of ["entry", "settings", undefined]) {
    h.confirmationAnswers.push(false);
    assert.equal(api.canDiscardStickerDrafts({ section }), false);
  }
  h.confirmationAnswers.push(true);
  assert.equal(api.canDiscardStickerDrafts({ section: "entry" }), true);
  assert.deepEqual(dirty(api), { settings: true, entry: true });
  assert.equal(h.calls.length, 0);
});

test("confirmed settings commits reset settings only without requiring an outer ok flag", async () => {
  const { h, api } = await setup();
  h.get("stickerChance").value = "41";
  h.get("stickerTags").value = "Unsaved entry";
  api.renderStickers(snapshot({ settings: { ...snapshot().settings, chance: 0.41 } }), { confirmed: "settings" });
  assert.equal(Number(h.get("stickerChance").value), 41);
  assert.equal(h.get("stickerTags").value, "Unsaved entry");
  assert.deepEqual(dirty(api), { settings: false, entry: true });
});

test("confirmed entry commits reset the bound entry only, preserving settings", async () => {
  const { h, api } = await setup();
  h.get("stickerChance").value = "41";
  h.get("stickerDescription").value = "Saved entry";
  api.renderStickers(snapshot({ entries: [entry("one", { description: "Saved entry" }), entry("two")] }),
    { confirmed: "entry", selectId: "one" });
  assert.equal(h.get("stickerDescription").value, "Saved entry");
  assert.equal(h.get("stickerChance").value, "41");
  assert.deepEqual(dirty(api), { settings: true, entry: false });
});

test("browser expected values retain original settings and editable entry fields through dirty background reads", async () => {
  const { h, api } = await setup({ load: false });
  const original = snapshot({ settings: { ...snapshot().settings, chance: 0.2015, configured: { futureOption: ["keep"] } },
    entries: [entry("one", { resId: "public-resource-id", seenCount: 3, sentCount: 4 })] });
  api.renderStickers(original);
  const originalSettings = JSON.parse(JSON.stringify(original.settings));
  const originalEntry = { id: "one", description: "Description one", tags: ["one"], allowedGroups: [101], enabled: true };
  h.get("stickerChance").value = "41";
  h.get("stickerDescription").value = "Local draft";
  original.settings.configured.futureOption.push("mutated after render");
  original.entries[0].tags.push("mutated after render");
  const changed = snapshot({ settings: { ...snapshot().settings, chance: 0.8 }, entries: [entry("one", { description: "External edit",
    tags: ["external"], allowedGroups: [202], enabled: false, seenCount: 999, resId: "another-resource" })] });
  api.renderStickers(changed);
  const settingsPayload = api.stickerSettingsPayload();
  const entryPayload = api.stickerEntryPayload();
  const removalPayload = api.stickerRemovalPayload();
  assert.deepEqual(JSON.parse(JSON.stringify(settingsPayload.expected)), originalSettings);
  assert.deepEqual(JSON.parse(JSON.stringify(entryPayload.expected)), originalEntry);
  assert.deepEqual(JSON.parse(JSON.stringify(removalPayload)), { action: "remove", id: "one", expected: originalEntry });
  assert.equal(settingsPayload.settings.chance, 0.41);
  assert.equal(entryPayload.patch.description, "Local draft");
  assert.deepEqual(Object.keys(entryPayload.expected).sort(), ["allowedGroups", "description", "enabled", "id", "tags"]);
  settingsPayload.expected.configured.futureOption.push("mutated payload");
  entryPayload.expected.tags.push("mutated payload");
  assert.deepEqual(JSON.parse(JSON.stringify(api.stickerSettingsPayload().expected)), originalSettings);
  assert.deepEqual(JSON.parse(JSON.stringify(api.stickerRemovalPayload().expected)), originalEntry);
  api.renderStickers(changed, { confirmed: "settings" });
  assert.deepEqual(JSON.parse(JSON.stringify(api.stickerSettingsPayload().expected)), changed.settings);
  assert.deepEqual(JSON.parse(JSON.stringify(api.stickerEntryPayload().expected)), originalEntry);
  api.renderStickers(changed, { confirmed: "entry", selectId: "one" });
  assert.deepEqual(JSON.parse(JSON.stringify(api.stickerEntryPayload().expected)), { id: "one", description: "External edit",
    tags: ["external"], allowedGroups: [202], enabled: false });
});

test("entry navigation and a full reload capture new expected values only for the replaced sections", async () => {
  const { h, api, uiState } = await setup();
  h.get("stickerChance").value = "41";
  h.get("stickerDescription").value = "Discard entry";
  const fresh = snapshot({ settings: { ...snapshot().settings, chance: 0.6 },
    entries: [entry("one"), entry("two", { description: "Fresh two", seenCount: 100 })] });
  api.renderStickers(fresh, { force: true, section: "entry", selectId: "two" });
  assert.equal(api.stickerSettingsPayload().expected.chance, 0.2);
  assert.equal(api.stickerEntryPayload().expected.description, "Fresh two");
  assert.equal(api.stickerRemovalPayload().expected.id, "two");
  h.get("stickerDescription").value = "Another draft";
  api.stickerReadFailed(new Error("Unconfirmed"));
  assert.throws(() => api.stickerRemovalPayload());
  api.renderStickers(fresh, { force: true, selectId: "two" });
  assert.equal(api.stickerSettingsPayload().expected.chance, 0.6);
  assert.equal(uiState.selectedStickerId, "two");
  assert.equal(api.stickerEntryPayload().expected.description, "Fresh two");
});

test("section-only acknowledgements and navigation do not rebase even clean unrelated forms", async () => {
  const { h, api } = await setup();
  const fresh = snapshot({ settings: { ...snapshot().settings, chance: 0.6 },
    entries: [entry("one", { description: "External one" }), entry("two")] });
  api.renderStickers(fresh, { confirmed: "settings" });
  assert.equal(api.stickerSettingsPayload().expected.chance, 0.6);
  assert.equal(api.stickerEntryPayload().expected.description, "Description one");
  assert.equal(h.get("stickerDescription").value, "Description one");
  const newer = snapshot({ settings: { ...snapshot().settings, chance: 0.9 }, entries: fresh.entries });
  api.renderStickers(newer, { confirmed: "entry", selectId: "one" });
  assert.equal(api.stickerEntryPayload().expected.description, "External one");
  assert.equal(api.stickerSettingsPayload().expected.chance, 0.6);
  assert.equal(Number(h.get("stickerChance").value), 60);
  api.renderStickers(newer, { force: true, section: "entry", selectId: "two" });
  assert.equal(api.stickerSettingsPayload().expected.chance, 0.6);
  assert.equal(api.stickerEntryPayload().expected.id, "two");
});

test("entry-only confirmed navigation and filters never discard settings edits", async () => {
  const { h, api, uiState } = await setup();
  h.get("stickerChance").value = "41";
  h.get("stickerTags").value = "Discard this entry";
  assert.equal(api.canDiscardStickerDrafts({ section: "entry" }), true);
  uiState.selectedStickerId = "two";
  api.renderStickers(uiState.stickerSnapshot, { force: true, section: "entry", selectId: "two" });
  assert.equal(h.get("stickerId").value, "two");
  assert.equal(h.get("stickerTags").value, "two");
  assert.equal(h.get("stickerChance").value, "41");
  assert.deepEqual(dirty(api), { settings: true, entry: false });
  h.get("stickerDescription").value = "Another entry draft";
  assert.equal(api.canDiscardStickerDrafts({ section: "entry" }), true);
  h.get("stickerFilter").value = "qq-favorite";
  uiState.selectedStickerId = "";
  api.renderStickers(uiState.stickerSnapshot, { force: true, section: "entry" });
  assert.equal(h.get("stickerId").value, "one");
  assert.deepEqual(dirty(api), { settings: true, entry: false });
});

test("a changed current selection or wrong confirmation ID preserves the draft and blocks writes", async () => {
  for (const confirmed of [undefined, "entry"]) {
    const { h, api, uiState } = await setup();
    h.get("stickerDescription").value = "Bound to one";
    uiState.selectedStickerId = "two";
    assert.equal(api.canWriteStickers("saveSticker"), false);
    api.renderStickers(snapshot(), { selectId: "two", confirmed });
    assert.equal(h.get("stickerId").value, "one");
    assert.equal(h.get("stickerDescription").value, "Bound to one");
    assert.equal(uiState.selectedStickerId, "one");
    assert.equal(api.canWriteStickers("saveSticker"), false);
    assert.throws(() => api.stickerEntryPayload());
    api.renderStickers(snapshot(), { force: true, section: "entry", selectId: "two" });
    assert.equal(h.get("stickerId").value, "one", "cached navigation cannot release the target block");
    api.renderStickers(snapshot(), { force: true, selectId: "two" });
    assert.equal(h.get("stickerId").value, "two");
    assert.equal(api.canWriteStickers("saveSticker"), true);
  }
});

test("removed entries retain their draft and cannot silently fall through to the next ID", async () => {
  const { h, api, uiState } = await setup();
  h.get("stickerDescription").value = "Orphaned draft";
  h.get("stickerChance").value = "41";
  const removed = snapshot({ entries: [entry("two")], counts: { total: 1 } });
  api.renderStickers(removed);
  assert.equal(uiState.selectedStickerId, "one");
  assert.equal(h.get("stickerId").value, "one");
  assert.equal(h.get("stickerDescription").value, "Orphaned draft");
  assert.equal(h.get("stickerDetailPanel").hidden, false);
  assert.equal(api.canWriteStickers("removeCapturedSticker"), false);
  assert.equal(api.canWriteStickers("saveStickerSettings"), false);
  assert.throws(() => api.stickerEntryPayload());
  api.renderStickers(snapshot());
  assert.equal(api.canWriteStickers(), false, "reappearance is not an explicit reload");
  api.renderStickers(removed, { force: true });
  assert.equal(h.get("stickerId").value, "two");
  assert.equal(api.stickerHasDrafts(), false);
});

test("an acknowledged entry removal may reset that entry without clearing settings", async () => {
  const { h, api, uiState } = await setup();
  h.get("stickerChance").value = "41";
  h.get("stickerDescription").value = "Removed intentionally";
  api.renderStickers(snapshot({ entries: [entry("two")] }), { confirmed: "entry", selectId: "one" });
  assert.equal(uiState.selectedStickerId, "two");
  assert.deepEqual(dirty(api), { settings: true, entry: false });
  assert.equal(api.canWriteStickers(), true);
});

test("failed reads, permission loss and unconfirmed writes remain blocked until full GET reload", async () => {
  for (const error of [new Error("Read failed"), Object.assign(new Error("Forbidden"), { status: 403 }),
    Object.assign(new Error("Editable fields changed"), { status: 409 }),
    Object.assign(new Error("Write unconfirmed"), { responseInvalid: true })]) {
    const { h, api, uiState } = await setup();
    h.get("stickerDescription").value = "Retain entry";
    h.get("stickerChance").value = "41";
    h.get("stickerStatus").textContent = "Task still running";
    api.stickerReadFailed(error);
    assert.equal(uiState.stickersLoaded, false);
    assert.equal(api.canWriteStickers(), false);
    if (error.status === 403) assert.equal(uiState.stickerSnapshot.available, false);
    else assert.equal(h.get("stickerStatus").textContent, "Task still running");
    assert.equal(h.get("stickerDraftState").dataset.state, "error");
    assert.equal(button(h, "refreshStickers").disabled, false);
    assert.throws(() => api.stickerSettingsPayload());
    assert.throws(() => api.stickerEntryPayload());
    assert.throws(() => api.stickerSimulationPayload());
    api.setStickerCatalogAvailability(true);
    api.renderStickers(snapshot(), { confirmed: "settings" });
    api.renderStickers(snapshot(), { confirmed: "entry", selectId: "one" });
    api.renderStickers(snapshot(), { force: true, section: "entry", selectId: "two" });
    assert.equal(api.canWriteStickers(), false);
    assert.equal(uiState.stickersLoaded, false);
    assert.deepEqual(dirty(api), { settings: true, entry: true });
    assert.equal(h.get("stickerDescription").value, "Retain entry");
    api.renderStickers(snapshot(), { force: true });
    assert.equal(api.canWriteStickers(), true);
    assert.deepEqual(dirty(api), { settings: false, entry: false });
    assert.equal(h.calls.length, 0, "no automatic retry");
  }
});

test("unavailable and malformed catalogs never clear drafts even on a requested force reload", async () => {
  const { h, api } = await setup();
  h.get("stickerDescription").value = "Retain entry";
  h.get("stickerChance").value = "41";
  api.renderStickers({ available: false, entries: [], settings: {} }, { force: true });
  assert.equal(h.get("stickerNavCount").textContent, "?");
  assert.equal(h.get("stickerDescription").value, "Retain entry");
  assert.equal(api.canWriteStickers(), false);
  for (const invalid of [null, {}, snapshot({ ok: false }), snapshot({ entries: {} }), snapshot({ settings: [] }),
    snapshot({ entries: [entry("one"), entry("one")] }), snapshot({ entries: [{}] })]) {
    assert.throws(() => api.renderStickers(invalid, { force: true }));
    assert.deepEqual(dirty(api), { settings: true, entry: true });
    assert.equal(api.canWriteStickers(), false);
  }
  api.renderStickers(snapshot(), { force: true });
  assert.equal(api.canWriteStickers(), true);
});

test("an empty authoritative catalog allows settings but not entry writes", async () => {
  const { h, api } = await setup();
  api.renderStickers(snapshot({ entries: [] }), { force: true });
  assert.equal(api.canWriteStickers("saveStickerSettings"), true);
  assert.equal(api.canWriteStickers("saveSticker"), false);
  assert.equal(api.canWriteStickers("removeCapturedSticker"), false);
  assert.equal(button(h, "saveSticker").disabled, true);
  assert.throws(() => api.stickerEntryPayload());
});

test("hidden entry ID tampering cannot redirect writes and requires explicit reload", async () => {
  const { h, api } = await setup();
  h.get("stickerId").value = "two";
  assert.equal(api.canWriteStickers("saveSticker"), false);
  assert.throws(() => api.stickerEntryPayload());
  api.syncStickerControls();
  h.get("stickerId").value = "one";
  assert.equal(api.canWriteStickers(), false);
  api.renderStickers(snapshot(), { force: true });
  assert.equal(api.stickerEntryPayload().id, "one");
});

test("leaving and simulation preserve drafts, optional feedback is safe, and VM state is isolated", async () => {
  const { h, api, uiState } = await setup({ notice: false });
  h.get("stickerDescription").value = "Retain entry";
  h.get("stickerChance").value = "41";
  assert.equal(api.canDiscardStickerDrafts(), true);
  uiState.stickersLoaded = false;
  api.disposeStickerPreviews();
  assert.equal(api.canWriteStickers(), false);
  api.renderStickers(snapshot());
  api.renderStickerSimulation({ result: { action: "send", stickerId: "two" }, snapshot: snapshot() });
  assert.equal(h.get("stickerId").value, "one");
  assert.equal(h.get("stickerDescription").value, "Retain entry");
  assert.deepEqual(dirty(api), { settings: true, entry: true });
  const other = await setup();
  assert.equal(other.api.stickerHasDrafts(), false);
});

test("preserved entry drafts rebuild known-source previews after disposal without changing their baseline", async () => {
  const { h, api, uiState } = await setup();
  const images = mockDetailImages(h);
  const revoked = [];
  let count = 0;
  h.window.URL = { createObjectURL() { return `blob:detail-${++count}`; }, revokeObjectURL(url) { revoked.push(url); } };
  h.setReply(action => { assert.equal(action, "getStickerPreview"); return { mockBlob: true }; });
  h.get("stickerDescription").value = "Retain draft";
  api.renderStickers(snapshot());
  await flush();
  assert.equal(images()[0].src, "blob:detail-1");
  api.disposeStickerPreviews();
  assert.deepEqual(revoked, ["blob:detail-1"]);
  uiState.stickersLoaded = false;
  api.renderStickers(snapshot({ entries: [entry("one", { lastSeenAt: 42, description: "Server changed", source: "group-capture" })] }));
  await flush();
  assert.equal(images()[0].src, "blob:detail-2");
  assert.match(h.get("stickerPreview").innerHTML, /data-preview-version="42"/);
  assert.equal(h.get("stickerDescription").value, "Retain draft");
  assert.equal(api.stickerEntryPayload().expected.description, "Description one");
  api.renderStickers(snapshot({ entries: [entry("two")] }));
  assert.equal(images().length, 0);
  assert.doesNotMatch(h.get("stickerPreview").innerHTML, /data-sticker-preview/);
  assert.deepEqual(revoked, ["blob:detail-1", "blob:detail-2"]);
  assert.equal(h.get("stickerDescription").value, "Retain draft");
});

test("401 and 403 revoke photos and suppress stale catalog data until an authoritative full reload", async () => {
  for (const status of [401, 403]) {
    const { h, api, uiState } = await setup();
    mockDetailImages(h);
    const revoked = [];
    h.window.URL = { createObjectURL() { return "blob:private"; }, revokeObjectURL(url) { revoked.push(url); } };
    h.setReply(action => { assert.equal(action, "getStickerPreview"); return { mockBlob: true }; });
    const privateSnapshot = snapshot({ entries: [entry("one", { description: "PRIVATE_CATALOG_DESCRIPTION", source: "group-capture",
      seenCount: 8675309 })], counts: { total: 7654321, sendable: 7654321 } });
    api.renderStickers(privateSnapshot, { force: true });
    await flush();
    h.get("stickerDescription").value = "Retain operator draft";
    h.get("stickerChance").value = "41";
    api.stickerReadFailed(Object.assign(new Error("Access revoked"), { status }));
    assert.deepEqual(revoked, ["blob:private"]);
    assert.equal(uiState.stickerSnapshot.entries.length, 0);
    assert.equal(uiState.stickerSnapshot.available, false);
    assert.doesNotMatch(h.get("stickerGrid").innerHTML, /PRIVATE_CATALOG_DESCRIPTION|data-sticker-preview/);
    assert.doesNotMatch(h.get("stickerEntryMeta").textContent, /8675309/);
    assert.doesNotMatch(h.get("stickerSummary").innerHTML, /7654321/);
    assert.equal(h.get("stickerPreview").innerHTML, "");
    assert.equal(h.get("stickerDescription").value, "Retain operator draft");
    assert.equal(h.get("stickerChance").value, "41");
    const calls = h.calls.length;
    api.renderStickers(privateSnapshot);
    api.renderStickers(privateSnapshot, { force: true, section: "entry", selectId: "one" });
    api.setStickerCatalogAvailability(true);
    assert.equal(h.calls.length, calls, "no cached photo reload after permission loss");
    assert.equal(uiState.stickerSnapshot.entries.length, 0);
    assert.deepEqual(dirty(api), { settings: true, entry: true });
    assert.equal(api.canWriteStickers(), false);
    api.renderStickers(snapshot(), { force: true });
    assert.equal(api.canWriteStickers(), true);
    assert.equal(api.stickerHasDrafts(), false);
    await flush();
    api.disposeStickerPreviews();
  }
});

test("transient 503 read failures retain drafts and do not erase the prior readable catalog", async () => {
  const { h, api, uiState } = await setup();
  const grid = h.get("stickerGrid").innerHTML;
  const prior = uiState.stickerSnapshot;
  h.get("stickerDescription").value = "Retain draft";
  api.stickerReadFailed(Object.assign(new Error("Unavailable"), { status: 503 }));
  assert.equal(uiState.stickerSnapshot, prior);
  assert.equal(h.get("stickerGrid").innerHTML, grid);
  assert.equal(h.get("stickerDescription").value, "Retain draft");
  assert.equal(api.canWriteStickers(), false);
});

test("native Windows rendering and preview URLs keep their legacy behavior", async () => {
  const { h, api, uiState } = await setup({ mode: "webview2" });
  h.get("stickerDescription").value = "Legacy overwrite";
  h.get("stickerChance").value = "41";
  api.stickerReadFailed(new Error("Browser-only block"));
  api.renderStickers(snapshot(), { selectId: "two" });
  assert.equal(h.get("stickerDescription").value, "Description two");
  assert.equal(Number(h.get("stickerChance").value), 20);
  assert.equal(api.stickerHasDrafts(), false);
  assert.equal(Object.hasOwn(api.stickerSettingsPayload(), "expected"), false);
  assert.equal(Object.hasOwn(api.stickerEntryPayload(), "expected"), false);
  assert.equal(Object.hasOwn(api.stickerRemovalPayload(), "expected"), false);
  assert.equal(api.canDiscardStickerDrafts(), true);
  assert.equal(h.confirmations.length, 0);
  uiState.lastStatus = { config: { listenPort: 17777 } };
  assert.equal(api.stickerPreviewUrl(entry("a b")), "http://127.0.0.1:17777/admin/stickers/image?id=a%20b&v=0");
  uiState.lastStatus.config.listenPort = 999999;
  assert.match(api.stickerPreviewUrl(entry("one")), /^http:\/\/127\.0\.0\.1:16789\//);
  assert.equal(h.calls.length, 0);
});

test("preview replacement retains the four-request queue guard and ignores disposed completions", async () => {
  const { h, api } = await setup();
  const pending = [];
  const created = []; const revoked = [];
  h.window.URL = { createObjectURL(blob) { created.push(blob); return `blob:mock-${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } };
  h.window.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };
  const root = new Element("div", "stickerGrid");
  const image = id => {
    const node = new Element("img"); node.dataset = { previewId: id, previewVersion: "0" };
    node.nextElementSibling = new Element("span"); return node;
  };
  let images = Array.from({ length: 8 }, (_, index) => image(String(index)));
  root.querySelectorAll = () => images;
  h.setReply(action => { assert.equal(action, "getStickerPreview"); const request = deferred(); pending.push(request); return request.promise; });
  api.bindStickerImageFallbacks(root);
  assert.equal(h.calls.length, 4);
  const oldSignal = h.calls[0].payload.signal;
  images = [image("replacement")];
  api.bindStickerImageFallbacks(root);
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.calls.length, 5);
  pending[0].reject(Object.assign(new Error("old preview denied"), { status: 403 }));
  pending.slice(1, 4).forEach(request => request.resolve({ old: true }));
  await flush();
  assert.equal(created.length, 0);
  assert.equal(api.canWriteStickers("saveSticker"), true, "a disposed preview cannot revoke the current readable editor");
  assert.equal(h.calls.length, 5, "disposed queues must not restart");
  pending[4].resolve({ current: true });
  await flush();
  assert.equal(images[0].src, "blob:mock-1");
  await images[0].fire("load");
  assert.equal(images[0].dataset.state, "ready");
  api.disposeStickerPreviews();
  assert.deepEqual(revoked, ["blob:mock-1"]);
  api.bindStickerImageFallbacks(root);
  assert.equal(h.calls.length, 5, "already requested image is not requeued");
  images = [image("next")];
  api.bindStickerImageFallbacks(root);
  pending[5].resolve({ next: true });
  await flush();
  h.window.dispatchEvent({ type: "pagehide" });
  assert.deepEqual(revoked, ["blob:mock-1", "blob:mock-2"]);
});
