import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { consoleHarness, deferred, flush } from "./p5-ui-harness.mjs";
import { uiFixtureData } from "./p5-ui-fixtures.mjs";
import { normalizeStickerSettings, normalizeNumberList, publicStickerEntry } from "../bridge/features/stickers/schema.mjs";

if (!vm.SourceTextModule) {
  test("console action feedback in isolated VM", () => {
    const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fileURLToPath(import.meta.url)], { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  async function setup() {
    const h = consoleHarness();
    const [actions, stickers, logs, state] = await h.imports(["ui/actions.js", "pages/stickers.js", "pages/logs.js", "ui/state.js"]);
    const data = uiFixtureData();
    data.stickers.entries = [{ id: "fixture-one", description: "Original", tags: ["fixture"], allowedGroups: [2000000001], enabled: true,
      sendable: true, indexed: true, captureState: "active", source: "group-capture" }];
    stickers.renderStickers(data.stickers, { force: true });
    return { h, actions, stickers, logs, state, data };
  }

  for (const action of ["saveSticker", "saveStickerSettings", "removeCapturedSticker"]) {
    for (const outcome of ["empty", "wrong-target", 403, 409, 503, "unknown"]) {
      test(`${action} ${outcome} never displays success or silently loses its draft`, async () => {
        const { h, actions, stickers, state, data } = await setup();
        h.get("stickerDescription").value = "Unsaved entry";
        h.get("stickerChance").value = "37";
        stickers.updateStickerDirty();
        h.setReply(() => {
          if (outcome === "empty") return {};
          if (outcome === "wrong-target") return { entry: { id: "another" }, settings: { mode: "steady" }, removed: { id: "another" }, snapshot: data.stickers };
          throw Object.assign(new Error("Synthetic failure"), outcome === "unknown" ? { transportFailure: true } : { status: outcome });
        });
        await actions.runAction(action);
        assert.equal(h.calls.filter(call => call.action === "manageStickers").length, 1);
        assert.equal(h.get("activityBar").classes.has("success"), false);
        assert.equal(state.uiState.activeActions.size, 0);
        assert.equal(stickers.canWriteStickers(action), false);
        if (outcome !== 403) {
          assert.equal(h.get("stickerDescription").value, "Unsaved entry");
          assert.equal(h.get("stickerChance").value, "37");
        } else assert.equal(h.get("stickerGrid").innerHTML.includes("fixture-one"), false);
        await actions.runAction(action);
        assert.equal(h.calls.filter(call => call.action === "manageStickers").length, 1, "unknown or denied writes need a fresh read");
      });
    }
  }

  test("confirmed entry saves clear only entry state and retain the settings baseline", async () => {
    const { h, actions, stickers, data } = await setup();
    h.get("stickerDescription").value = "Confirmed edit";
    h.get("stickerChance").value = "37";
    stickers.updateStickerDirty();
    const settingsBefore = JSON.parse(JSON.stringify(stickers.stickerSettingsPayload().expected));
    h.setReply((action, payload) => {
      assert.equal(action, "manageStickers");
      const entry = { ...data.stickers.entries[0], ...payload.patch, allowedGroups: normalizeNumberList(payload.patch.allowedGroups) };
      return { entry, snapshot: { ...data.stickers, entries: [entry] } };
    });
    await actions.runAction("saveSticker");
    assert.equal(h.get("activityBar").classes.has("success"), true);
    assert.equal(stickers.updateStickerDirty().entry, false);
    assert.equal(stickers.updateStickerDirty().settings, true);
    assert.equal(h.get("stickerChance").value, "37");
    assert.deepEqual(JSON.parse(JSON.stringify(stickers.stickerSettingsPayload().expected)), settingsBefore);
  });

  test("confirmed settings saves never rebase an independent entry draft", async () => {
    const { h, actions, stickers, data } = await setup();
    h.get("stickerDescription").value = "Independent edit";
    h.get("stickerChance").value = "37";
    stickers.updateStickerDirty();
    const entryBefore = JSON.parse(JSON.stringify(stickers.stickerEntryPayload().expected));
    h.setReply((_action, payload) => {
      const settings = normalizeStickerSettings(payload.settings, data.stickers.settings);
      return { settings, snapshot: { ...data.stickers, settings } };
    });
    await actions.runAction("saveStickerSettings");
    assert.equal(h.get("activityBar").classes.has("success"), true);
    assert.equal(stickers.updateStickerDirty().entry, true);
    assert.equal(stickers.updateStickerDirty().settings, false);
    assert.deepEqual(JSON.parse(JSON.stringify(stickers.stickerEntryPayload().expected)), entryBefore);
  });

  for (const action of ["saveSticker", "saveStickerSettings"]) {
    test(action + " complete old values cannot acknowledge a changed request", async () => {
      const { h, actions, stickers, data } = await setup();
      h.get("stickerDescription").value = "Requested edit"; h.get("stickerChance").value = "37";
      stickers.updateStickerDirty();
      h.setReply(() => ({ entry: data.stickers.entries[0], settings: data.stickers.settings, snapshot: data.stickers }));
      await actions.runAction(action);
      assert.equal(h.get("activityBar").classes.has("success"), false);
      assert.equal(h.get("stickerDescription").value, "Requested edit");
      assert.equal(h.get("stickerChance").value, "37");
      assert.equal(stickers.canWriteStickers(action), false);
    });
  }

  for (const field of ["cooldownMs", "captureMinConfidence", "captureDailyLimit", "captureMinDistinctSenders"]) {
    test("missing acknowledged setting " + field + " cannot clear a draft or rebase CAS", async () => {
      const { h, actions, stickers, data } = await setup();
      h.get("stickerCooldown").value = "9"; stickers.updateStickerDirty();
      h.setReply((_action, payload) => {
        const settings = { ...data.stickers.settings, ...payload.settings }; delete settings[field];
        return { settings, snapshot: { ...data.stickers, settings } };
      });
      await actions.runAction("saveStickerSettings");
      assert.equal(h.get("stickerCooldown").value, "9");
      assert.equal(stickers.updateStickerDirty().settings, true);
      assert.equal(h.get("activityBar").classes.has("success"), false);
    });
  }

  test("legitimate normalized settings and public entry values are still confirmed", async () => {
    const { h, actions, stickers, data } = await setup();
    h.get("stickerCaptureCatalogLimit").value = "2.8"; h.get("stickerGroups").value = "2000000001";
    stickers.updateStickerDirty();
    h.setReply((_action, payload) => {
      const settings = { ...data.stickers.settings, ...payload.settings, allowedGroups: [2000000001], captureCatalogLimit: 3 };
      return { settings, snapshot: { ...data.stickers, settings } };
    });
    await actions.runAction("saveStickerSettings");
    assert.equal(h.get("activityBar").classes.has("success"), true);
    h.get("stickerDescription").value = "New\ntext"; h.get("stickerTags").value = "a b c d e f g h i";
    stickers.updateStickerDirty();
    h.setReply(() => {
      const entry = { ...data.stickers.entries[0], description: "New text", tags: ["a", "b", "c", "d", "e", "f", "g", "h"] };
      return { entry, snapshot: { ...data.stickers, entries: [entry] } };
    });
    await actions.runAction("saveSticker");
    assert.equal(h.get("activityBar").classes.has("success"), true);
    assert.equal(h.get("stickerDescription").value, "New text");
    assert.equal(stickers.updateStickerDirty().entry, false);
  });

  test("long descriptions use the store's cap before the public trim without a false unknown result", async () => {
    const { h, actions, stickers, data } = await setup();
    h.get("stickerDescription").value = "x".repeat(239) + " long tail";
    stickers.updateStickerDirty();
    h.setReply((_action, payload) => {
      const entry = publicStickerEntry({ ...data.stickers.entries[0], ...payload.patch,
        description: payload.patch.description.trim().slice(0, 240), allowedGroups: normalizeNumberList(payload.patch.allowedGroups) });
      return { entry, snapshot: { ...data.stickers, entries: [entry] } };
    });
    await actions.runAction("saveSticker");
    assert.equal(h.get("activityBar").classes.has("success"), true);
    assert.equal(h.get("stickerDescription").value, "x".repeat(239));
    assert.equal(stickers.updateStickerDirty().entry, false);
  });

  test("explicit refresh confirmation and background refresh keep separate meanings", async () => {
    const { h, actions, stickers, data } = await setup();
    h.get("stickerDescription").value = "Draft";
    stickers.updateStickerDirty();
    h.confirmationAnswers.push(false);
    h.setReply(() => data.stickers);
    await actions.runAction("refreshStickers");
    assert.equal(h.calls.length, 0);
    await actions.runAction("refreshStickers", null, { silent: true });
    assert.equal(h.calls.length, 1);
    assert.equal(h.get("stickerDescription").value, "Draft");
    await actions.runAction("refreshStickers");
    assert.equal(h.get("stickerDescription").value, "Original");
    assert.equal(stickers.stickerHasDrafts(), false);
  });

  test("log failures survive filtering and malformed partial refresh keeps fresh status", async () => {
    const { h, actions, logs, data } = await setup();
    logs.renderLogs(data.logs);
    h.setReply(() => { throw Object.assign(new Error("Synthetic read error"), { status: 503 }); });
    await actions.runAction("refreshLogs");
    h.get("logFilter").value = "fixture";
    logs.applyLogFilter();
    assert.match(h.get("logsOutput").textContent, /读取失败.*\n.*过期/);
    h.setReply(action => action === "getTasks" ? { tasks: [] } : ({ status: data.status, logs: { current: { lines: [null] } } }));
    await actions.runAction("refresh");
    assert.match(h.get("lastUpdated").textContent, /刚刚刷新/);
    assert.match(h.get("logsOutput").textContent, /格式错误/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
  });

  test("a failed task refresh never turns a newly read Bridge status into an old snapshot", async () => {
    const { h, actions, data } = await setup();
    h.setReply(action => {
      if (action === "getTasks") throw Object.assign(new Error("Task read failed"), { status: 503 });
      return { status: data.status, logs: data.logs };
    });
    await actions.runAction("refresh");
    assert.match(h.get("lastUpdated").textContent, /刚刚刷新/);
    assert.match(h.get("activityTitle").textContent, /部分刷新/);
    assert.match(h.get("managedTaskNotice").textContent, /任务读取失败/);
    assert.equal(h.get("activityBar").classes.has("success"), false);
  });

  test("loading stickers keeps writes disabled until the actual read settles", async () => {
    const { h, actions, stickers, data } = await setup();
    const gate = deferred(); h.setReply(() => gate.promise);
    const pending = actions.runAction("refreshStickers"); await flush();
    assert.equal(stickers.canWriteStickers("saveSticker"), false);
    gate.resolve(data.stickers); await pending;
    assert.equal(stickers.canWriteStickers("saveSticker"), true);
  });

  for (const action of ["createBackup", "health"]) {
    for (const result of [{}, { message: "Looks successful" }, { ok: true }]) {
      test(action + " incomplete HTTP 200 response is not green success", async () => {
        const { h, actions } = await setup(); h.setReply(() => result);
        await actions.runAction(action);
        assert.equal(h.get("activityBar").classes.has("success"), false);
        assert.match(h.get(action === "health" ? "serviceOutput" : "actionOutput").textContent, /结果未确认/);
        assert.equal(h.calls.length, 1);
      });
    }
  }

  test("Linux log action becomes real navigation, not a pretend opened directory", async () => {
    const { h, actions } = await setup();
    actions.configureRuntimeUi();
    assert.equal(h.select('[data-action="openLogs"]').dataset.view, "logs");
    assert.equal(h.select('[data-action="openLogs"]').textContent, "查看日志");
    assert.equal(h.calls.length, 0);
  });
}
