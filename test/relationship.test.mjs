// test/relationship.test.mjs — 关系计算纯函数测试
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRelationship,
  getRelationshipLevel,
  normalizeRelationship,
  createDefaultRelationship,
} from "../bridge/relationship.mjs";

describe("computeRelationship", () => {
  const now = Date.now();
  const day = 86400000;

  it("空用户返回低分且不崩溃", () => {
    const r = computeRelationship(null, { now });
    assert.ok(r.familiarity >= 0 && r.familiarity <= 5);
    assert.ok(r.affinity >= 0);
    assert.ok(r.confidence <= 0.05);
    assert.strictEqual(r.preferredTone, "normal");
  });

  it("undefined user 返回默认值", () => {
    const r = computeRelationship(undefined, { now });
    assert.strictEqual(r.messageCount, 0);
    assert.strictEqual(r.activeDays, 0);
  });

  it("旧 users 数据兼容（无 relationship 字段）", () => {
    const oldUser = {
      uid: "123",
      nicknames: ["测试"],
      firstSeen: new Date(now - 30 * day).toISOString(),
      chats: [
        { group: "1", text: "你好", ts: now - day },
        { group: "1", text: "今天天气不错", ts: now - 2 * day },
        { group: "1", text: "npm install 报错了", ts: now - 3 * day },
      ],
    };
    const r = computeRelationship(oldUser, { currentGroupId: 1, now });
    assert.ok(r.familiarity > 0);
    assert.ok(r.messageCount === 3);
    assert.ok(r.activeDays >= 1);
  });

  it("messageCount 越高 familiarity 越高", () => {
    const makeUser = (n) => {
      const chats = [];
      for (let i = 0; i < n; i++) chats.push({ group: "1", text: "msg" + i, ts: now - i * day });
      return { nicknames: ["a"], firstSeen: now - 50 * day, chats };
    };
    const r10 = computeRelationship(makeUser(10), { now });
    const r50 = computeRelationship(makeUser(50), { now });
    assert.ok(r50.familiarity > r10.familiarity, "50 msg > 10 msg familiarity");
  });

  it("activeDays 越多 familiarity 越高", () => {
    const sparse = [];
    for (let i = 0; i < 10; i++) sparse.push({ group: "1", text: "x", ts: now - i * 7 * day });
    const dense = [];
    for (let i = 0; i < 50; i++) dense.push({ group: "1", text: "x", ts: now - i * day });
    const rS = computeRelationship({ nicknames: ["a"], firstSeen: now - 80 * day, chats: sparse }, { now });
    const rD = computeRelationship({ nicknames: ["a"], firstSeen: now - 80 * day, chats: dense }, { now });
    // dense has 50 unique days, sparse has 10 → dense familiarity higher
    assert.ok(rD.activeDays > rS.activeDays, "50 days > 10 days active: " + rD.activeDays + " > " + rS.activeDays);
    assert.ok(rD.familiarity > rS.familiarity, "more active days = higher familiarity: " + rD.familiarity + " > " + rS.familiarity);
  });

  it("分数不超 [0, 100]", () => {
    const superUser = {
      nicknames: Array(30).fill("n"),
      firstSeen: new Date(now - 500 * day).toISOString(),
      chats: (() => { const a = []; for (let i = 0; i < 300; i++) a.push({ group: "1", text: "t" + i, ts: now - i * day }); return a; })(),
    };
    const r = computeRelationship(superUser, { now });
    assert.ok(r.familiarity <= 100, "familiarity " + r.familiarity + " <= 100");
    assert.ok(r.affinity <= 100, "affinity " + r.affinity + " <= 100");
    assert.ok(r.trustScore <= 100, "trustScore " + r.trustScore + " <= 100");
    assert.ok(r.humorTolerance <= 100);
    assert.ok(r.interactionScore <= 100);
    assert.ok(r.styleMatch <= 100);
  });

  it("confidence 不超 1", () => {
    const r = computeRelationship({ nicknames: [], chats: Array(500).fill({ group: "1", text: "x", ts: now }) }, { now });
    assert.ok(r.confidence <= 1, "confidence " + r.confidence + " <= 1");
    assert.ok(r.confidence >= 0, "confidence >= 0");
  });

  it("技术词检测 → preferredTone technical", () => {
    const user = {
      nicknames: ["dev"],
      firstSeen: now - 10 * day,
      chats: [
        { group: "1", text: "我的 npm install 报错了 error", ts: now },
        { group: "1", text: "这个函数怎么 import 进来", ts: now - day },
        { group: "1", text: "改一下 config 文件", ts: now - 2 * day },
      ],
    };
    const r = computeRelationship(user, { now });
    assert.strictEqual(r.preferredTone, "technical");
  });

  it("玩笑词检测 → preferredTone playful", () => {
    const user = {
      nicknames: ["乐子人"],
      firstSeen: now - 10 * day,
      chats: [
        { group: "1", text: "哈哈哈哈哈笑死我了", ts: now },
        { group: "1", text: "太草了 绷不住了", ts: now - day },
        { group: "1", text: "6", ts: now - 2 * day },
      ],
    };
    const r = computeRelationship(user, { now });
    assert.strictEqual(r.preferredTone, "playful");
  });

  it("短句多 → preferredTone concise", () => {
    const user = {
      nicknames: ["简"],
      firstSeen: now - 10 * day,
      chats: [
        { group: "1", text: "哦", ts: now },
        { group: "1", text: "嗯", ts: now - day },
        { group: "1", text: "好", ts: now - 2 * day },
        { group: "1", text: "行", ts: now - 3 * day },
      ],
    };
    const r = computeRelationship(user, { now });
    assert.strictEqual(r.preferredTone, "concise");
  });

  it("humorTolerance 默认不超过 50", () => {
    const user = {
      nicknames: ["笑匠"],
      firstSeen: now - 5 * day,
      chats: Array(50).fill({ group: "1", text: "哈哈笑死草乐绷6", ts: now }),
    };
    const r = computeRelationship(user, { now });
    assert.ok(r.humorTolerance <= 50);
  });

  it("最近7天有活动 → familiarity 更高", () => {
    const activeUser = { nicknames: ["a"], firstSeen: now - 20 * day, chats: [{ group: "1", text: "hi", ts: now - 3 * day }] };
    const inactiveUser = { nicknames: ["a"], firstSeen: now - 20 * day, chats: [{ group: "1", text: "hi", ts: now - 10 * day }] };
    const rA = computeRelationship(activeUser, { now });
    const rI = computeRelationship(inactiveUser, { now });
    assert.ok(rA.familiarity > rI.familiarity, "recent activity boosts familiarity: " + rA.familiarity + " vs " + rI.familiarity);
  });

  it("uses memory context and current group data for personalized relationship card fields", () => {
    const user = {
      nicknames: ["工程师"],
      firstSeen: now - 20 * day,
      chats: [
        { group: "1", text: "npm 报错，帮我看日志", ts: now - day },
        { group: "1", text: "上下文系统怎么改", ts: now - 2 * day },
        { group: "2", text: "哈哈这个 bot 有点抽象", ts: now - 3 * day },
      ],
    };
    const relation = computeRelationship(user, {
      currentGroupId: 1,
      now,
      memoryContext: {
        userProfile: { preferredTone: "technical", replyStyle: "concise", commonTopics: ["机器人", "运维"], confidence: 0.6 },
        groupProfile: { tone: "technical", activeTopics: ["上下文"], interjectionTolerance: "normal" },
        userGroupProfile: { interactionStyle: "technical", recentTopics: ["日志"], confidence: 0.5 },
      },
    });
    assert.equal(relation.groupMessageCount, 2);
    assert.ok(relation.groupFamiliarity > 0);
    assert.ok(relation.topics.includes("机器人"));
    assert.ok(relation.topics.includes("日志"));
    assert.equal(relation.replyStyle, "concise");
    assert.equal(relation.groupInteractionStyle, "technical");
    assert.ok(relation.relationshipTags.includes("技术搭子"));
    assert.match(relation.impression, /技术搭子|常聊/);
  });
});

