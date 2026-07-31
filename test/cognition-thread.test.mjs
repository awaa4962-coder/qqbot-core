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
});
