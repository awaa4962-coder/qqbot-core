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
