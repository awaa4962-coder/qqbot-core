import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";

import {
  buildEditableConfigSnapshot,
  handleAdminApiRequest,
  normalizeEditablePayload,
  saveEditableConfig,
} from "../bridge/admin-api/index.mjs";

test("editable admin config snapshot excludes unsafe fields", () => {
  const snapshot = buildEditableConfigSnapshot({
    root: os.tmpdir(),
    cfg: {
      botNames: ["夜星"],
      groupWhitelist: [1],
      summaryGroupWhitelist: [2],
      resourceGroupWhitelist: [3],
      featureGroupWhitelist: [9],
      friendWhitelist: [4],
      jmUserWhitelist: [8],
      botBlacklist: [5],
      adminUins: ["6"],
    },
    longGroups: ["7"],
  });

  assert.deepEqual(snapshot.editable.botNames, ["夜星"]);
  assert.ok(snapshot.unsafeFieldsExcluded.includes("mimoKey"));
  assert.equal(snapshot.files.botNames.status, "editable-create-on-save");
  assert.equal(snapshot.files.botNames.writable, true);
  assert.ok(snapshot.fileStatusLegend["editable-create-on-save"]);
  assert.equal(JSON.stringify(snapshot).includes("raw"), false);
});

test("normalizes editable config and rejects unknown fields", () => {
  const normalized = normalizeEditablePayload({
    editable: {
      botNames: "夜星 QQFriend 夜星",
      groupWhitelist: ["2000000001", "2000000001", 2000000002],
      featureGroupWhitelist: "2000000001 2000000002",
      jmUserWhitelist: "1000000002",
      adminUins: "1000000002",
    },
  });

  assert.deepEqual(normalized.botNames, ["夜星", "QQFriend"]);
  assert.deepEqual(normalized.groupWhitelist, ["2000000001", "2000000002"]);
  assert.deepEqual(normalized.featureGroupWhitelist, ["2000000001", "2000000002"]);
  assert.deepEqual(normalized.jmUserWhitelist, ["1000000002"]);
  assert.deepEqual(normalized.adminUins, ["1000000002"]);
  assert.throws(() => normalizeEditablePayload({ mimoKey: "secret" }), /unsupported config field/);
  assert.throws(() => normalizeEditablePayload({ groupWhitelist: ["abc"] }), /invalid groupWhitelist/);
});

test("saveEditableConfig writes only mapped non-secret files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-admin-config-"));
  const result = saveEditableConfig({
    editable: {
      botNames: ["夜星", "Yexing"],
      groupWhitelist: [2000000001],
      summaryGroupWhitelist: [],
      featureGroupWhitelist: [2000000001, 2000000002],
      jmUserWhitelist: [1000000002],
    },
  }, { root });

  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
  assert.equal(fs.readFileSync(path.join(root, ".env_bot_names"), "utf8"), "夜星\nYexing\n");
  assert.equal(fs.readFileSync(path.join(root, ".env_groups"), "utf8"), "2000000001\n");
  assert.equal(fs.readFileSync(path.join(root, ".env_summary_groups"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(root, ".env_feature_groups"), "utf8"), "2000000001\n2000000002\n");
  assert.equal(fs.readFileSync(path.join(root, ".env_jm_users"), "utf8"), "1000000002\n");
  assert.equal(fs.existsSync(path.join(root, ".env_mimo")), false);
});

test("admin config route validates POST body", async () => {
  const writes = [];
  const req = Readable.from([Buffer.from(JSON.stringify({ unknown: "x" }))]);
  Object.assign(req, {
    method: "POST",
    url: "/admin/config",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  });

  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/config",
    url: new URL("http://localhost/admin/config"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 400);
  assert.match(writes[0].payload.error, /unsupported config field/);
});

