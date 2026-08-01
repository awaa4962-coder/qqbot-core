import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";
import test, { beforeEach } from "node:test";

import { handleAdminApiRequest } from "../bridge/admin-api/index.mjs";
import {
  applyMemeUpdateBatch,
  observeMemeUsage,
  resetMemeStoreForTest,
  setMemeStorePath,
} from "../bridge/knowledge/memes/index.mjs";

let memeFilePath = "";

beforeEach(() => {
  resetMemeStoreForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-admin-memes-"));
  memeFilePath = path.join(dir, "memes.json");
  setMemeStorePath(memeFilePath);
});

test("admin memes route exposes v3 editor data without group message text", async () => {
  observeMemeUsage({ groupId: 1, uid: 11, text: "猫雷今天也太猫雷了", now: 1 });
  const payload = await callAdminRoute("GET", "/admin/memes");

  assert.equal(payload.version, 3);
  assert.ok(payload.entries.some(entry => entry.name === "哈基米"));
  assert.deepEqual(payload.candidates, []);
  assert.equal(JSON.stringify(payload).includes("猫雷今天也太猫雷了"), false);
  assert.ok(payload.editableFields.includes("examples"));
  assert.ok(payload.editableFields.includes("sources"));
  assert.ok(Array.isArray(payload.history));
});

test("admin memes route saves toggles and deletes entries", async () => {
  const saved = await callAdminRoute("POST", "/admin/memes", {
    action: "save",
    entry: editableEntry("猫雷"),
  });
  assert.equal(saved.entry.name, "猫雷");
  assert.equal(saved.entry.enabled, true);

  const disabled = await callAdminRoute("POST", "/admin/memes", {
    action: "disable",
    name: "猫雷",
  });
  assert.equal(disabled.entry.enabled, false);

  const deleted = await callAdminRoute("POST", "/admin/memes", {
    action: "delete",
    name: "猫雷",
  });
  assert.equal(deleted.deleted.name, "猫雷");
  assert.equal(deleted.snapshot.entries.some(entry => entry.name === "猫雷"), false);
  assert.ok(deleted.snapshot.history.length >= 3);
});

test("admin editor can protect selected fields on a web-verified entry", async () => {
  applyMemeUpdateBatch([verifiedEntry("芭比Q了")], { runId: "seed-web" });
  const saved = await callAdminRoute("POST", "/admin/memes", {
    action: "save",
    entry: {
      ...editableEntry("芭比Q了"),
      originalName: "芭比Q了",
      meaning: "人工核对后的解释。",
      examples: ["这下芭比Q了。"],
      sources: [{
        platform: "manual",
        title: "人工资料",
        url: "https://example.com/meme",
      }],
      scope: { type: "groups", groupIds: ["2000000001"] },
      manualFields: ["meaning", "examples", "sources", "scope"],
    },
  });

  assert.equal(saved.entry.source, "web-verified");
  assert.equal(saved.entry.meaning, "人工核对后的解释。");
  assert.deepEqual(saved.entry.examples, ["这下芭比Q了。"]);
  assert.equal(saved.entry.sources[0].url, "https://example.com/meme");
  assert.deepEqual(saved.entry.scope.groupIds, ["2000000001"]);
  assert.ok(saved.entry.manualFields.includes("meaning"));
  assert.equal(saved.entry.manualFields.includes("usage"), false);
});

test("admin history restores the content from before an edit", async () => {
  await callAdminRoute("POST", "/admin/memes", {
    action: "save",
    entry: editableEntry("历史测试", { meaning: "第一版解释。" }),
  });
  const edited = await callAdminRoute("POST", "/admin/memes", {
    action: "save",
    entry: editableEntry("历史测试", {
      originalName: "历史测试",
      meaning: "第二版解释。",
    }),
  });
  const revision = edited.snapshot.history.find(item =>
    item.term === "历史测试" && item.action === "edit"
  );
  assert.ok(revision?.id);

  const restored = await callAdminRoute("POST", "/admin/memes", {
    action: "restore-history",
    revisionId: revision.id,
  });
  const entry = restored.snapshot.entries.find(item => item.name === "历史测试");
  assert.equal(entry.meaning, "第一版解释。");

  const restoreRevision = restored.snapshot.history.find(item =>
    item.term === "历史测试" && item.action === "restore"
  );
  assert.ok(restoreRevision?.id);
  const undone = await callAdminRoute("POST", "/admin/memes", {
    action: "restore-history",
    revisionId: restoreRevision.id,
  });
  assert.equal(
    undone.snapshot.entries.find(item => item.name === "历史测试")?.meaning,
    "第二版解释。",
  );
});

test("legacy dictionary admin actions are no longer accepted", async () => {
  const result = await callAdminRouteResult("POST", "/admin/memes", {
    action: "import-china-dictionary",
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.payload.error, /unknown meme action/);
});

test("admin rollback reports clearly when there is no web update", async () => {
  const result = await callAdminRouteResult("POST", "/admin/memes", {
    action: "rollback-web-update",
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.payload.error, /没有可以回退/);
});

test("admin memes delete keeps removed builtin entries from reviving on reload", async () => {
  await callAdminRoute("POST", "/admin/memes", { action: "delete", name: "哈基米" });
  setMemeStorePath(memeFilePath);
  const payload = await callAdminRoute("GET", "/admin/memes");

  assert.equal(payload.entries.some(entry => entry.name === "哈基米"), false);
});

function editableEntry(name, overrides = {}) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "群内抽象表达。",
    usage: "玩梗时轻量接住，正事只理解。",
    examples: [],
    sources: [],
    confidence: 0.72,
    level: "A",
    enabled: true,
    status: "active",
    scope: { type: "global", groupIds: [] },
    ...overrides,
  };
}

function verifiedEntry(name) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "联网解释。",
    usage: "联网用法。",
    examples: [],
    sources: [],
    confidence: 0.9,
    semanticConfidence: 0.9,
    source: "web-verified",
    enabled: true,
    status: "active",
    scope: { type: "global", groupIds: [] },
    lastVerifiedAt: new Date().toISOString(),
  };
}

async function callAdminRoute(method, pathname, body = null) {
  const result = await callAdminRouteResult(method, pathname, body);
  assert.equal(result.statusCode, 200);
  return result.payload;
}

async function callAdminRouteResult(method, pathname, body = null) {
  const writes = [];
  const req = body === null
    ? new Readable({ read() { this.push(null); } })
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url: pathname,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  });

  const handled = await handleAdminApiRequest(req, {}, {
    pathname,
    url: new URL("http://localhost" + pathname),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  return writes[0];
}
