import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";
import test, { beforeEach } from "node:test";
import { handleAdminApiRequest } from "../bridge/admin-api/index.mjs";
import { readMemeArchive } from "../bridge/knowledge/memes/archive.mjs";

let memeFilePath;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-admin-meme-archive-"));
  memeFilePath = path.join(dir, "memes.json");
  fs.writeFileSync(memeFilePath, JSON.stringify({ version: 3, mode: "steady", entries: [{
    name: "人工旧词", meaning: "原有释义", usage: "原有用法", manualFields: ["meaning"],
    scope: { type: "groups", groupIds: ["2000000001"] }, userHashes: ["private-hash"],
    sources: [{ url: "https://example.com/?secret=private-value" }],
  }], candidates: { secret: { rawText: "private group message" } } }));
});

test("admin memes route exposes a readonly archive without group identifiers or source payloads", async () => {
  const result = await callAdminRoute("GET");
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.retired, true);
  assert.equal(result.payload.readonly, true);
  assert.equal(result.payload.entries[0].name, "人工旧词");
  assert.deepEqual(result.payload.editableFields, []);
  for (const value of ["2000000001", "private-hash", "private group message", "private-value"]) {
    assert.equal(JSON.stringify(result.payload).includes(value), false);
  }
});

test("retired admin route refuses saves toggles and deletes without changing archive bytes", async () => {
  const before = fs.readFileSync(memeFilePath);
  for (const action of ["save", "enable", "disable", "delete", "set-mode", "activate", "decay"]) {
    const result = await callAdminRoute("POST", { action, name: "人工旧词", mode: "steady", entry: { name: "replacement" } });
    assert.equal(result.statusCode, 410);
    assert.equal(result.payload.code, "feature_retired");
    assert.deepEqual(fs.readFileSync(memeFilePath), before);
  }
});

test("manual protections remain visible in the archive but cannot be overwritten", async () => {
  const before = (await callAdminRoute("GET")).payload.entries[0];
  assert.equal(before.manualProtected, true);
  assert.equal(before.groupCount, 1);
  assert.equal(before.sourceCount, 1);
  await callAdminRoute("POST", { action: "save", entry: { name: "人工旧词", meaning: "replacement", manualFields: [] } });
  assert.deepEqual((await callAdminRoute("GET")).payload.entries[0], before);
});

test("retired history restore cannot modify the original archive", async () => {
  const before = fs.readFileSync(memeFilePath);
  const result = await callAdminRoute("POST", { action: "restore-history", revisionId: "old-revision" });
  assert.equal(result.statusCode, 410);
  assert.deepEqual(fs.readFileSync(memeFilePath), before);
});

test("legacy dictionary import and web update actions remain explicitly retired", async () => {
  for (const action of ["import-china-dictionary", "run-web-update", "research-web"]) {
    const result = await callAdminRoute("POST", { action, query: "旧词" });
    assert.equal(result.statusCode, 410);
    assert.match(result.payload.error, /已停用/);
  }
});

test("retired web rollback reports retirement instead of pretending an operation succeeded", async () => {
  const result = await callAdminRoute("POST", { action: "rollback-web-update" });
  assert.equal(result.statusCode, 410);
  assert.equal(result.payload.ok, false);
});

test("reading an empty archive never restores removed builtin entries", async () => {
  fs.writeFileSync(memeFilePath, '{"version":3,"entries":[],"tombstones":[{"name":"哈基米"}]}');
  const before = fs.readFileSync(memeFilePath);
  for (let count = 0; count < 2; count++) assert.deepEqual((await callAdminRoute("GET")).payload.entries, []);
  assert.deepEqual(fs.readFileSync(memeFilePath), before);
});

test("archive read and retired writes retain administrator authentication", async () => {
  for (const method of ["GET", "POST"]) {
    const result = await callAdminRoute(method, method === "POST" ? { action: "save" } : null, "203.0.113.10");
    assert.equal(result.statusCode, 403);
    assert.equal(result.payload.entries, undefined);
  }
});

async function callAdminRoute(method, body = null, remoteAddress = "127.0.0.1") {
  const writes = [];
  const req = body === null ? new Readable({ read() { this.push(null); } }) : Readable.from([JSON.stringify(body)]);
  Object.assign(req, { method, url: "/admin/memes", socket: { remoteAddress }, headers: {} });
  assert.equal(await handleAdminApiRequest(req, {}, {
    pathname: "/admin/memes", url: new URL("http://localhost/admin/memes"),
    loadMemeArchive: () => readMemeArchive({ filename: memeFilePath }),
    sendJson(_res, statusCode, payload) { writes.push({ statusCode, payload }); },
  }), true);
  return writes[0];
}
