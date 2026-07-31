import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  buildLayeredReplyContext,
  buildMemoryContextBlock,
  interjectionToleranceFactor,
  retrieveRelevantUserMemories,
} from "../bridge/context-retriever.mjs";
import { observeMemoryEvent, memoryProfiles } from "../bridge/memory-profile.mjs";
import { users, groupChats } from "../bridge/storage.mjs";

function resetState() {
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  memoryProfiles.userProfiles = {};
  memoryProfiles.groupProfiles = {};
  memoryProfiles.userGroupProfiles = {};
}

describe("context retriever", () => {
  beforeEach(resetState);

  it("retrieves user history related to current query", () => {
    users["42"] = {
      uid: "42",
      alias: "alice",
      nicknames: ["alice"],
      chats: [
        { group: "1", nickname: "alice", text: "ordinary lunch talk", ts: 1000 },
        { group: "1", nickname: "alice", text: "jm download failed with archive", ts: 2000 },
        { group: "2", nickname: "alice", text: "model fallback discussion", ts: 3000 },
      ],
    };

    const memories = retrieveRelevantUserMemories("42", "jm cannot download", { groupId: "1", limit: 2 });
    assert.equal(memories.length, 1);
    assert.match(memories[0].text, /jm download/);
    assert.equal(memories[0].uid, "42");
  });

  it("builds active layered context with profile, relevant memory and group background", () => {
    users["42"] = {
      uid: "42",
      alias: "alice",
      nicknames: ["alice"],
      preferences: {
        displayName: "Alice",
        style: { length: "short", tone: "technical", humor: "light", updatedAt: Date.now() },
      },
      chats: [
        { group: "1", nickname: "alice", text: "jm download failed with archive", ts: Date.now() - 1000 },
      ],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "bob", text: "background from another speaker", role: "member", ts: Date.now() - 500 },
    ];
    observeMemoryEvent({ uid: "42", groupId: "1", nickname: "alice", text: "jm download failed again" });
    observeMemoryEvent({ uid: "42", groupId: "1", nickname: "alice", text: "jm download still broken" });

    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "alice",
      userMsg: "jm cannot download",
      replyText: "previous message",
    });
    const joined = ctx.history.map(item => item.content).join("\n");
    assert.match(joined, /用户主动设置/);
    assert.match(joined, /Alice/);
    assert.match(joined, /简短/);
    assert.match(joined, /jm download failed/);
    assert.match(joined, /background from another speaker/);
    assert.match(joined, /uid=99/);
    assert.match(buildMemoryContextBlock("42", "1"), /confidence=/);
    assert.match(ctx.currentInput, /uid=42/);
    assert.match(ctx.currentInput, /speaker=Alice/);
  });

  it("keeps passive interjection context lightweight and same-group only", () => {
    users["42"] = {
      uid: "42",
      chats: [{ group: "1", nickname: "alice", text: "long private history", ts: Date.now() }],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "bob", text: "group background", role: "member", ts: Date.now() },
    ];

    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "alice",
      userMsg: "QQFriend are you there?",
      isPassiveInterjection: true,
    });
    assert.equal(ctx.history.length, 1);
    assert.match(ctx.history[0].content, /最近对话/);
    assert.match(ctx.history[0].content, /group background/);
    assert.doesNotMatch(ctx.history[0].content, /long private history/);
    assert.match(ctx.currentInput, /uid=42/);
  });

  it("adds only minimal user preferences to passive interjection context", () => {
    users["42"] = {
      uid: "42",
      preferences: {
        displayName: "阿明",
        style: { length: "short", tone: "technical", humor: "light", updatedAt: Date.now() },
      },
      chats: [{ group: "1", nickname: "alice", text: "long private history", ts: Date.now() }],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "bob", text: "group background", role: "member", ts: Date.now() },
    ];

    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "alice",
      userMsg: "QQFriend are you there?",
      isPassiveInterjection: true,
    });
    const joined = ctx.history.map(item => item.content).join("\n");
    assert.equal(ctx.history.length, 2);
    assert.match(joined, /用户主动设置-简要/);
    assert.match(joined, /阿明/);
    assert.match(joined, /简短/);
    assert.doesNotMatch(joined, /long private history/);
    assert.match(joined, /group background/);
    assert.match(ctx.currentInput, /speaker=阿明/);
  });

  it("deduplicates recent interjection context and excludes commands, bot replies and current input", () => {
    const now = Date.now();
    groupChats["1"] = [
      { uid: "10", nickname: "A", text: "前面在讨论毕业去向", role: "member", ts: now - 5000, messageId: "a" },
      { uid: "11", nickname: "B", text: "前面在讨论毕业去向！", role: "member", ts: now - 4000, messageId: "b" },
      { uid: "12", nickname: "C", text: "help", role: "member", ts: now - 3000, messageId: "command" },
      { uid: "1000000006", nickname: "夜星", text: "机器人旧回复", role: "assistant", ts: now - 2000, messageId: "bot" },
      { uid: "42", nickname: "Alice", text: "我可能不去基层", role: "member", ts: now, messageId: "current" },
    ];

    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "我可能不去基层",
      currentMessageId: "current",
      isPassiveInterjection: true,
      now,
    });
    const joined = ctx.history.map(item => item.content).join("\n");
    assert.equal((joined.match(/前面在讨论毕业去向/g) || []).length, 1);
    assert.doesNotMatch(joined, /help|机器人旧回复|我可能不去基层/);
  });

  it("keeps more recent lines for image interjections", () => {
    const now = Date.now();
    groupChats["1"] = Array.from({ length: 8 }, (_, index) => ({
      uid: String(index + 10),
      nickname: "N" + index,
      text: "context line " + index,
      role: "member",
      ts: now - (8 - index) * 100,
      messageId: "m" + index,
    }));
    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "Alice",
      userMsg: "[图片]",
      currentMessageId: "current",
      isPassiveInterjection: true,
      hasImages: true,
      now,
    });
    const joined = ctx.history.map(item => item.content).join("\n");
    assert.equal((joined.match(/context line/g) || []).length, 6);
  });

  it("maps group interjection tolerance into bounded factors", () => {
    assert.equal(interjectionToleranceFactor({ interjectionTolerance: "low" }), 0.5);
    assert.equal(interjectionToleranceFactor({ interjectionTolerance: "high" }), 1.3);
    assert.equal(interjectionToleranceFactor({ interjectionTolerance: "normal" }), 1);
  });

  it("excludes the current message from memory and group background", () => {
    const now = Date.now();
    users["42"] = {
      uid: "42",
      chats: [
        { group: "1", nickname: "alice", text: "jm previous failure", ts: now - 5000, messageId: "old" },
        { group: "1", nickname: "alice", text: "jm current unique marker", ts: now, messageId: "current" },
      ],
    };
    groupChats["1"] = [
      { uid: "99", nickname: "bob", text: "older group context", role: "member", ts: now - 5000, messageId: "group-old" },
      { uid: "42", nickname: "alice", text: "jm current unique marker", role: "member", ts: now, messageId: "current" },
    ];

    const ctx = buildLayeredReplyContext({
      uid: "42",
      groupId: "1",
      userName: "alice",
      userMsg: "jm current unique marker",
      currentMessageId: "current",
    });
    const joined = ctx.history.map(item => item.content).join("\n");
    assert.doesNotMatch(joined, /jm current unique marker/);
    assert.match(joined, /older group context/);
  });
});