describe("getRelationshipLevel", () => {
  it("0-19 → 刚认识", () => {
    assert.strictEqual(getRelationshipLevel(0).cn, "刚认识");
    assert.strictEqual(getRelationshipLevel(19).cn, "刚认识");
  });
  it("20-39 → 有点眼熟", () => {
    assert.strictEqual(getRelationshipLevel(20).cn, "有点眼熟");
    assert.strictEqual(getRelationshipLevel(39).cn, "有点眼熟");
  });
  it("40-59 → 常见群友", () => {
    assert.strictEqual(getRelationshipLevel(40).cn, "常见群友");
  });
  it("60-79 → 熟人", () => {
    assert.strictEqual(getRelationshipLevel(60).cn, "熟人");
  });
  it("80-100 → 老熟人", () => {
    assert.strictEqual(getRelationshipLevel(80).cn, "老熟人");
    assert.strictEqual(getRelationshipLevel(100).cn, "老熟人");
  });
  it("超出范围 / 非法值 → 刚认识", () => {
    assert.strictEqual(getRelationshipLevel(-1).cn, "刚认识");
    assert.strictEqual(getRelationshipLevel(NaN).cn, "刚认识");
    assert.strictEqual(getRelationshipLevel(null).cn, "刚认识");
  });
});

describe("normalizeRelationship", () => {
  it("空输入返回默认值", () => {
    const r = normalizeRelationship({});
    assert.strictEqual(r.familiarity, 0);
    assert.strictEqual(r.preferredTone, "normal");
  });
  it("clamp 分数", () => {
    const r = normalizeRelationship({ familiarity: 150, affinity: -10, confidence: 2 });
    assert.strictEqual(r.familiarity, 100);
    assert.strictEqual(r.affinity, 0);
    assert.strictEqual(r.confidence, 1);
  });
});

describe("createDefaultRelationship", () => {
  it("所有字段为 0", () => {
    const r = createDefaultRelationship();
    assert.strictEqual(r.familiarity, 0);
    assert.strictEqual(r.affinity, 0);
    assert.strictEqual(r.preferredTone, "normal");
  });
});
