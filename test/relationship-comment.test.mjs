import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRelationshipCommentPrompt,
  buildLocalRelationshipComment,
  getRelationshipShortComment,
  normalizeRelationshipComment,
  shouldRefreshComment,
} from "../bridge/relationship-comment.mjs";

const relation = {
  familiarity: 68,
  groupFamiliarity: 52,
  recentHeat: "较活跃",
  topics: ["上下文", "自动回复", "JM"],
  replyStyle: "偏技术向，可以给结论也给实现细节",
  groupInteractionStyle: "technical",
  relationshipTags: ["技术搭子", "熟人"],
  confidence: 0.64,
  messageCount: 80,
  groupMessageCount: 40,
};

describe("relationship short comment", () => {
  it("builds prompt without raw chat content and with safety rules", () => {
    const prompt = buildRelationshipCommentPrompt(relation);
    assert.match(prompt, /关系摘要/);
    assert.match(prompt, /禁止恋爱化/);
    assert.match(prompt, /上下文/);
    assert.doesNotMatch(prompt, /我的密码|api key|secret/i);
  });

  it("normalizes unsafe romantic or reasoning comments to empty", () => {
    assert.equal(normalizeRelationshipComment("我喜欢你，像恋爱一样"), "");
    assert.equal(normalizeRelationshipComment("分析：用户想看关系"), "");
    assert.equal(normalizeRelationshipComment("你更像技术搭子，适合直接给结论。"), "你更像技术搭子，适合直接给结论。");
  });

  it("uses MiMo comment and caches it", async () => {
    const user = { relationshipComments: {} };
    const text = await getRelationshipShortComment(relation, {
      user,
      groupId: 1,
      now: 1000,
      callMiMo: async () => "你更像会追着问题往下挖的技术搭子，回复你时直接给结论会更顺手。",
      callDeepSeek: async () => "不该调用",
    });
    assert.match(text, /技术搭子/);
    assert.equal(user.relationshipComments["1"].text, text);

    const cached = await getRelationshipShortComment(relation, {
      user,
      groupId: 1,
      now: 2000,
      callMiMo: async () => "新的短评",
    });
    assert.equal(cached, text);
  });

  it("falls back to DeepSeek when MiMo returns unsafe output", async () => {
    const user = {};
    const text = await getRelationshipShortComment(relation, {
      user,
      groupId: 1,
      now: 1000,
      callMiMo: async () => "我喜欢你，像恋爱一样",
      callDeepSeek: async () => "我对你的印象更像技术熟人，常围绕上下文和自动回复推进问题。",
    });
    assert.match(text, /技术熟人/);
  });

  it("falls back to local template if model comments are unavailable", async () => {
    const text = await getRelationshipShortComment(relation, {
      user: {},
      groupId: 1,
      callMiMo: async () => "",
      callDeepSeek: async () => "",
    });
    assert.equal(text, buildLocalRelationshipComment(relation));
  });

  it("refreshes after cache age or enough new messages", () => {
    const cache = { text: "old", generatedAt: 1000, messageCount: 10, groupMessageCount: 5 };
    assert.equal(shouldRefreshComment(cache, { messageCount: 20, groupMessageCount: 10 }, 2000), false);
    assert.equal(shouldRefreshComment(cache, { messageCount: 41, groupMessageCount: 10 }, 2000), true);
    assert.equal(shouldRefreshComment(cache, { messageCount: 20, groupMessageCount: 10 }, 7 * 60 * 60 * 1000), true);
  });
});
