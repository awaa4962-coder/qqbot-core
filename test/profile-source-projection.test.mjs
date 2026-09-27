import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-source-profiles-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { users, groupChats, logGroupMsg } = await import("../bridge/storage.mjs");
const { memoryProfiles, createRoot } = await import("../bridge/memory-profile/store.mjs");
const { observeMemoryEvent } = await import("../bridge/memory-profile/updates.mjs");
const { getActiveMemoryContext } = await import("../bridge/memory-profile/query.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { computeRelationship, RELATIONSHIP_SCORE_FIELDS } = await import("../bridge/relationship.mjs");
const { captureProfileReadReason } = await import("../bridge/memory-profile/projection.mjs");
const { buildRelationshipCommandReplyAsync } = await import("../bridge/commands/modules/relationship.mjs");
const { describeUserProfile, describeGroupProfile, describeUserGroupProfile } = await import("../bridge/memory-profile/presentation.mjs");
const DAY = 86400000;
let sequence = 0;

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t) {
  const index = ++sequence;
  const uid = String(61200 + index * 10), peer = String(61201 + index * 10), groupId = String(51200 + index * 10);
  const state = { now: 1800000000000, message: 71200 + index * 100 };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(globalThis, "fetch", () => assert.fail("no network for source projection"));
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  for (const key of Object.keys(memoryProfiles)) delete memoryProfiles[key];
  Object.assign(memoryProfiles, createRoot());
  const notes = createMemoryNoteService({ profiles: memoryProfiles, now: () => state.now, persist: () => true });
  for (const name of ["snapshot", "corrections", "metadata"]) t.mock.method(memoryNoteService, name, notes[name]);
  function message(owner, text, extra = {}) {
    state.now++;
    const messageId = String(++state.message);
    logGroupMsg(groupId, "Synthetic member", text, owner, "member", null, { messageId, ...extra });
    observeMemoryEvent({ uid: owner, groupId, text, nickname: "Synthetic member" }, { now: state.now });
    return messageId;
  }
  return { uid, peer, groupId, state, notes, message, context: owner => getActiveMemoryContext(owner || uid, groupId) };
}

test("forgetting a contributor removes only their shared group inferences and restores surviving explicit intent", t => {
  const f = fixture(t);
  f.message(f.peer, "漫画下载完成，可以多插话");
  f.message(f.uid, "机器人模型上下文需要安静，别插话");
  assert.ok(f.context(f.peer).groupProfile.activeTopics.includes("机器人"));
  assert.equal(f.context(f.peer).groupProfile.interjectionTolerance, "low");
  assert.equal(forgetUserData(f.uid, { skipSave: true }).ok, true);
  const group = f.context(f.peer).groupProfile;
  assert.ok(!group.activeTopics.includes("机器人"));
  assert.ok(group.activeTopics.includes("漫画"));
  assert.equal(group.interjectionTolerance, "high");
});

test("continued activity cannot renew a thirty-day-old topic or dislike", t => {
  const f = fixture(t);
  f.message(f.uid, "机器人模型项目，不要提STALE_DISLIKE");
  for (const days of [10, 20, 31]) {
    f.state.now = 1800000000000 + days * DAY;
    f.message(f.uid, "今天讨论天气消息足够长");
  }
  const view = f.context();
  assert.ok(view.userProfile);
  assert.ok(!view.userProfile.commonTopics.includes("机器人"));
  assert.ok(!view.userProfile.dislikes.includes("STALE_DISLIKE"));
});

test("source-backed text projection preserves all existing numerical relationship fields", t => {
  const f = fixture(t);
  f.message(f.uid, "机器人上下文测试"); f.message(f.uid, "漫画下载调试");
  const raw = { userProfile: memoryProfiles.userProfiles[f.uid], groupProfile: memoryProfiles.groupProfiles[f.groupId],
    userGroupProfile: memoryProfiles.userGroupProfiles[f.groupId + ":" + f.uid] };
  const old = computeRelationship(users[f.uid], { currentGroupId: f.groupId, memoryContext: raw, now: f.state.now });
  const next = computeRelationship(users[f.uid], { currentGroupId: f.groupId, memoryContext: f.context(), now: f.state.now });
  for (const key of [...RELATIONSHIP_SCORE_FIELDS, "confidence", "groupFamiliarity", "messageCount", "evidenceCount"]) assert.equal(next[key], old[key], key);
});

