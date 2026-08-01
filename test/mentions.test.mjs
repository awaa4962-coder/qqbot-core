import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { buildReplyContextPacket } from "../bridge/context/index.mjs";
import { hydrateMentions, parseMentions } from "../bridge/mentions/index.mjs";
import { memoryProfiles } from "../bridge/memory-profile.mjs";
import { parseIncomingEvent } from "../bridge/reply-handlers.mjs";
import { groupChats, logGroupMsg, users } from "../bridge/storage.mjs";

function resetState() {
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  memoryProfiles.userProfiles = {};
  memoryProfiles.groupProfiles = {};
  memoryProfiles.userGroupProfiles = {};
}

describe("mentions", () => {
  beforeEach(resetState);

  it("parses bot and user mentions from message segments", () => {
    const mentions = parseMentions([
      { type: "at", data: { qq: "1000000001" } },
      { type: "text", data: { text: " check " } },
      { type: "at", data: { qq: "1000000002" } },
    ], "", { selfUin: "1000000001" });

    assert.deepEqual(mentions.map(item => item.qq), ["1000000001", "1000000002"]);
    assert.equal(mentions[0].isBot, true);
    assert.equal(mentions[1].isBot, false);
  });

  it("parses raw CQ mentions and does not treat plain QQ text as a mention", () => {
    const mentions = parseMentions(
      [{ type: "text", data: { text: "1000000001 is only text" } }],
      "1000000001 [CQ:at,qq=1000000002]",
      { selfUin: "1000000001" },
    );

    assert.deepEqual(mentions.map(item => item.qq), ["1000000002"]);
    assert.equal(mentions[0].isBot, false);
  });

  it("exposes mentioned users on incoming group events", () => {
    const ctx = parseIncomingEvent({
      post_type: "message",
      message_type: "group",
      user_id: 123,
      group_id: 456,
      message_id: 789,
      sender: { card: "sender", nickname: "fallback" },
      message: [
        { type: "at", data: { qq: "1000000001" } },
        { type: "at", data: { qq: "1000000002" } },
        { type: "text", data: { text: " look at this" } },
      ],
      raw_message: "[CQ:at,qq=1000000001][CQ:at,qq=1000000002] look at this",
    });

    assert.equal(ctx.isAtMe, true);
    assert.equal(ctx.text, "look at this");
    assert.deepEqual(ctx.mentionedUsers.map(item => item.qq), ["1000000002"]);
  });

  it("keeps group messages that only mention another user from triggering bot mention", () => {
    const ctx = parseIncomingEvent({
      post_type: "message",
      message_type: "group",
      user_id: 123,
      group_id: 456,
      message_id: 789,
      sender: {},
      message: [
        { type: "at", data: { qq: "1000000002" } },
        { type: "text", data: { text: " hello" } },
      ],
      raw_message: "[CQ:at,qq=1000000002] hello",
    });

    assert.equal(ctx.isAtMe, false);
    assert.deepEqual(ctx.mentionedUsers.map(item => item.qq), ["1000000002"]);
  });

  it("adds mentioned user summaries to active reply context without raw chat text", () => {
    users["1000000002"] = {
      uid: "1000000002",
      alias: "target",
      nicknames: ["old-name", "target"],
      preferences: { displayName: "TargetName" },
      chats: [{ group: "456", nickname: "target", text: "private raw detail should not leak", ts: Date.now() }],
    };
    memoryProfiles.userProfiles["1000000002"] = {
      uid: "1000000002",
      commonTopics: ["ops"],
      dislikes: [],
      preferredTone: "technical",
      replyStyle: "concise",
      confidence: 0.5,
      expiresAt: Date.now() + 60000,
    };

    const packet = buildReplyContextPacket({
      uid: "123",
      groupId: "456",
      userName: "sender",
      userMsg: "@target help",
      mode: "group-at",
      mentions: [{ qq: "1000000002", isBot: false, isAll: false }],
    });
    const merged = packet.messages.map(item => item.content).join("\n");

    assert.match(merged, /\[Mention context\]/);
    assert.match(merged, /uid=1000000002/);
    assert.match(merged, /TargetName/);
    assert.doesNotMatch(merged, /private raw detail should not leak/);
    assert.deepEqual(packet.metadata.mentionedUsers, ["1000000002"]);
  });

  it("hydrates mentioned users with group member card before context assembly", async () => {
    const mentions = [{ qq: "1000000002", isBot: false, isAll: false }];
    await hydrateMentions(mentions, {
      groupId: "456",
      getGroupMemberInfo: async () => ({ card: "群名片目标", nickname: "nick" }),
    });

    const packet = buildReplyContextPacket({
      uid: "123",
      groupId: "456",
      userName: "sender",
      userMsg: "@target help",
      mode: "group-at",
      mentions,
    });
    const merged = packet.messages.map(item => item.content).join("\n");

    assert.match(merged, /群名片目标/);
  });

  it("stores lightweight mention metadata with group and user chat entries", () => {
    logGroupMsg("456", "sender", "hello target", "123", "member", null, {
      mentions: [{ qq: "1000000002", isBot: false, isAll: false }],
    });

    assert.deepEqual(groupChats["456"][0].mentions, [{ qq: "1000000002", isBot: false, isAll: false }]);
    assert.deepEqual(users["123"].chats[0].mentions, [{ qq: "1000000002", isBot: false, isAll: false }]);
    assert.equal(users["1000000002"], undefined);
  });
});
