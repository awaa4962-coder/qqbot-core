import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { beforeEach, describe, it } from "node:test";

import { buildCommandReply } from "../bridge/commands/index.mjs";
import { buildReplyContextPacket } from "../bridge/context/index.mjs";
import {
  buildMemeContextBlock,
  buildMemeSearchReply,
  buildMemeStatusReply,
  cleanupStaleMemeTempFiles,
  flushMemeStoreSync,
  getMemeStore,
  getMemeStorePath,
  matchMemes,
  observeMemeUsage,
  resetMemeStoreForTest,
  setMemeMode,
  setMemeStorePath,
  upsertMeme,
} from "../bridge/knowledge/memes/index.mjs";

function useTempMemeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memes-"));
  setMemeStorePath(path.join(dir, "memes.json"));
}

describe("meme knowledge", () => {
  beforeEach(() => {
    resetMemeStoreForTest();
    useTempMemeStore();
  });

  it("loads builtin seed memes and injects understanding-only context", () => {
    const matches = matchMemes("哈吉米启动");
    assert.ok(matches.some(item => item.name === "哈基米"));

    const block = buildMemeContextBlock({ text: "哈吉米启动" });
    assert.match(block, /梗库语境提示/);
    assert.match(block, /只帮助理解/);
    assert.match(block, /不要求主动复读梗/);
  });

  it("cleans only stale atomic-save temp files", () => {
    const storeFile = getMemeStorePath();
    const directory = path.dirname(storeFile);
    const stale = storeFile + ".tmp.stale";
    const fresh = storeFile + ".tmp.fresh";
    const unrelated = path.join(directory, "unrelated.tmp");
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(unrelated, "keep");
    const now = Date.now();
    const old = new Date(now - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const result = cleanupStaleMemeTempFiles({ now, maxAgeMs: 24 * 60 * 60 * 1000 });
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(unrelated), true);
  });

  it("does not turn unknown group fragments into candidates", () => {
    for (let index = 0; index < 20; index++) {
      observeMemeUsage({
        groupId: 1,
        uid: 10 + index,
        text: "猫雷猫雷场景" + index,
        now: index + 1,
      });
    }

    assert.deepEqual(getMemeStore().candidates, {});
    assert.equal(matchMemes("猫雷是什么", { groupId: 1 }).length, 0);
    assert.equal(buildMemeSearchReply("猫雷").includes("等待联网更新查证"), true);
  });

  it("tracks use of known entries without storing group message text", () => {
    const before = getMemeStore().entries.find(item => item.name === "哈基米").seenCount;
    const touched = observeMemeUsage({
      groupId: 1,
      uid: 11,
      text: "哈吉米启动",
      now: Date.now(),
    });
    const entry = getMemeStore().entries.find(item => item.name === "哈基米");

    assert.ok(touched.includes("哈基米"));
    assert.equal(entry.seenCount, before + 1);
    assert.equal(JSON.stringify(getMemeStore()).includes("哈吉米启动"), false);
  });

  it("matches verified web entries only inside their configured scope", () => {
    upsertMeme(verifiedEntry("猫雷", { type: "groups", groupIds: ["1"] }));

    assert.ok(matchMemes("猫雷是什么", { groupId: 1 }).some(item => item.name === "猫雷"));
    assert.equal(matchMemes("猫雷是什么", { groupId: 2 }).some(item => item.name === "猫雷"), false);
    assert.match(buildMemeSearchReply("猫雷"), /联网查证/);
  });

  it("supports status, search, and admin toggle commands", () => {
    assert.match(buildCommandReply("梗库", { userId: 1 }), /梗库状态/);
    assert.match(buildCommandReply("梗库 搜 哈基米", { userId: 1 }), /哈基米/);

    const denied = buildCommandReply("梗库 禁用 哈基米", { userId: 1, admins: ["42"] });
    assert.match(denied, /管理员权限|权限/);

    const disabled = buildCommandReply("梗库 禁用 哈基米", { userId: 42, admins: ["42"] });
    assert.match(disabled, /已禁用梗：哈基米/);
    assert.equal(matchMemes("哈基米").length, 0);

    const enabled = buildCommandReply("梗库 启用 哈基米", { userId: 42, admins: ["42"] });
    assert.match(enabled, /已启用梗：哈基米/);
    assert.ok(matchMemes("哈基米").length > 0);
  });

  it("adds meme hints into reply context when current text hits a meme", () => {
    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "哈基米启动",
      mode: "group-at",
    });

    assert.ok(packet.messages.some(item => item.content.includes("梗库语境提示")));
  });

  it("uses only manual and builtin entries in conservative mode", () => {
    upsertMeme(verifiedEntry("猫雷"));
    assert.ok(matchMemes("猫雷").length > 0);

    setMemeMode("shadow");
    assert.equal(matchMemes("猫雷").length, 0);
    assert.ok(matchMemes("哈基米").length > 0);
  });

  it("persists known meme usage when flushed", () => {
    const filePath = path.join(os.tmpdir(), "qqfriend-memes-flush-" + process.pid + ".json");
    setMemeStorePath(filePath);
    observeMemeUsage({ groupId: 1, uid: 11, text: "哈吉米启动", now: Date.now() });
    flushMemeStoreSync();

    const raw = fs.readFileSync(filePath, "utf8");
    assert.match(raw, /哈基米/);
    assert.equal(raw.includes("哈吉米启动"), false);
  });

  it("reports web verification and manual override policy", () => {
    assert.match(buildMemeStatusReply(), /群消息只统计已知梗/);
    assert.match(buildMemeStatusReply(), /人工修改优先/);
  });
});

function verifiedEntry(name, scope = { type: "global", groupIds: [] }) {
  return {
    name,
    aliases: [],
    triggers: [name],
    meaning: "联网证据确认的稳定网络梗。",
    usage: "只在相关语境中辅助理解。",
    confidence: 0.9,
    semanticConfidence: 0.9,
    source: "web-verified",
    enabled: true,
    status: "active",
    scope,
    lastVerifiedAt: new Date().toISOString(),
  };
}
