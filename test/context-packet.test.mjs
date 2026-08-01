import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { buildReplyContextPacket } from "../bridge/context/index.mjs";
import { groupChats, users } from "../bridge/storage.mjs";
import { recordConversationTurn, resetCognitionForTest } from "../bridge/cognition/index.mjs";

function resetState() {
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  resetCognitionForTest();
}

describe("reply context packet", () => {
  beforeEach(resetState);

  it("wraps active group context into a stable packet", () => {
    users["42"] = {
      uid: "42",
      nicknames: ["Alice"],
      chats: [{ group: "1", nickname: "Alice", text: "jm download failed", ts: Date.now() }],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "Bob", text: "group background", role: "member", ts: Date.now() },
    ];

    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "jm still cannot download",
      replyText: "quoted line",
      mode: "group-at",
    });

    assert.equal(packet.mode, "group-at");
    assert.equal(packet.history, packet.messages);
    assert.equal(packet.metadata.uid, "42");
    assert.equal(packet.metadata.groupId, "1");
    assert.equal(packet.metadata.hasQuotedMessage, true);
    assert.ok(packet.budget.messageCount >= 1);
    assert.ok(packet.budget.chars >= packet.budget.currentInputChars);
    assert.match(packet.currentInput, /uid=42/);
  });

  it("keeps interjection packets lightweight", () => {
    users["42"] = {
      uid: "42",
      chats: [{ group: "1", nickname: "Alice", text: "long history", ts: Date.now() }],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "Bob", text: "group background", role: "member", ts: Date.now() },
    ];

    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "hello",
      mode: "interjection",
    });

    assert.equal(packet.mode, "interjection");
    assert.equal(packet.messages.length, 1);
    assert.match(packet.messages[0].content, /group background/);
    assert.equal(packet.metadata.hasQuotedMessage, false);
    assert.equal(packet.metadata.hasImages, false);
    assert.match(packet.currentInput, /reply_target=当前发言人/);
  });

  it("expands the bounded packet for image interjections and keeps quoted text", () => {
    const now = Date.now();
    groupChats["1"] = Array.from({ length: 6 }, (_, index) => ({
      uid: String(index + 10),
      nickname: "N" + index,
      text: "image context " + index,
      role: "member",
      ts: now - index,
      messageId: "m" + index,
    }));
    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "[图片]",
      replyText: "这张图接着刚才的话题",
      currentMessageId: "current",
      mode: "interjection",
      hasImages: true,
      imageCount: 1,
    });
    const joined = packet.messages.map(item => item.content).join("\n");
    assert.equal(packet.metadata.hasImages, true);
    assert.equal(packet.metadata.imageCount, 1);
    assert.equal(packet.budget.maxChars, 1800);
    assert.match(joined, /被回复消息/);
    assert.match(joined, /image context/);
  });

  it("injects same-group completed turns and exposes only thread metadata", () => {
    users["42"] = { uid: "42", nicknames: ["Alice"], chats: [] };
    recordConversationTurn({
      uid: "42",
      groupId: "1",
      messageId: "previous",
      userText: "JM 下载失败",
      assistantText: "已经检查到依赖缺失",
      now: Date.now() - 1000,
    }, { save: false });

    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "还是不行",
      currentMessageId: "current",
      mode: "group-at",
    });
    const joined = packet.messages.map(item => item.content).join("\n");
    assert.match(joined, /短期会话线程/);
    assert.match(joined, /已经检查到依赖缺失/);
    assert.equal(packet.thread.topic, "JM 下载");
    assert.equal(packet.thread.turnCount, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.thread, "turns"), false);
  });

  it("does not repeat completed thread turns in history or group background", () => {
    const now = Date.now();
    users["42"] = {
      uid: "42",
      nicknames: ["Alice"],
      chats: [
        {
          group: "1",
          nickname: "Alice",
          text: "JM CTX_DEDUPE_USER_MARKER",
          messageId: "previous",
          ts: now - 1000,
        },
        {
          group: "1",
          nickname: "Alice",
          text: "OLDER_RELEVANT_CONTEXT",
          messageId: "older",
          ts: now - 2000,
        },
      ],
    };
    groupChats["1"] = [
      {
        uid: "99",
        nickname: "Bob",
        text: "OLDER_GROUP_BACKGROUND",
        role: "member",
        messageId: "background",
        ts: now - 3000,
      },
      {
        uid: "42",
        nickname: "Alice",
        text: "JM CTX_DEDUPE_USER_MARKER",
        role: "member",
        messageId: "previous",
        ts: now - 1000,
      },
      {
        uid: "bot",
        nickname: "NightStar",
        text: "CTX_DEDUPE_ASSISTANT_MARKER",
        role: "assistant",
        turnId: "previous",
        ts: now - 900,
      },
    ];
    recordConversationTurn({
      uid: "42",
      groupId: "1",
      messageId: "previous",
      userText: "JM CTX_DEDUPE_USER_MARKER",
      assistantText: "CTX_DEDUPE_ASSISTANT_MARKER",
      now: now - 900,
    }, { save: false });

    const packet = buildReplyContextPacket({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "continue with the previous result",
      currentMessageId: "current",
      mode: "group-at",
    });
    const joined = packet.messages.map(item => item.content).join("\n");

    assert.equal(joined.split("CTX_DEDUPE_USER_MARKER").length - 1, 1);
    assert.equal(joined.split("CTX_DEDUPE_ASSISTANT_MARKER").length - 1, 1);
    assert.match(joined, /OLDER_GROUP_BACKGROUND/);
  });
});
