import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMinimalPreferenceContextBlock,
  buildPreferenceContextBlock,
  buildPrivacyText,
  buildSelfProfileText,
  buildStyleHelpText,
  buildStyleRecommendation,
  buildStylePreview,
  forgetUserData,
  getPreferredDisplayName,
  parseStylePreference,
  setUserDisplayName,
  setUserStylePreference,
} from "../bridge/user-preferences.mjs";

describe("user preferences", () => {
  it("parses structured reply style preferences", () => {
    const parsed = parseStylePreference("简短 技术 少吐槽 给步骤 不要表情");
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.patch, {
      length: "short",
      tone: "technical",
      humor: "light",
      examples: "steps",
      emoji: "none",
    });
  });

  it("rejects unsafe or romantic style preferences", () => {
    const parsed = parseStylePreference("恋爱 暧昧 主人");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "unsafe");
  });

  it("stores display name and style without raw chat text", () => {
    const users = {};
    assert.match(setUserDisplayName("42", "阿明", { users, skipSave: true }).text, /阿明/);
    assert.match(setUserStylePreference("42", "简短 技术 少吐槽", { users, skipSave: true }).text, /技术/);

    const block = buildPreferenceContextBlock("42", { users });
    assert.match(block, /用户主动设置/);
    assert.match(block, /阿明/);
    assert.match(block, /简短/);
    assert.doesNotMatch(block, /历史|原文/);

    const minimal = buildMinimalPreferenceContextBlock("42", { users });
    assert.match(minimal, /用户主动设置-简要/);
    assert.match(minimal, /阿明/);
    assert.match(minimal, /简短/);
    assert.doesNotMatch(minimal, /不要向其他人公开/);
    assert.equal(getPreferredDisplayName("42", "alice", { users }), "阿明");
    assert.equal(getPreferredDisplayName("7", "bob", { users }), "bob");
  });

  it("builds safe self profile and privacy text", () => {
    const text = buildSelfProfileText("42", "1", {
      users: {
        "42": {
          preferences: { displayName: "阿明", style: { tone: "technical", length: "short", updatedAt: 1 } },
        },
      },
      memoryContext: {
        userProfile: { commonTopics: ["机器人"], confidence: 0.6 },
        userGroupProfile: { recentTopics: ["运维"], interactionStyle: "technical", confidence: 0.4 },
      },
    });
    assert.match(text, /我的档案/);
    assert.match(text, /阿明/);
    assert.match(text, /机器人/);
    assert.match(text, /不展示聊天原文/);

    assert.match(buildPrivacyText(), /不展示聊天原文/);
    assert.match(buildStyleHelpText(), /回复风格帮助/);
    assert.match(buildStylePreview("42", { users: {} }), /当前风格预览/);
    assert.match(buildStyleRecommendation("42", "1", {
      memoryContext: { userProfile: { commonTopics: ["机器人"], preferredTone: "technical" } },
    }), /简短 技术/);
  });

  it("forgets user memory and replaces group log text with a placeholder", () => {
    const users = {
      "42": {
        chats: [{ text: "secret old text" }],
        description: "old",
        preferences: { displayName: "阿明" },
        relationshipComments: { "1": { comment: "old" } },
      },
    };
    const groupChats = {
      "1": [
        { uid: "42", text: "secret old text", imageUrls: ["https://example.com/a.jpg"] },
        { uid: "7", text: "keep" },
      ],
    };
    const result = forgetUserData("42", { users, groupChats, skipSave: true });
    assert.equal(result.ok, true);
    assert.deepEqual(users["42"].chats, []);
    assert.deepEqual(users["42"].preferences, {});
    assert.equal(groupChats["1"][0].text, "[已按用户请求清除]");
    assert.equal(groupChats["1"][0].imageUrls, undefined);
    assert.equal(groupChats["1"][1].text, "keep");
  });
});
