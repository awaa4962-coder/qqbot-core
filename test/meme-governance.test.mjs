import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

import {
  applyMemeUpdateBatch,
  deleteMeme,
  flushMemeStoreSync,
  getMemeStore,
  observeMemeUsage,
  resetMemeStoreForTest,
  rollbackLastMemeUpdate,
  setMemeStorePath,
  upsertMeme,
} from "../bridge/knowledge/memes/index.mjs";

let dir;
let filePath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-meme-v3-"));
  filePath = path.join(dir, "memes.json");
  resetMemeStoreForTest(filePath);
  setMemeStorePath(filePath);
});

test("deleting an entry writes a tombstone and group text cannot revive it", () => {
  upsertMeme(manualEntry("复活测试"), { markManual: true });
  observeMemeUsage({ groupId: 1, uid: 11, text: "复活测试复活测试", now: Date.now() });
  const deleted = deleteMeme("复活测试");
  flushMemeStoreSync();

  assert.equal(deleted.name, "复活测试");
  assert.equal(getMemeStore().entries.some(item => item.name === "复活测试"), false);
  assert.ok(getMemeStore().tombstones.some(item => item.name === "复活测试"));

  observeMemeUsage({ groupId: 1, uid: 12, text: "复活测试复活测试", now: Date.now() + 1 });
  assert.equal(getMemeStore().entries.some(item => item.name === "复活测试"), false);
  assert.deepEqual(getMemeStore().candidates, {});
});

test("manual fields survive later web verification updates", () => {
  upsertMeme({
    ...manualEntry("芭比Q了"),
    meaning: "这是本地人工解释。",
    usage: "这是本地人工用法。",
    examples: ["人工例句"],
  }, { markManual: true });

  applyMemeUpdateBatch([{
    ...verifiedEntry("芭比Q了"),
    meaning: "联网解释。",
    usage: "联网用法。",
    examples: ["联网例句"],
  }], { runId: "manual-protection" });

  const entry = getMemeStore().entries.find(item => item.name === "芭比Q了");
  assert.equal(entry.meaning, "这是本地人工解释。");
  assert.equal(entry.usage, "这是本地人工用法。");
  assert.deepEqual(entry.examples, ["人工例句"]);
  assert.ok(entry.manualFields.includes("meaning"));
});

test("legacy auto entries migrate into quarantine without raw evidence", () => {
  const legacy = {
    version: 1,
    mode: "steady",
    entries: [{
      name: "旧自动词",
      source: "auto",
      enabled: true,
      meaning: "旧数据",
      usage: "旧数据",
    }],
    candidates: {
      "旧自动词": {
        term: "旧自动词",
        count: 3,
        users: ["12345", "67890"],
        groups: ["10001"],
        contexts: ["这是一条原始上下文"],
      },
    },
    stats: { observedMessages: 100, promoted: 193 },
  };
  fs.writeFileSync(filePath, JSON.stringify(legacy), "utf8");
  setMemeStorePath(filePath);

  const entry = getMemeStore().entries.find(item => item.name === "旧自动词");
  assert.equal(getMemeStore().version, 3);
  assert.equal(getMemeStore().stats.promoted, 0);
  assert.equal(entry.status, "quarantined");
  assert.deepEqual(entry.scope, { type: "groups", groupIds: ["10001"] });
  assert.equal(JSON.stringify(getMemeStore()).includes("12345"), false);
  assert.equal(JSON.stringify(getMemeStore()).includes("这是一条原始上下文"), false);
  assert.equal(fs.existsSync(filePath + ".v1-backup.json"), true);
});

test("v2 migration clears all fragmented candidates", () => {
  const candidates = Object.fromEntries(Array.from({ length: 505 }, (_, index) => [
    "候选" + index,
    {
      term: "候选" + index,
      count: index + 1,
      confidence: index / 505,
      source: "auto",
      status: "candidate",
    },
  ]));
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2,
    mode: "steady",
    entries: [],
    candidates,
    migration: { fromVersion: 2 },
    sync: {
      source: "WenKanghwdd/china-meme-dictionary",
      lastSuccessAt: "2026-07-01T00:00:00.000Z",
      accepted: 12,
    },
  }), "utf8");

  setMemeStorePath(filePath);
  assert.equal(Object.keys(getMemeStore().candidates).length, 0);
  assert.equal(getMemeStore().sync.source, "public-web-trends-v1");
  assert.equal(getMemeStore().sync.lastSuccessAt, "");
  assert.equal(getMemeStore().sync.accepted, 0);
});

test("a verified update batch can be rolled back as one unit", () => {
  applyMemeUpdateBatch([
    verifiedEntry("联网甲"),
    verifiedEntry("联网乙"),
  ], { runId: "batch-1" });
  assert.ok(getMemeStore().entries.some(item => item.name === "联网甲"));

  const result = rollbackLastMemeUpdate();
  assert.equal(result.runId, "batch-1");
  assert.equal(result.restored, 2);
  assert.equal(getMemeStore().entries.some(item => item.name === "联网甲"), false);
  assert.equal(getMemeStore().entries.some(item => item.name === "联网乙"), false);
});

test("corrupt primary store recovers from last-good snapshot", () => {
  upsertMeme(manualEntry("恢复甲"), { markManual: true });
  flushMemeStoreSync();
  upsertMeme(manualEntry("恢复乙"), { markManual: true });
  flushMemeStoreSync();
  fs.writeFileSync(filePath, "{broken", "utf8");

  setMemeStorePath(filePath);
  assert.ok(getMemeStore().entries.some(item => item.name === "恢复甲"));
  assert.equal(getMemeStore().entries.some(item => item.name === "恢复乙"), false);
  assert.ok(fs.readdirSync(dir).some(name => name.includes(".corrupt-")));
});

function manualEntry(name) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "人工解释",
    usage: "人工用法",
    confidence: 0.9,
    semanticConfidence: 0.9,
    source: "manual",
    enabled: true,
    status: "active",
  };
}

function verifiedEntry(name) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "联网解释",
    usage: "联网用法",
    confidence: 0.9,
    semanticConfidence: 0.9,
    source: "web-verified",
    enabled: true,
    status: "active",
    scope: { type: "global", groupIds: [] },
    lastVerifiedAt: new Date().toISOString(),
  };
}