test("a retraction must survive while a stored reply still references its missing original", t => {
  const f = fixture(t);
  const scope = { userId: f.uid, groupId: f.groupId };
  const snapshot = f.notes.act({ ...scope, revision: f.notes.snapshot(scope).revision, action: "create", title: "Project", text: "Old project" },
    { origin: "user_command", messageId: "79901" });
  f.notes.act({ ...scope, revision: snapshot.revision, action: "remove", id: snapshot.items[0].id });
  const child = f.message(f.peer, "机器人项目引用", { replyToMessageId: "79901" });
  f.state.now += 2 * DAY;
  f.notes.prune(f.state.now);
  assert.equal(f.notes.corrections({ userId: f.peer, groupId: f.groupId }).excludedMessageIds.has(child), true);
});

function createNote(f, scope = { userId: f.uid, groupId: f.groupId }, messageId = "79901") {
  return f.notes.act({ ...scope, revision: f.notes.snapshot(scope).revision, action: "create", title: "Project", text: "机器人项目", ttlDays: 1 },
    { origin: "user_command", messageId }).items[0];
}

function removeNote(f, note) {
  const scope = { userId: note.userId, groupId: note.groupId };
  return f.notes.act({ ...scope, revision: f.notes.snapshot(scope).revision, action: "remove", id: note.id });
}

test("negative evidence follows peer-only reply archives and materializes transitive ids before links are evicted", t => {
  const f = fixture(t), note = createNote(f);
  const child = f.message(f.peer, "机器人项目回复", { replyToMessageId: note.source.messageId });
  const leaf = f.message(f.peer, "机器人项目后续", { turnId: child });
  groupChats[f.groupId] = [];
  removeNote(f, note);
  users[f.peer].chats = users[f.peer].chats.filter(row => row.messageId === leaf).map(row => ({ ...row, turnId: undefined }));
  f.state.now += 2 * DAY;
  f.notes.prune();
  assert.ok(memoryProfiles.notes.retractions.some(row => row.messageId === leaf));
  assert.ok(!f.context(f.peer).userProfile.commonTopics.includes("机器人"));
  assert.ok(!JSON.stringify(memoryProfiles.notes.retractions).includes("机器人"));
});

test("private source ids and identical message ids in other groups cannot cross scopes", t => {
  const f = fixture(t);
  const ownScope = { userId: f.uid, groupId: "private" };
  const note = createNote(f, ownScope);
  users[f.uid] = { chats: [{ group: "private", messageId: "79911", replyToMessageId: "79901", ts: f.state.now }] };
  users[f.peer] = { chats: [{ group: "private", messageId: "79912", replyToMessageId: "79901", ts: f.state.now }] };
  groupChats[f.groupId] = [{ uid: f.peer, messageId: "79913", replyToMessageId: "79901", ts: f.state.now }];
  removeNote(f, note);
  const ids = f.notes.corrections(ownScope).excludedMessageIds;
  assert.ok(ids.has("79911")); assert.ok(!ids.has("79912")); assert.ok(!ids.has("79913"));
  assert.equal(f.notes.corrections({ userId: f.peer, groupId: "private" }).excludedMessageIds.size, 0);
  assert.equal(f.notes.corrections({ userId: f.uid, groupId: f.groupId }).excludedMessageIds.size, 0);
});

test("clear removes positive bodies but keeps minimum negative source ids to prevent resurrection", t => {
  const f = fixture(t), note = createNote(f);
  const child = f.message(f.peer, "机器人项目回复", { replyToMessageId: note.source.messageId });
  assert.equal(f.notes.clear({ userId: f.uid }), true);
  assert.equal(memoryProfiles.notes.items.length, 0);
  assert.ok(f.notes.corrections({ userId: f.peer, groupId: f.groupId }).excludedMessageIds.has(child));
  for (const row of memoryProfiles.notes.retractions) assert.deepEqual(Object.keys(row).sort(), ["at", "groupId", "messageId", "noteId", "userId"]);
  assert.ok(!f.context(f.peer).groupProfile.activeTopics.includes("机器人"));
});

