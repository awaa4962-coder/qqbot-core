import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { URL } from "node:url";

import {
  getMemeStore,
  resetMemeStoreForTest,
  rollbackLastMemeUpdate,
  runMemeTrendUpdate,
  setMemeStorePath,
  upsertMeme,
} from "../bridge/knowledge/memes/index.mjs";
import {
  parseEvidenceReview,
  verifyMemeEvidenceBatch,
} from "../bridge/knowledge/memes/evidence-verifier.mjs";
import {
  filterRelevantMemeEvidence,
} from "../bridge/knowledge/memes/evidence-search.mjs";

const NOW = Date.parse("2026-07-31T00:00:00.000Z");

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-meme-updater-"));
  const filePath = path.join(dir, "memes.json");
  resetMemeStoreForTest(filePath);
  setMemeStorePath(filePath);
});

test("evidence verifier falls back to DeepSeek only after an invalid primary response", async () => {
  const calls = [];
  const result = await verifyMemeEvidenceBatch([reviewCandidate("哈基米")], {
    requestReview: async provider => {
      calls.push(provider);
      if (provider === "mimo") return "not json";
      return JSON.stringify([acceptedReview("哈基米")]);
    },
  });

  assert.deepEqual(calls, ["mimo", "deepseek"]);
  assert.equal(result[0].provider, "deepseek");
  assert.equal(result[0].isMeme, true);
});

test("evidence parser ignores model-invented terms", () => {
  const parsed = parseEvidenceReview(JSON.stringify([
    acceptedReview("真实候选"),
    acceptedReview("模型瞎编"),
  ]), [reviewCandidate("真实候选")], "mimo");

  assert.deepEqual(parsed.map(item => item.term), ["真实候选"]);
});

test("evidence relevance gate removes unrelated search noise", () => {
  const evidence = filterRelevantMemeEvidence("哈基米", [
    evidenceItem("https://example.com/a", "哈基米是什么意思", "哈基米"),
    evidenceItem("https://example.org/b", "完全无关的驾驶手册", "驾驶证考试"),
    evidenceItem("https://example.net/c", "普通服务页面", "网络服务状态"),
  ]);

  assert.deepEqual(evidence.map(item => item.url), ["https://example.com/a"]);
});

test("web updater stores only evidence-backed reviewed entries", async () => {
  const result = await runInjectedUpdate();
  const entry = getMemeStore().entries.find(item => item.name === "新梗测试");

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(entry.source, "web-verified");
  assert.equal(entry.meaning, "这是经网页证据确认的网络梗。");
  assert.equal(entry.sources.length >= 3, true);
  assert.equal(getMemeStore().sync.lastSuccessAt, new Date(NOW).toISOString());
});

test("insufficient independent evidence never creates an entry", async () => {
  const result = await runInjectedUpdate({
    searchEvidence: async term => evidenceItems(term).slice(0, 1),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reviewed, 0);
  assert.equal(getMemeStore().entries.some(item => item.name === "新梗测试"), false);
});

test("model approval without independent evidence citations is rejected", async () => {
  const result = await runInjectedUpdate({
    verifyBatch: async candidates => candidates.map(item => ({
      ...acceptedReview(item.term),
      evidenceIndexes: [],
    })),
  });

  assert.equal(result.accepted, 0);
  assert.equal(getMemeStore().entries.some(item => item.name === "新梗测试"), false);
});

test("source failure keeps existing meme entries unchanged", async () => {
  upsertMeme(manualEntry("人工保留"));
  const before = JSON.stringify(getMemeStore().entries);
  const result = await runMemeTrendUpdate({
    force: true,
    lock: false,
    now: NOW,
    collectors: [{
      name: "broken",
      collect: async () => {
        throw new Error("offline");
      },
    }],
  });

  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(getMemeStore().entries), before);
  assert.match(getMemeStore().sync.error, /来源|数据/);
});

test("repeated verified updates do not duplicate a term", async () => {
  await runInjectedUpdate();
  await runInjectedUpdate({ now: NOW + 8 * 24 * 60 * 60 * 1000 });

  const matches = getMemeStore().entries.filter(item => item.name === "新梗测试");
  assert.equal(matches.length, 1);
});

test("manual field locks survive a later scheduled update", async () => {
  await runInjectedUpdate();
  const entry = getMemeStore().entries.find(item => item.name === "新梗测试");
  entry.meaning = "人工修正含义。";
  entry.manualFields = ["meaning"];

  await runInjectedUpdate({
    now: NOW + 8 * 24 * 60 * 60 * 1000,
    verifyBatch: async candidates => candidates.map(item => ({
      ...acceptedReview(item.term),
      meaning: "联网的新含义。",
    })),
  });

  assert.equal(
    getMemeStore().entries.find(item => item.name === "新梗测试").meaning,
    "人工修正含义。",
  );
});

test("the last web update can be rolled back in one action", async () => {
  await runInjectedUpdate();
  const rolledBack = rollbackLastMemeUpdate();

  assert.equal(rolledBack.restored, 1);
  assert.equal(getMemeStore().entries.some(item => item.name === "新梗测试"), false);
  assert.equal(getMemeStore().sync.accepted, 0);
  assert.equal(getMemeStore().sync.runs.at(-1).status, "rolled-back");
});

async function runInjectedUpdate(overrides = {}) {
  const options = {
    force: true,
    lock: false,
    now: NOW,
    collectors: [{
      name: "test-trends",
      collect: async () => ({
        items: [{
          term: "新梗测试",
          title: "新梗测试",
          platform: "weibo",
          rank: 1,
          url: "https://weibo.com/hot/test",
          observedAt: new Date(NOW).toISOString(),
        }],
        statuses: {
          weibo: {
            ok: true,
            count: 1,
            fetchedAt: new Date(NOW).toISOString(),
            error: "",
          },
        },
      }),
    }],
    searchEvidence: async term => evidenceItems(term),
    verifyBatch: async candidates => candidates.map(item => acceptedReview(item.term)),
    ...overrides,
  };
  return await runMemeTrendUpdate(options);
}

function reviewCandidate(term) {
  return {
    term,
    platforms: ["weibo"],
    evidence: evidenceItems(term),
  };
}

function acceptedReview(term) {
  return {
    term,
    isMeme: true,
    canonicalName: term,
    aliases: [],
    meaning: "这是经网页证据确认的网络梗。",
    usage: "只在相关玩梗语境中使用。",
    examples: ["这里可以自然地接这个梗。"],
    evidenceIndexes: [0, 1, 2],
    confidence: 0.91,
    reason: "多个独立来源均说明其固定含义和用法。",
  };
}

function evidenceItems(term = "新梗测试") {
  return [
    evidenceItem("https://example.com/a", `${term} 来源甲`, term),
    evidenceItem("https://example.org/b", `${term} 来源乙`, term),
    evidenceItem("https://example.net/c", `${term} 来源丙`, term),
  ];
}

function evidenceItem(url, title, term) {
  return {
    platform: new URL(url).hostname,
    url,
    title,
    snippet: `${term} 是这段网页证据直接讨论的表达，这里明确说明它的网络含义、出处以及常见用法。`,
    fetchedAt: new Date(NOW).toISOString(),
    kind: "web",
  };
}

function manualEntry(name) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "人工解释",
    usage: "人工用法",
    confidence: 0.95,
    semanticConfidence: 0.95,
    source: "manual",
    enabled: true,
    status: "active",
  };
}
