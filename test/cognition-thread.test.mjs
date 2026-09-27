import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  buildConversationThreadBlock,
  clearConversationThreads,
  getCognitionStatus,
  getConversationThread,
  recordConversationTurn,
  resetCognitionForTest,
} from "../bridge/cognition/index.mjs";

const users = {};

function resetState() {
  for (const key of Object.keys(users)) delete users[key];
  resetCognitionForTest();
}

describe("cognition conversation threads", () => {
  beforeEach(resetState);

  it("records bounded completed group turns and restores the active topic", () => {
    recordConversationTurn({
      uid: "42",
      groupId: "100",
      messageId: "m1",
      assistantMessageIds: ["9101", "9102", "bad-id"],
      userText: "JM 下载还是失败",
      assistantText: "检查到 jmcomic 依赖缺失。",
      now: 1000,
    }, { userStore: users, save: false });
    recordConversationTurn({
      uid: "42",
      groupId: "100",
      messageId: "m2",
      userText: "还是不行",
      assistantText: "继续检查 Python 运行时。",
      now: 2000,
    }, { userStore: users, save: false });

    const thread = getConversationThread("42", "100", { userStore: users, now: 2500 });
    assert.equal(thread.topic, "JM 下载");
    assert.equal(thread.turnCount, 2);
    assert.deepEqual(thread.turns[0].assistantMessageIds, ["9101", "9102"]);
    assert.equal(thread.privacy, "same-group-only");
    assert.match(buildConversationThreadBlock("42", "100", { userStore: users, now: 2500 }), /jmcomic 依赖缺失/);
  });

  it("keeps group scopes isolated and expires stale threads", () => {
    recordConversationTurn({
      uid: "42",
      groupId: "100",
      userText: "日报坏了",
      assistantText: "正在检查。",
      now: 1000,
    }, { userStore: users, save: false });

    assert.equal(getConversationThread("42", "200", { userStore: users, now: 2000 }), null);
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 1000 + 91 * 60 * 1000 }), null);
  });

  it("keeps private turns volatile and never writes them into the user store", () => {
    recordConversationTurn({
      uid: "42",
      groupId: "private",
      messageId: "p1",
      userText: "这是私聊问题",
      assistantText: "这是私聊答复",
      now: 1000,
    }, { userStore: users, save: false });

    const thread = getConversationThread("42", "private", { now: 2000 });
    assert.equal(thread.turnCount, 1);
    assert.equal(thread.privacy, "volatile-private");
    assert.equal(users["42"], undefined);
    assert.equal(getCognitionStatus({ userStore: users, now: 2000 }).privateThreads, 1);
  });

  it("replaces duplicate message ids and clears all scopes on forget", () => {
    const base = {
      uid: "42",
      groupId: "100",
      messageId: "same-message",
      userText: "代码报错",
      assistantText: "第一次回答",
      now: 1000,
    };
    recordConversationTurn(base, { userStore: users, save: false });
    recordConversationTurn({ ...base, assistantText: "修正回答", now: 2000 }, { userStore: users, save: false });
    recordConversationTurn({ ...base, groupId: "private", messageId: "private-message" }, { userStore: users, save: false });

    const thread = getConversationThread("42", "100", { userStore: users, now: 3000 });
    assert.equal(thread.turnCount, 1);
    assert.equal(thread.turns[0].assistantSummary, "修正回答");
    clearConversationThreads("42", { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 3000 }), null);
    assert.equal(getConversationThread("42", "private", { now: 3000 }), null);
  });

  it("keeps two group topics separate and restores the older one by selected id", () => {
    const base = { uid: "42", groupId: "100", memorySources: [], memoryExpiresAt: null };
    recordConversationTurn({ ...base, threadId: null, messageId: "m1", userText: "JM 压缩包解压失败",
      assistantText: "先检查 FS 密码。", now: 1000 }, { userStore: users, save: false });
    const jm = getConversationThread("42", "100", { userStore: users, now: 2000 });
    recordConversationTurn({ ...base, threadId: null, messageId: "m2", userText: "日报没生成",
      assistantText: "检查定时任务。", now: 2000 }, { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500 }).turns[0].messageId, "m2");
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500,
      forMessage: { uid: "42", userMsg: "JM 压缩包还打不开" } }).turns[0].messageId, "m1");
    recordConversationTurn({ ...base, threadId: jm.id, messageId: "m3", userText: "压缩包还是打不开",
      assistantText: "再核对下载文件。", now: 3000 }, { userStore: users, save: false });
    assert.deepEqual(getConversationThread("42", "100", { userStore: users, now: 3500 }).turns.map(turn => turn.messageId), ["m1", "m3"]);
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 3500,
      forMessage: { uid: "42", userMsg: "日报为什么没生成" } }).turns[0].messageId, "m2");
    assert.equal(getCognitionStatus({ userStore: users, now: 3500 }).topicBranches, 1);
    assert.equal(getCognitionStatus({ userStore: users, now: 3500 }).completedTurns, 3);
    const restored = JSON.parse(JSON.stringify(users));
    assert.equal(getConversationThread("42", "100", { userStore: restored, now: 3500,
      forMessage: { uid: "42", userMsg: "日报为什么没生成" } }).turns[0].messageId, "m2");
  });

  it("bounds inactive topics, quote selection and duplicate ids without crossing groups", () => {
    const base = { uid: "42", groupId: "100", memorySources: [], memoryExpiresAt: null };
    for (const [index, text] of ["JM 下载失败", "日报生成失败", "图片识别失败", "命令帮助看不懂"].entries()) {
      recordConversationTurn({ ...base, threadId: null, messageId: "m" + index,
        assistantMessageIds: ["9" + index], userText: text, assistantText: "合成回答" + index,
        now: (index + 1) * 1000 }, { userStore: users, save: false });
    }
    const stored = users["42"].cognition.threads["100"];
    assert.equal(stored.branches.length, 2);
    assert.equal(stored.branches.some(branch => branch.turns[0].messageId === "m0"), false);
    assert.equal(getConversationThread("42", "200", { userStore: users, now: 4500 }), null);
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 4500,
      forMessage: { uid: "42", userMsg: "这个呢", replyToMessageId: "92", replyUserId: "100", selfUin: "100" } }).turns[0].messageId, "m2");
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 4500,
      forMessage: { uid: "42", userMsg: "这个呢", replyToMessageId: "92", replyUserId: "77", selfUin: "100" } }), null);
    recordConversationTurn({ ...base, threadId: null, messageId: "m2", userText: "图片识别失败",
      assistantText: "修正回答", now: 5000 }, { userStore: users, save: false });
    const active = getConversationThread("42", "100", { userStore: users, now: 5500 });
    assert.equal(active.turns.length, 1);
    assert.equal(active.turns[0].assistantSummary, "修正回答");
    clearConversationThreads("42", { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 5500 }), null);
  });

  it("reads legacy single-thread records and does not revive expired topic branches", () => {
    users["42"] = { cognition: { schemaVersion: 1, threads: { "100": {
      schemaVersion: 1, scope: "100", topic: "JM 下载", createdAt: 1000, updatedAt: 1000,
      expiresAt: 1000 + 90 * 60 * 1000, lastOutcome: "sent",
      turns: [{ messageId: "m1", userSummary: "JM 下载失败", assistantSummary: "检查文件。" }],
    } } } };
    const legacy = getConversationThread("42", "100", { userStore: users, now: 2000 });
    assert.equal(legacy.schemaVersion, 1);
    assert.equal(legacy.turns[0].messageId, "m1");
    recordConversationTurn({ uid: "42", groupId: "100", threadId: legacy.id,
      messageId: "m2", userText: "还是不能下载", assistantText: "检查权限。", now: 2000 }, { userStore: users, save: false });
    assert.equal(users["42"].cognition.threads["100"].branches.length, 0);
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500 }).schemaVersion, 2);
    recordConversationTurn({ uid: "42", groupId: "100", threadId: null,
      messageId: "m3", userText: "日报坏了", assistantText: "检查定时任务。", now: 1000 + 89 * 60 * 1000 }, { userStore: users, save: false });
    const expired = getConversationThread("42", "100", { userStore: users, now: 1000 + 91 * 60 * 1000,
      forMessage: { uid: "42", userMsg: "JM 下载失败" } });
    assert.notEqual(expired?.id, legacy.id);
  });

  it("keeps legacy threads without topic readable until their next confirmed write", () => {
    users["42"] = { cognition: { schemaVersion: 1, threads: { "100": {
      schemaVersion: 1, scope: "100", createdAt: 1000, updatedAt: 1000,
      expiresAt: 1000 + 90 * 60 * 1000,
      turns: [{ messageId: "m1", userSummary: "JM 下载失败", assistantSummary: "检查文件。" }],
    } } } };
    const prior = getConversationThread("42", "100", { userStore: users, now: 2000 });
    assert.equal(prior.schemaVersion, 1);
    recordConversationTurn({ uid: "42", groupId: "100", threadId: prior.id, messageId: "m2",
      userText: "还是不行", assistantText: "检查权限。", now: 2000 }, { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500 }).turns.length, 2);
  });

  it("does not attach a new named topic merely because both messages say bot", () => {
    recordConversationTurn({ uid: "42", groupId: "100", threadId: null, messageId: "m1",
      userText: "机器人 JM 下载失败", assistantText: "检查下载日志。", now: 1000 }, { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2000,
      forMessage: { uid: "42", userMsg: "机器人日报没生成" } }), null);
  });

  it("can recall an unlabeled branch by its own words beside a different named topic", () => {
    const base = { uid: "42", groupId: "100", threadId: null };
    recordConversationTurn({ ...base, messageId: "m1", userText: "机器人 JM 下载失败",
      assistantText: "检查下载日志。", now: 1000 }, { userStore: users, save: false });
    recordConversationTurn({ ...base, messageId: "m2", userText: "猫咪在键盘上睡觉",
      assistantText: "看起来很安静。", now: 2000 }, { userStore: users, save: false });
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500,
      forMessage: { uid: "42", userMsg: "猫咪图片在哪" } }).turns[0].messageId, "m2");
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500,
      forMessage: { uid: "42", userMsg: "图片识别接口坏了" } }), null);
  });

  it("demotes an older topic to four turns without extending its lifetime", () => {
    const base = { uid: "42", groupId: "100", memorySources: [], memoryExpiresAt: null };
    recordConversationTurn({ ...base, threadId: null, messageId: "m0",
      userText: "JM 下载失败", assistantText: "检查文件0", now: 1000 }, { userStore: users, save: false });
    const id = getConversationThread("42", "100", { userStore: users, now: 1100 }).id;
    for (let index = 1; index <= 6; index++) recordConversationTurn({ ...base, threadId: id,
      messageId: "m" + index, userText: "JM 下载继续", assistantText: "检查文件" + index,
      now: 1000 + index * 1000 }, { userStore: users, save: false });
    recordConversationTurn({ ...base, threadId: null, messageId: "m7", userText: "日报没生成",
      assistantText: "检查计划", now: 8000 }, { userStore: users, save: false });
    const old = users["42"].cognition.threads["100"].branches[0];
    assert.deepEqual(old.turns.map(turn => turn.messageId), ["m3", "m4", "m5", "m6"]);
    assert.equal(old.updatedAt, 7000);
    assert.equal(getConversationThread("42", "100", { userStore: users, now: 7000 + 91 * 60 * 1000,
      forMessage: { uid: "42", userMsg: "JM 下载失败" } })?.id === id, false);
  });

  it("rejects foreign, oversized and malformed persisted branches without overwriting them", () => {
    const base = { uid: "42", groupId: "100", threadId: null };
    recordConversationTurn({ ...base, messageId: "m1", userText: "JM 下载失败",
      assistantText: "检查文件。", now: 1000 }, { userStore: users, save: false });
    recordConversationTurn({ ...base, messageId: "m2", userText: "日报没生成",
      assistantText: "检查计划。", now: 2000 }, { userStore: users, save: false });
    const stored = users["42"].cognition.threads["100"];
    let saves = 0;
    function assertRejected() {
      const before = JSON.stringify(users);
      assert.equal(getConversationThread("42", "100", { userStore: users, now: 2500 }), null);
      assert.equal(getCognitionStatus({ userStore: users, now: 2500 }).invalidThreads, 1);
      assert.throws(() => recordConversationTurn({ ...base, messageId: "m3", userText: "继续",
        assistantText: "不应写入", now: 2500 }, { userStore: users, saveUsers: () => { saves++; } }),
      /conversation_thread_invalid/);
      assert.equal(JSON.stringify(users), before);
      assert.equal(saves, 0);
    }
    stored.branches[0].scope = "private";
    stored.branches[0].turns[0].userSummary = "PRIVATE_SCOPE_MARKER";
    assertRejected();
    stored.branches[0].scope = "100";
    stored.branches.push({ ...stored.branches[0], id: "msg:other" }, { ...stored.branches[0], id: "msg:third" });
    assertRejected();
    stored.branches.length = 1;
    stored.branches[0].turns[0].assistantMessageIds = { bad: true };
    assertRejected();
    delete stored.branches[0].turns[0].assistantMessageIds;
    stored.scope = "private";
    assertRejected();
    stored.updatedAt = 0;
    stored.expiresAt = 1;
    assertRejected();
  });
});