test("pruning persists changed source ids even when their total count is unchanged", t => {
  const f = fixture(t), note = createNote(f);
  removeNote(f, note);
  const child = f.message(f.peer, "机器人项目回复", { replyToMessageId: note.source.messageId });
  f.state.now += 2 * DAY;
  const service = createMemoryNoteService({ profiles: memoryProfiles, now: () => f.state.now,
    persist: () => true, hasSource: item => item.messageId === child });
  assert.equal(service.prune(), true);
  assert.deepEqual(memoryProfiles.notes.retractions.map(item => item.messageId), [child]);
});

test("full negative-source capacity rejects an edit without partially replacing the old note", t => {
  const f = fixture(t), note = createNote(f);
  memoryProfiles.notes.retractions = Array.from({ length: 8192 }, (_, i) => ({ userId: f.uid, groupId: f.groupId,
    noteId: note.id, messageId: String(900000 + i), at: f.state.now }));
  const before = JSON.stringify(memoryProfiles.notes);
  assert.throws(() => removeNote(f, note), error => error.statusCode === 409);
  assert.equal(JSON.stringify(memoryProfiles.notes), before);
});

test("malformed source archives fail closed and leave note pruning and edits unchanged", t => {
  const f = fixture(t), note = createNote(f);
  users[f.peer] = { chats: { invalid: true } };
  const before = JSON.stringify(memoryProfiles.notes);
  assert.throws(() => removeNote(f, note), /memory_source_store_unavailable/);
  f.state.now += 9 * DAY;
  assert.throws(() => f.notes.prune(), /memory_source_store_unavailable/);
  assert.equal(JSON.stringify(memoryProfiles.notes), before);
});

test("projections reject private, misattributed, recalled, future and untraceable source text", t => {
  const f = fixture(t);
  f.message(f.uid, "普通天气资料消息"); f.message(f.uid, "今天依旧普通消息");
  const invalid = [
    { group: "private" }, { uid: f.peer }, { userId: f.peer }, { user_id: f.peer },
    { groupId: "51999" }, { group_id: "51999" }, { recalled: true }, { memoryCommand: true },
    { role: "assistant" }, { messageId: "" }, { ts: f.state.now + 1 },
  ].map((extra, i) => ({ group: f.groupId, uid: f.uid, ts: f.state.now, messageId: String(79920 + i), text: "机器人模型秘密", ...extra }));
  users[f.uid].chats.push(...invalid);
  groupChats[f.groupId].push(...invalid.filter(row => row.uid !== f.peer));
  memoryProfiles.userProfiles[f.uid].commonTopics.push("UNATTRIBUTED");
  const view = f.context();
  assert.ok(!view.userProfile.commonTopics.includes("机器人"));
  assert.ok(!view.userProfile.commonTopics.includes("UNATTRIBUTED"));
  assert.ok(!view.groupProfile.activeTopics.includes("机器人"));
});

test("same-millisecond explicit intent follows arrival order and expires after seven days", t => {
  const f = fixture(t);
  f.message(f.uid, "欢迎多插话"); f.message(f.peer, "不要插话");
  for (const row of groupChats[f.groupId]) row.ts = f.state.now;
  const view = f.context().groupProfile;
  assert.equal(view.interjectionTolerance, "low");
  const read = captureProfileReadReason({ groupProfile: view });
  assert.equal(read(), "");
  f.state.now += 7 * DAY;
  assert.equal(read(), "memory_expired");
  assert.equal(f.context().groupProfile.interjectionTolerance, "normal");
});

