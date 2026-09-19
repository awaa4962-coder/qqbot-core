import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import { beforeEach, test } from "node:test";
import { groupChats, logGroupMsg, users } from "../bridge/storage.mjs";
import { buildReplyContextPacket } from "../bridge/context/index.mjs";
import { memoryProfiles, observeMemoryEvent, getActiveMemoryContext } from "../bridge/memory-profile.mjs";
import { redactMemoryTextFields } from "../bridge/memory-profile/privacy.mjs";
import { buildMentionContextBlock, resolveMentionDisplayName } from "../bridge/mentions/index.mjs";
import { buildRelationshipCommandReply, buildRelationshipCommandReplyAsync } from "../bridge/commands/modules/relationship.mjs";
import { buildMinimalPreferenceContextBlock, buildPreferenceContextBlock, forgetUserData, setUserDisplayName, setUserStylePreference } from "../bridge/user-preferences.mjs";
import { generateProfile } from "../bridge/profile.mjs";
import { getRelationshipShortComment } from "../bridge/relationship-comment.mjs";
import { recordConversationTurn, resetCognitionForTest } from "../bridge/cognition/index.mjs";

beforeEach(() => {
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  memoryProfiles.userProfiles = {};
  memoryProfiles.groupProfiles = {};
  memoryProfiles.userGroupProfiles = {};
  resetCognitionForTest();
});

test("group ingress and prompt recall redact secrets without changing attribution", () => {
  const secret = "sk-SYNTHETIC_NOT_A_REAL_KEY";
  const text = 'archive {"api_key":"' + secret + '","password":"synthetic-password"}';
  logGroupMsg("10001", "member", text, "13800138000", "member", null, { messageId: "123456789012345678" });
  assert.equal(observeMemoryEvent({ uid: "13800138000", groupId: "10001", text }), null);
  assert.doesNotMatch(JSON.stringify(users), /sk-SYNTHETIC|synthetic-password/);
  assert.doesNotMatch(JSON.stringify(groupChats), /sk-SYNTHETIC|synthetic-password/);
  assert.equal(groupChats["10001"][0].uid, "13800138000");
  assert.equal(groupChats["10001"][0].messageId, "123456789012345678");
  const packet = buildReplyContextPacket({ uid: "20002", groupId: "10001", userMsg: "archive", currentMessageId: "new" });
  assert.doesNotMatch(JSON.stringify(packet.messages), /sk-SYNTHETIC|synthetic-password/);
  assert.match(JSON.stringify(packet.messages), /uid=13800138000/);
});

test("legacy nested memory text is sanitized while metadata and image URLs survive", () => {
  const data = {
    "13800138000": {
      uid: "13800138000", profile: "password=synthetic-old", alias: "token=synthetic-alias",
      nicknames: ["sk-synthetic_old_name"], chats: [{ text: 'api_key="synthetic-old"', messageId: "123456789012345678", imageUrls: ["https://example.test/image?token=attachment"] }],
      cognition: { threads: { g: { turns: [{ userSummary: "secret=synthetic-old", assistantSummary: "password=synthetic-old" }] } } },
      relationshipComments: { g: { text: "token=synthetic-old" } },
    },
  };
  assert.equal(redactMemoryTextFields(data), true);
  assert.doesNotMatch(JSON.stringify(data), /synthetic-old|synthetic-alias|sk-synthetic/);
  assert.equal(data["13800138000"].uid, "13800138000");
  assert.equal(data["13800138000"].chats[0].messageId, "123456789012345678");
  assert.equal(data["13800138000"].chats[0].imageUrls[0], "https://example.test/image?token=attachment");
  assert.equal(redactMemoryTextFields(data), false);
});

