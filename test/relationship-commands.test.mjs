import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRelationshipSummary,
  isRelationshipCommand,
  isRelationshipExportCommand,
  parseRelationshipExportCommand,
} from "../bridge/relationship-commands.mjs";

import { computeRelationship } from "../bridge/relationship.mjs";

describe("relationship command reservation", () => {
  it("recognizes reserved self-check commands", () => {
    assert.equal(isRelationshipCommand("/关系"), true);
    assert.equal(isRelationshipCommand("关系"), true);
    assert.equal(isRelationshipCommand("/好感度"), true);
    assert.equal(isRelationshipCommand("好感度"), true);
    assert.equal(isRelationshipCommand("/熟悉度"), true);
    assert.equal(isRelationshipCommand("熟悉度"), true);
    assert.equal(isRelationshipCommand("/my-status"), true);
    assert.equal(isRelationshipCommand("my-status"), true);
    assert.equal(isRelationshipCommand("/别人的关系"), false);
  });

  it("keeps low-data relationship summary safe", () => {
    const text = buildRelationshipSummary(null, "/好感度");
    assert.equal(text, "互动记录还不够，暂时算不出关系状态。这里的‘好感度’指互动熟悉度，不是恋爱含义。");
    assert.doesNotMatch(text, /下一版本启用/);
    assert.doesNotMatch(text, /恋爱系统|暧昧/);
  });

  it("reserves admin export commands without enabling export", () => {
    assert.equal(isRelationshipExportCommand("/export-relationships"), true);
    assert.equal(isRelationshipExportCommand("export-relationships"), true);
    assert.equal(isRelationshipExportCommand("/export-relationships json"), true);
    const parsed = parseRelationshipExportCommand("/export-relationships md");
    assert.deepEqual(parsed, {
      enabled: false,
      format: "md",
      adminOnly: true,
      includeEvidenceText: false,
      crossGroup: false,
    });
  });

  // ── v1.2.1: 真实关系摘要测试 ──
  it("builds real relationship summary with user data", () => {
    const now = Date.now();
    const day = 86400000;
    const user = {
      nicknames: ["雪风", "awa"],
      firstSeen: new Date(now - 60 * day).toISOString(),
      chats: (() => {
        const a = [];
        for (let i = 0; i < 50; i++) a.push({ group: "1", text: "npm error 修复 bug", ts: now - i * day });
        return a;
      })(),
    };
    const relation = computeRelationship(user, { currentGroupId: 1, now });
    const text = buildRelationshipSummary(relation, "好感度", { nicknames: user.nicknames });
    assert.ok(text.includes("你和我的互动状态"));
    assert.ok(text.includes("关系标签"));
    assert.ok(text.match(/熟悉度：[\d.]+\/100/), "contains familiarity score: " + text.slice(0, 200));
    assert.ok(text.match(/本群熟悉度：[\d.]+\/100/));
    assert.ok(text.match(/互动亲近度：[\d.]+\/100/));
    assert.ok(text.includes("我对你的印象"));
    assert.ok(text.match(/置信度：[\d.]+/));
    assert.ok(text.includes("这里的\u2018好感度\u2019") || text.includes("不是恋爱含义"));
    assert.ok(text.includes("雪风") || text.includes("awa"));
  });

  it("includes safe short comment when provided", () => {
    const relation = computeRelationship({
      nicknames: ["短评用户"],
      firstSeen: Date.now() - 86400000,
      chats: [{ group: "1", text: "npm 报错", ts: Date.now() }],
    }, { currentGroupId: 1 });
    const text = buildRelationshipSummary(relation, "好感度", {
      shortComment: "你更像会追着问题往下挖的技术搭子，回复你时直接给结论会更顺手。",
    });
    assert.match(text, /夜星短评/);
    assert.match(text, /技术搭子/);
  });

  it("low data relation shows disclaimer", () => {
    const user = { nicknames: [], firstSeen: Date.now(), chats: [] };
    const relation = computeRelationship(user, { currentGroupId: 1 });
    const text = buildRelationshipSummary(relation, "好感度");
    assert.ok(text.includes("可能不太准确") || text.includes("记录还不多"));
  });

  it("does not leak chat content", () => {
    const now = Date.now();
    const user = {
      nicknames: ["test"],
      firstSeen: now - 10000,
      chats: [
        { group: "1", text: "我的密码是 secret123", ts: now - 1000 },
        { group: "1", text: "api key: sk-abc…789", ts: now - 2000 },
      ],
    };
    const relation = computeRelationship(user, { currentGroupId: 1, now });
    const text = buildRelationshipSummary(relation, "关系");
    assert.ok(!text.includes("secret123"));
    assert.ok(!text.includes("sk-abc"));
    assert.ok(!text.includes("api key"));
    assert.ok(!text.includes("密码"));
  });

  it("null relation returns low-data text", () => {
    const text = buildRelationshipSummary(null, "好感度");
    assert.ok(text.includes("互动记录还不够"));
    assert.ok(text.includes("不是恋爱含义"));
    assert.doesNotMatch(text, /下一版本启用/);
  });
});