test("only selected field witnesses constrain a projected profile lifetime", t => {
  const f = fixture(t);
  f.message(f.uid, "普通天气消息很长，没有主题的旧句子");
  groupChats[f.groupId][0].ts = f.state.now - 30 * DAY + 1;
  f.message(f.uid, "代码测试修复模型问题");
  const view = f.context().groupProfile;
  assert.equal(view.sourceCount, 1);
  assert.equal(view.sourceExpiresAt, f.state.now + 30 * DAY + 1);
  const read = captureProfileReadReason({ groupProfile: view });
  f.state.now += 10;
  assert.equal(read(), "");
});

test("correction invalidates an already projected group source even without AsyncLocalStorage", t => {
  const f = fixture(t), note = createNote(f);
  f.message(f.peer, "机器人模型项目", { replyToMessageId: note.source.messageId });
  const view = f.context(f.peer), read = captureProfileReadReason(view);
  assert.equal(read(), "");
  removeNote(f, note);
  assert.equal(read(), "privacy_changed");
  assert.ok(!f.context(f.peer).groupProfile.activeTopics.includes("机器人"));
});

for (const groupId of ["group", "private"]) {
  test(`${groupId} relationship short comment cannot return or cache a late expired source`, async t => {
    const f = fixture(t), note = createNote(f);
    f.message(f.uid, "代码模型项目测试", { replyToMessageId: note.source.messageId });
    f.message(f.uid, "漫画下载新进度");
    f.state.now = note.expiresAt - 1;
    let calls = 0;
    const text = await buildRelationshipCommandReplyAsync("关系", { userId: f.uid, groupId: groupId === "group" ? f.groupId : "private",
      users, groupChats: groupChats[f.groupId], callMiMo: async () => {
        calls++; f.state.now = note.expiresAt; return "STALE_SOURCE_COMMENT";
      }, callDeepSeek: async () => assert.fail("expiry must not trigger fallback") });
    assert.equal(calls, 1);
    assert.equal(text, "资料已更新，请重新查询。");
    assert.ok(!JSON.stringify(users[f.uid]).includes("STALE_SOURCE_COMMENT"));
  });
}

test("forget cleans shared cached text but preserves peer chats, preferences and numerical counters", t => {
  const f = fixture(t);
  f.message(f.peer, "漫画下载新章节"); f.message(f.peer, "今天聊漫画测试");
  f.message(f.uid, "机器人上下文模型");
  const peer = users[f.peer]; peer.preferences = { nickname: "Synthetic preference" };
  const before = JSON.stringify(peer);
  const counters = [memoryProfiles.userProfiles[f.peer].confidence, memoryProfiles.userProfiles[f.peer].evidenceCount,
    memoryProfiles.userGroupProfiles[f.groupId + ":" + f.peer].confidence];
  assert.equal(forgetUserData(f.uid, { skipSave: true }).ok, true);
  assert.ok(!memoryProfiles.groupProfiles[f.groupId].activeTopics.includes("机器人"));
  assert.ok(memoryProfiles.groupProfiles[f.groupId].activeTopics.includes("漫画"));
  assert.equal(JSON.stringify(peer), before);
  assert.deepEqual([memoryProfiles.userProfiles[f.peer].confidence, memoryProfiles.userProfiles[f.peer].evidenceCount,
    memoryProfiles.userGroupProfiles[f.groupId + ":" + f.peer].confidence], counters);
});

test("human profile summaries distinguish insufficient sources from unavailable data and qualify inferred text", t => {
  const f = fixture(t);
  f.message(f.uid, "代码测试修复模型"); f.message(f.uid, "代码测试漫画新进展");
  const context = f.context();
  for (const [profile, describe] of [[context.userProfile, describeUserProfile], [context.groupProfile, describeGroupProfile],
    [context.userGroupProfile, describeUserGroupProfile]]) {
    assert.match(describe(profile), /推测，不是固定偏好/);
    assert.match(describe({ ...profile, sourceState: "empty" }), /记录不足/);
    assert.match(describe({ ...profile, sourceState: "unavailable" }), /未使用旧画像/);
    assert.doesNotMatch(describe({ ...profile, sourceState: "empty" }), /技术|机器人|自然|可信度/);
  }
});