test("saved config survives refresh and a second full-form save before restart", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-config-pending-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = editableConfigFixture();
  const options = { root, cfg, longGroups: [], env: {} };

  saveEditableConfig({ groupWhitelist: [], adminUins: [] }, options);
  const snapshot = buildEditableConfigSnapshot(options);
  assert.deepEqual(snapshot.editable.groupWhitelist, []);
  assert.deepEqual(snapshot.editable.adminUins, []);
  assert.deepEqual(snapshot.effective.groupWhitelist, [123456]);
  assert.deepEqual(snapshot.effective.adminUins, ["345678"]);
  assert.equal(snapshot.pendingRestart, true);
  assert.equal(snapshot.files.groupWhitelist.pendingRestart, true);

  saveEditableConfig({ editable: { ...snapshot.editable, friendWhitelist: [456789] } }, options);
  const refreshed = buildEditableConfigSnapshot(options);
  assert.deepEqual(refreshed.editable.groupWhitelist, []);
  assert.deepEqual(refreshed.editable.adminUins, []);
  assert.deepEqual(refreshed.editable.friendWhitelist, [456789]);
  assert.equal(fs.readFileSync(path.join(root, ".env_groups"), "utf8"), "");
  assert.deepEqual(cfg.groupWhitelist, [123456]);

  const restarted = buildEditableConfigSnapshot({ ...options, cfg: refreshed.editable });
  assert.equal(restarted.pendingRestart, false);
});

test("environment-controlled lists are readonly and reject changes before any write", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-config-environment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".env_groups"), "234567\n");
  const options = { root, cfg: editableConfigFixture(), longGroups: [], env: { QQBOT_GROUPS: "123456" } };
  const snapshot = buildEditableConfigSnapshot(options);
  assert.deepEqual(snapshot.editable.groupWhitelist, [123456]);
  assert.equal(snapshot.files.groupWhitelist.source, "environment");
  assert.equal(snapshot.files.groupWhitelist.status, "environment-override");
  assert.equal(snapshot.files.groupWhitelist.writable, false);
  assert.equal(snapshot.pendingRestart, false);
  assert.throws(() => saveEditableConfig({ botNames: ["Changed"], groupWhitelist: [] }, options), /controlled by.*QQBOT_GROUPS/);
  assert.equal(fs.existsSync(path.join(root, ".env_bot_names")), false);
  assert.equal(fs.readFileSync(path.join(root, ".env_groups"), "utf8"), "234567\n");

  const result = saveEditableConfig({ groupWhitelist: [123456], friendWhitelist: [456789] }, options);
  assert.deepEqual(result.saved.map(item => item.field), ["friendWhitelist"]);
  assert.equal(fs.readFileSync(path.join(root, ".env_groups"), "utf8"), "234567\n");
  const emptyEnv = { ...options, env: { QQBOT_GROUPS: "" } };
  assert.deepEqual(buildEditableConfigSnapshot(emptyEnv).editable.groupWhitelist, []);
  assert.throws(() => saveEditableConfig({ groupWhitelist: [123456] }, emptyEnv), /controlled by/);
  const defaultNames = { ...options, env: { QQBOT_NAMES: "", QQBOT_GROUPS: "123456 123456" } };
  const defaults = buildEditableConfigSnapshot(defaultNames);
  assert.deepEqual(defaults.editable.botNames, options.cfg.botNames);
  assert.equal(defaults.files.botNames.writable, false);
  assert.doesNotThrow(() => saveEditableConfig({ editable: defaults.editable }, defaultNames));
  assert.equal(fs.existsSync(path.join(root, ".env_bot_names")), false);
});

test("config snapshot does not replace an unreadable saved allowlist with active values", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-config-denied-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === path.join(root, ".env_groups")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return read(file, ...args);
  });
  assert.throws(() => buildEditableConfigSnapshot({ root, cfg: editableConfigFixture(), env: {} }), /cannot read config list.*EACCES/);
});

function editableConfigFixture() {
  return {
    botNames: ["SyntheticBot"], groupWhitelist: [123456], adminUins: ["345678"],
    summaryGroupWhitelist: [], resourceGroupWhitelist: [], featureGroupWhitelist: [],
    conversationSummaryGroupWhitelist: [], stickerGroupWhitelist: [], friendWhitelist: [],
    jmUserWhitelist: [], botBlacklist: [],
  };
}