test("legacy JSON loads redact all stores and persist sanitized snapshots", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-privacy-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const profilesFile = path.join(directory, "profiles.json");
  fs.writeFileSync(path.join(directory, "user_memory.json"), JSON.stringify({ "20001": { uid: "20001", profile: "password=legacy-synthetic", chats: [{ group: "10001", text: "secret=legacy-synthetic" }] } }));
  fs.writeFileSync(path.join(directory, "group_chats.json"), JSON.stringify({ "10001": [{ uid: "20001", text: 'api_key="legacy-synthetic"', messageId: "123456789012345678" }] }));
  fs.writeFileSync(profilesFile, JSON.stringify({ userProfiles: { "20001": { dislikes: ["token=legacy-synthetic"], expiresAt: Date.now() + 60000 } } }));
  const source = `
    import assert from 'node:assert/strict';
    import { users, groupChats, flushSavesSync } from ${JSON.stringify(new URL("../bridge/storage.mjs", import.meta.url).href)};
    import { memoryProfiles, flushMemoryProfilesSync } from ${JSON.stringify(new URL("../bridge/memory-profile.mjs", import.meta.url).href)};
    assert.doesNotMatch(JSON.stringify({users,groupChats,memoryProfiles}), /legacy-synthetic/);
    assert.equal(groupChats['10001'][0].messageId, '123456789012345678');
    flushSavesSync(); flushMemoryProfilesSync();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true, encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", QQBOT_DATA_DIR: directory, QQBOT_CONFIG_ROOT: directory, QQBOT_LOG_DIR: path.join(directory, "logs"), QQBOT_MEMORY_PROFILE_FILE: profilesFile },
  });
  assert.equal(child.status, 0, child.stderr);
  for (const file of ["user_memory.json", "group_chats.json", "profiles.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(directory, file), "utf8"), /legacy-synthetic/);
  }
});

test("prompt boundary also redacts already-loaded legacy history and completed turns", () => {
  users["20001"] = { uid: "20001", chats: [{ group: "10001", text: "archive password=synthetic-old", ts: Date.now(), messageId: "old" }] };
  recordConversationTurn({ uid: "20001", groupId: "10001", messageId: "thread", userText: "archive token=synthetic-thread", assistantText: "check password=synthetic-answer" }, { save: false });
  const packet = buildReplyContextPacket({ uid: "20001", groupId: "10001", userMsg: "archive still failing", currentMessageId: "new", replyText: 'api_key="synthetic-quote"' });
  assert.doesNotMatch(JSON.stringify(packet.messages), /synthetic-old|synthetic-thread|synthetic-answer|synthetic-quote/);
  assert.doesNotMatch(JSON.stringify(users["20001"].cognition), /synthetic-thread|synthetic-answer/);
});

test("third-party mentions and relationship cards only expose current-group evidence", () => {
  logGroupMsg("GROUP_A", "ONLY_A_NAME", "archive old history", "20001", "member");
  logGroupMsg("GROUP_B", "PUBLIC_B_NAME", "current group discussion", "20001", "member");
  setUserDisplayName("20001", "PRIVATE_SETTING", { skipSave: true });
  memoryProfiles.userProfiles["20001"] = { confidence: 1, expiresAt: Date.now() + 60000, commonTopics: ["ONLY_A_TOPIC"], dislikes: ["ONLY_A_DISLIKE"] };
  memoryProfiles.userGroupProfiles["GROUP_B:20001"] = { confidence: 1, expiresAt: Date.now() + 60000, recentTopics: ["LOCAL_B_TOPIC"], interactionStyle: "technical" };
  const block = buildMentionContextBlock({ groupId: "GROUP_B", mentions: [{ qq: "20001", displayName: "PUBLIC_B_NAME" }] });
  assert.match(block, /PUBLIC_B_NAME|LOCAL_B_TOPIC/);
  assert.doesNotMatch(block, /ONLY_A_|PRIVATE_SETTING|preferredName|knownNames/);
  const reply = buildRelationshipCommandReply("关系", { users, groupId: "GROUP_B", userId: "20002", mentionedUsers: [{ qq: "20001" }] });
  assert.match(reply, /PUBLIC_B_NAME/);
  assert.match(reply, /LOCAL_B_TOPIC/);
  assert.doesNotMatch(reply, /ONLY_A_|PRIVATE_SETTING/);
  assert.equal(resolveMentionDisplayName("20001", { groupId: "GROUP_C" }), "QQ:20001");
  const self = buildReplyContextPacket({ uid: "20001", groupId: "GROUP_B", userMsg: "hello" });
  assert.match(self.currentInput, /PRIVATE_SETTING/);
  assert.match(JSON.stringify(self.messages), /PRIVATE_SETTING/);
  assert.doesNotMatch(JSON.stringify(self.messages), /ONLY_A_/);
});

test("forget removes all profile and nickname copies without removing message IDs", () => {
  logGroupMsg("10001", "OLD_NAME", "old text", "20001", "member", ["https://example.test/a"], { messageId: "old-id" });
  setUserDisplayName("20001", "OLD_SETTING", { skipSave: true });
  users["20001"].profile = "old model profile";
  forgetUserData("20001", { skipSave: true });
  assert.equal(users["20001"].profile, "");
  assert.equal(users["20001"].alias, "");
  assert.deepEqual(users["20001"].nicknames, []);
  assert.doesNotMatch(JSON.stringify(users), /OLD_NAME|OLD_SETTING|old model profile/);
  assert.doesNotMatch(JSON.stringify(groupChats), /OLD_NAME|old text/);
  assert.equal(groupChats["10001"][0].messageId, "old-id");
  assert.equal(groupChats["10001"][0].uid, "20001");
});

test("forget invalidates pending model profile results and prevents fallback", async () => {
  users["20001"] = { uid: "20001", chats: [{ group: "10001", text: "password=synthetic-old", ts: Date.now() }] };
  let finish;
  let calls = 0;
  const pending = generateProfile("20001", { generate: async prompt => {
    calls++;
    assert.doesNotMatch(prompt, /synthetic-old/);
    return await new Promise(resolve => { finish = resolve; });
  } });
  forgetUserData("20001", { skipSave: true });
  finish("OLD_MODEL_PROFILE");
  assert.equal(await pending, "");
  assert.equal(users["20001"].profile, "");
  assert.equal(calls, 1);
});

test("forget invalidates pending relationship comments and drops their output", async () => {
  users["20001"] = { uid: "20001", chats: [] };
  let finish;
  const pending = getRelationshipShortComment({ topics: ["old topic"], confidence: 0.5 }, {
    uid: "20001", user: users["20001"], groupId: "10001",
    callMiMo: () => new Promise(resolve => { finish = resolve; }), callDeepSeek: async () => "",
  });
  forgetUserData("20001", { skipSave: true });
  finish("OLD_RELATION_COMMENT");
  assert.equal(await pending, "");
  assert.deepEqual(users["20001"].relationshipComments, {});
});

test("forget prevents a pending relationship request from starting fallback", async () => {
  users["20001"] = { uid: "20001", chats: [] };
  let finish;
  let fallbackCalls = 0;
  const pending = getRelationshipShortComment({ topics: ["old topic"] }, {
    uid: "20001", user: users["20001"], groupId: "10001",
    callMiMo: () => new Promise(resolve => { finish = resolve; }),
    callDeepSeek: async () => { fallbackCalls++; return "OLD_RESULT"; },
  });
  forgetUserData("20001", { skipSave: true });
  finish(null);
  assert.equal(await pending, "");
  assert.equal(fallbackCalls, 0);
});

test("old unscoped relationship caches are not reused", async () => {
  const user = { uid: "20001", relationshipComments: { "10001": { text: "OTHER_GROUP_DATA", generatedAt: Date.now() } } };
  const text = await getRelationshipShortComment({ topics: ["current"] }, { user, groupId: "10001", callMiMo: async () => "LOCAL_COMMENT", callDeepSeek: async () => "" });
  assert.equal(text, "LOCAL_COMMENT");
});

test("an in-flight relationship card also drops the pre-forget summary", async () => {
  logGroupMsg("10001", "OLD_LOCAL_NAME", "archive", "20001", "member");
  let finish;
  const pending = buildRelationshipCommandReplyAsync("关系", {
    users, userId: "20002", groupId: "10001", mentionedUsers: [{ qq: "20001" }],
    callMiMo: () => new Promise(resolve => { finish = resolve; }), callDeepSeek: async () => "",
  });
  forgetUserData("20001", { skipSave: true });
  finish("OLD_RELATION_COMMENT");
  assert.doesNotMatch(await pending, /OLD_LOCAL_NAME|OLD_RELATION_COMMENT|熟悉度/);
});

test("expired profiles reset instead of reviving old evidence", () => {
  const start = 1000;
  observeMemoryEvent({ uid: "20001", groupId: "10001", text: "不要提STALE_ONLY" }, { now: start });
  observeMemoryEvent({ uid: "20001", groupId: "10001", text: "漫画下载讨论" }, { now: start + 1 });
  const later = start + 35 * 86400000;
  assert.equal(getActiveMemoryContext("20001", "10001", { now: later }).userProfile, null);
  observeMemoryEvent({ uid: "20001", groupId: "10001", text: "普通消息超过四字" }, { now: later + 1 });
  observeMemoryEvent({ uid: "20001", groupId: "10001", text: "另外一个普通消息" }, { now: later + 2 });
  const active = getActiveMemoryContext("20001", "10001", { now: later + 3 });
  assert.ok(active.userProfile);
  assert.doesNotMatch(JSON.stringify(active), /STALE_ONLY|漫画/);
  assert.equal(active.userProfile.confidence, 0.16);
});

test("zero-confidence user profiles stay inactive without disabling group defaults", () => {
  observeMemoryEvent({ uid: "20001", groupId: "10001", text: "累" });
  const ctx = getActiveMemoryContext("20001", "10001");
  assert.equal(ctx.userProfile, null);
  assert.equal(ctx.userGroupProfile, null);
  assert.ok(ctx.groupProfile);
});

test("all saved style dimensions reach both prompt modes", () => {
  setUserStylePreference("20001", "简短 技术 不吐槽 给步骤 直接点 不要表情 正式", { skipSave: true });
  for (const block of [buildPreferenceContextBlock("20001"), buildMinimalPreferenceContextBlock("20001")]) {
    for (const label of ["简短", "技术", "不吐槽", "给步骤", "直接", "不要表情", "正式"]) assert.ok(block.includes(label), label);
  }
});

test("personal retrieval and group background do not duplicate a message", () => {
  logGroupMsg("10001", "name", "archive UNIQUE_ONCE", "20001", "member", null, { messageId: "old" });
  const packet = buildReplyContextPacket({ uid: "20001", groupId: "10001", userMsg: "archive", currentMessageId: "new" });
  assert.equal(JSON.stringify(packet.messages).split("UNIQUE_ONCE").length - 1, 1);
  assert.equal(packet.retrieval.sources.filter(source => source.messageId === "old").length, 1);
});

test("recall deduplication preserves other participants' linked replies", () => {
  const now = Date.now();
  logGroupMsg("10001", "name", "archive UNIQUE_ANCHOR", "20001", "member", null, { messageId: "anchor" });
  groupChats["10001"].push({ uid: "20002", text: "LINKED_REPLY", ts: now + 1, messageId: "linked", replyToMessageId: "anchor" });
  for (let i = 0; i < 6; i++) groupChats["10001"].push({ uid: "20003", text: "unrelated meal " + i, ts: now + 2 + i, messageId: "noise" + i });
  const packet = buildReplyContextPacket({ uid: "20001", groupId: "10001", userMsg: "archive", currentMessageId: "new" });
  const content = JSON.stringify(packet.messages);
  assert.equal(content.split("UNIQUE_ANCHOR").length - 1, 1);
  assert.match(content, /LINKED_REPLY/);
  assert.doesNotMatch(content, /unrelated meal/);
});
