import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-source-lineage-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats, logGroupMsg } = await import("../bridge/storage.mjs");
const { memoryProfiles, createRoot } = await import("../bridge/memory-profile/store.mjs");
const { observeMemoryEvent } = await import("../bridge/memory-profile/updates.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { buildRelationshipCommandReply, buildRelationshipCommandReplyAsync } = await import("../bridge/commands/modules/relationship.mjs");
const { handleGroupMessage } = await import("../bridge/reply-group.mjs");
const { getActiveMemoryContext } = await import("../bridge/memory-profile/query.mjs");
const { readProfileTextEvidence, captureProfileReadReason } = await import("../bridge/memory-profile/projection.mjs");
const { computeRelationship, scopeRelationshipUser } = await import("../bridge/relationship.mjs");
const { validateQuotedReply } = await import("../bridge/context/quoted-reply.mjs");
const { storedScopeSourceLinks } = await import("../bridge/memory-profile/retention.mjs");
const { collectSourceMessageIds, normalizeSourceMessageIds, expandMemorySourceExclusions, createMemorySourceGraph } = await import("../bridge/memory-profile/source-exclusions.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { withChatRun, chatRunStopReason } = await import("../bridge/cognition/chat-run.mjs");
const { resolveReplyContext } = await import("../bridge/reply-handlers.mjs");
const DAY = 86400000;
let sequence = 0;
after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t) {
  const n = ++sequence;
  const uid = String(63000 + n * 10), peer = String(63001 + n * 10), groupId = String(53000 + n * 10);
  const state = { now: 1800000000000, message: 83000 + n * 100 };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(Math, "random", () => 1);
  t.mock.method(globalThis, "fetch", () => assert.fail("no network in lineage fixture"));
  CFG.groupWhitelist = [Number(groupId)]; CFG.summaryGroupWhitelist = []; CFG.botBlacklist = [];
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  for (const key of Object.keys(memoryProfiles)) delete memoryProfiles[key];
  Object.assign(memoryProfiles, createRoot());
  const notes = createMemoryNoteService({ profiles: memoryProfiles, now: () => state.now, persist: () => true });
  for (const name of ["snapshot", "corrections", "metadata"]) t.mock.method(memoryNoteService, name, notes[name]);
  const scope = { userId: uid, groupId };
  const act = payload => notes.act({ ...scope, revision: notes.snapshot(scope).revision, ...payload }, { origin: "user_command", messageId: "83901" });
  function message(owner, text, meta = {}) {
    state.now++;
    const messageId = meta.messageId || String(++state.message);
    logGroupMsg(groupId, "Synthetic", text, owner, "member", null, { ...meta, messageId });
    observeMemoryEvent({ uid: owner, groupId, text });
    return messageId;
  }
  async function receive(owner, text, parent) {
    state.now++;
    const messageId = String(++state.message);
    await handleGroupMessage({ message_type: "group", group_id: groupId, user_id: owner, message_id: messageId,
      text, rawText: text, nickname: "Synthetic", images: [], files: [], mentions: [], isAtMe: false,
      replyData: parent ? { id: parent } : null, eventTime: state.now }, []);
    return messageId;
  }
  return { uid, peer, groupId, state, notes, scope, act, message, receive };
}

test("relationship output cannot reintroduce removed source topics through its raw-text fallback", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "Technical project" }).items[0];
  f.message(f.uid, "代码 API 测试", { messageId: note.source.messageId });
  f.message(f.uid, "模型模块代码实现", { replyToMessageId: note.source.messageId });
  f.act({ action: "remove", id: note.id });
  assert.deepEqual(getActiveMemoryContext(f.uid, f.groupId).groupProfile.activeTopics, []);
  const options = { userId: f.uid, groupId: f.groupId, users, groupChats: groupChats[f.groupId] };
  assert.doesNotMatch(buildRelationshipCommandReply("关系", options), /技术讨论|技术搭子|偏技术/);
  let prompt = "";
  const text = await buildRelationshipCommandReplyAsync("关系", { ...options, callMiMo: async value => { prompt = value; return "目前只保留互动统计，具体话题还需要有效记录。"; },
    callDeepSeek: async () => assert.fail("unexpected fallback") });
  assert.doesNotMatch(prompt + text, /技术讨论|技术搭子|偏技术/);
});

test("an expired technical source cannot become a current relationship preference", t => {
  const f = fixture(t);
  f.message(f.uid, "代码测试模型的技术旧消息");
  f.state.now += 31 * DAY;
  f.message(f.uid, "今天普通消息和天气消息足够长");
  const text = buildRelationshipCommandReply("关系", { userId: f.uid, groupId: f.groupId, users });
  assert.doesNotMatch(text, /技术讨论|技术搭子|偏技术/);
});

test("post-retraction group arrivals stay excluded after intermediate group and peer buffers are lost", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "Original project" }).items[0];
  f.act({ action: "remove", id: note.id });
  const child = await f.receive(f.uid, "机器人模型项目后续内容", note.source.messageId);
  const leaf = await f.receive(f.peer, "机器人模型项目最后一层", child);
  groupChats[f.groupId] = groupChats[f.groupId].filter(row => row.messageId === leaf);
  users[f.uid].chats = [];
  assert.equal(users[f.peer].chats.find(row => row.messageId === leaf).retracted, true);
  assert.ok(f.notes.corrections({ userId: f.peer, groupId: f.groupId }).excludedMessageIds.has(leaf));
  assert.deepEqual(getActiveMemoryContext(f.peer, f.groupId).groupProfile.activeTopics, []);
});

for (const surface of ["group", "private"]) {
  test(`${surface} source-backed prose preserves every numerical relationship output`, t => {
    const f = fixture(t);
    f.message(f.uid, "代码模型测试 哈哈", { retracted: true });
    f.message(f.uid, "普通的天气交流消息足够长");
    const user = surface === "group" ? scopeRelationshipUser(users[f.uid], f.groupId) : users[f.uid];
    const groupId = surface === "group" ? f.groupId : "private";
    const memoryContext = getActiveMemoryContext(f.uid, groupId, { groupOnly: surface === "group" });
    const evidence = readProfileTextEvidence(f.uid, groupId, { chats: user.chats });
    const old = computeRelationship(user, { currentGroupId: groupId, memoryContext });
    const next = computeRelationship(user, { currentGroupId: groupId, memoryContext, descriptionChats: evidence.chats });
    for (const [key, value] of Object.entries(old)) if (typeof value === "number" || /SeenAt|ActiveAt/.test(key)) assert.equal(next[key], value, key);
    assert.equal(next.messageCount, 2);
    assert.doesNotMatch(JSON.stringify([next.relationshipTags, next.topics, next.replyStyle]), /技术|整活/);
  });

  for (const change of ["expiry", "correction"]) {
    test(`${surface} raw-stat fallback evidence is guarded during pending prose after ${change}`, async t => {
      const f = fixture(t);
      const note = f.act({ action: "create", title: "Project", text: "Current project", ttlDays: 1 }).items[0];
      f.message(f.uid, "promise connection details", { replyToMessageId: note.source.messageId });
      f.state.now = note.expiresAt - 1;
      let calls = 0;
      const text = await buildRelationshipCommandReplyAsync("关系", { userId: f.uid, groupId: surface === "group" ? f.groupId : "private", users,
        callMiMo: async prompt => {
          calls++; assert.match(prompt, /技术/);
          if (change === "expiry") f.state.now = note.expiresAt;
          else f.act({ action: "update", id: note.id, text: "New project" });
          return "STALE_FALLBACK_COMMENT";
        }, callDeepSeek: async () => assert.fail("invalid source must not use another model") });
      assert.equal(calls, 1); assert.equal(text, "资料已更新，请重新查询。");
      assert.ok(!JSON.stringify(users[f.uid]).includes("STALE_FALLBACK_COMMENT"));
    });
  }
}

test("metadata-only same-group peer ancestry can survive the shared buffer without exposing another scope", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "NONPUBLIC_NOTE_BODY" }).items[0];
  f.act({ action: "remove", id: note.id });
  const child = await f.receive(f.uid, "NONPUBLIC_CHAT_BODY", note.source.messageId);
  groupChats[f.groupId] = [];
  users[f.uid].chats.push({ group: "private", messageId: "83951", text: "PRIVATE_BODY" },
    { group: "53999", messageId: "83952", text: "OTHER_GROUP_BODY" },
    { group: f.groupId, groupId: "private", messageId: "83953", text: "CONTRADICTORY_SCOPE" });
  const links = storedScopeSourceLinks({ userId: f.peer, groupId: f.groupId });
  assert.ok(links.some(row => row.messageId === child && row.retracted));
  assert.doesNotMatch(JSON.stringify(links), /NONPUBLIC|PRIVATE_BODY|OTHER_GROUP_BODY|83951|83952|83953/);
  const leaf = await f.receive(f.peer, "机器人模型新的后继", child);
  assert.equal(users[f.peer].chats.find(row => row.messageId === leaf).retracted, true);
  assert.equal(storedScopeSourceLinks({ userId: f.peer, groupId: "private" }).length, 0);
});

test("independent messages, other groups and text similarity are not marked as retracted", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "Old project" }).items[0];
  f.act({ action: "remove", id: note.id });
  const independent = await f.receive(f.peer, "机器人模型项目后续内容", undefined);
  assert.equal(users[f.peer].chats.find(row => row.messageId === independent).retracted, undefined);
  const foreign = "53998"; CFG.groupWhitelist.push(Number(foreign));
  await handleGroupMessage({ message_type: "group", group_id: foreign, user_id: f.peer, message_id: "83960", text: "机器人模型新群", rawText: "机器人模型新群",
    nickname: "Synthetic", images: [], files: [], mentions: [], isAtMe: false, replyData: { id: note.source.messageId }, eventTime: f.state.now }, []);
  assert.equal(groupChats[foreign][0].retracted, undefined);
});

test("an unverifiable quoted source is conservatively excluded but ordinary messages remain available", async t => {
  const f = fixture(t);
  t.mock.method(memoryNoteService, "corrections", () => { throw new Error("unavailable"); });
  const quoted = await f.receive(f.uid, "quoted unknown", "83961");
  const independent = await f.receive(f.peer, "independent message", undefined);
  assert.equal(users[f.uid].chats.find(row => row.messageId === quoted).retracted, true);
  assert.equal(users[f.peer].chats.find(row => row.messageId === independent).retracted, undefined);
});

test("a freshly fetched quote cannot reuse a flagged descendant after its original note was pruned", t => {
  const f = fixture(t);
  const child = f.message(f.peer, "机器人项目旧回复", { retracted: true });
  memoryProfiles.notes = { schema: 1, revision: 0, items: [], retractions: [] };
  groupChats[f.groupId] = [];
  const reply = { text: "机器人项目旧回复", images: [], source: { messageType: "group", groupId: f.groupId,
    messageId: child, userId: f.peer, time: Math.floor(f.state.now / 1000) } };
  const evidence = validateQuotedReply({ message_type: "group", group_id: f.groupId, message_id: "83971", replyData: { id: child } }, reply);
  assert.equal(evidence.reason, "quote_superseded");
});

test("direct qualitative evidence excludes private and foreign chats and fails closed when source metadata is corrupt", t => {
  const f = fixture(t);
  f.message(f.uid, "promise details in current group");
  users[f.uid].chats.push({ group: "private", messageId: "83981", text: "PRIVATE_BODY", ts: f.state.now },
    { group: "53999", messageId: "83982", text: "FOREIGN_BODY", ts: f.state.now });
  const scoped = readProfileTextEvidence(f.uid, f.groupId);
  assert.equal(scoped.chats.length, 1);
  assert.doesNotMatch(JSON.stringify(scoped.chats), /PRIVATE_BODY|FOREIGN_BODY/);
  memoryProfiles.notes = { invalid: true };
  const invalid = readProfileTextEvidence(f.uid, f.groupId);
  assert.deepEqual(invalid.chats, []);
  assert.equal(captureProfileReadReason({ evidence: invalid.profile })(), "memory_unavailable");
});

for (const change of ["correction", "expiry", "deletion"]) {
  test(`valid ancestry survives intermediate eviction and still honors later ${change}`, async t => {
    const f = fixture(t);
    const note = f.act({ action: "create", title: "Project", text: "Original project", ttlDays: 1 }).items[0];
    const child = await f.receive(f.uid, "机器人模型中间引用", note.source.messageId);
    const leaf = await f.receive(f.peer, "机器人模型叶子引用", child);
    const row = users[f.peer].chats.find(item => item.messageId === leaf);
    assert.deepEqual(new Set(row.memorySourceIds), new Set([child, note.source.messageId]));
    assert.equal(row.retracted, undefined);
    groupChats[f.groupId] = groupChats[f.groupId].filter(item => item.messageId === leaf);
    users[f.uid].chats = [];
    if (change === "expiry") f.state.now = note.expiresAt;
    else f.act(change === "correction" ? { action: "update", id: note.id, text: "New project" } : { action: "remove", id: note.id });
    assert.ok(f.notes.corrections({ userId: f.peer, groupId: f.groupId }).excludedMessageIds.has(leaf));
    const view = getActiveMemoryContext(f.peer, f.groupId);
    assert.deepEqual(view.groupProfile.activeTopics, []);
    const packet = buildReplyContextPacket({ uid: f.peer, groupId: f.groupId, userMsg: "机器人项目" });
    assert.doesNotMatch(JSON.stringify(packet.messages), /中间引用|叶子引用/);
  });
}

test("stored ancestry binds a live note deadline after all intermediate links have gone", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "Original project", ttlDays: 1 }).items[0];
  const child = await f.receive(f.uid, "机器人模型中间", note.source.messageId);
  const leaf = await f.receive(f.peer, "机器人模型叶子", child);
  groupChats[f.groupId] = groupChats[f.groupId].filter(row => row.messageId === leaf);
  users[f.uid].chats = [];
  const profile = getActiveMemoryContext(f.peer, f.groupId).groupProfile;
  assert.equal(profile.sourceExpiresAt, note.expiresAt);
  const reason = captureProfileReadReason({ profile });
  f.state.now = note.expiresAt;
  assert.equal(reason(), "memory_expired");
});

for (const imageOnly of [false, true]) {
  test(`${imageOnly ? "image-only" : "text"} quote carries captured ancestry even if its parent disappears while waiting`, async t => {
    const f = fixture(t);
    const note = f.act({ action: "create", title: "Project", text: "Original project", ttlDays: 1 }).items[0];
    f.state.now = note.expiresAt - 1;
    const scope = { userId: f.peer, groupId: f.groupId, surface: "group" };
    const result = await withChatRun(scope, async () => {
      const packet = buildReplyContextPacket({ uid: f.peer, groupId: f.groupId, userMsg: "理解这个引用",
        replyText: imageOnly ? "" : "QUOTED_CURRENT_SOURCE", replyToMessageId: "83992", replyUserId: f.peer,
        hasImages: imageOnly, memorySourceIds: ["83992", note.source.messageId],
        quoteEvidence: { state: "verified", messageId: "83992", userId: f.peer, groupId: f.groupId, at: f.state.now } });
      assert.deepEqual(packet.memorySources, [{ noteId: note.id, revision: 1 }]);
      assert.equal(chatRunStopReason(), "");
      assert.doesNotMatch(JSON.stringify(packet.messages), /memorySourceIds/);
      f.state.now = note.expiresAt;
      assert.equal(chatRunStopReason(), "memory_expired");
      return { kind: "reply", text: "STALE_CAPTURED_QUOTE" };
    });
    assert.equal(result.reason, "memory_expired");
  });
}

test("ancestry has a lossless 32-id bound, normalizes duplicates and terminates cycles", () => {
  assert.deepEqual(normalizeSourceMessageIds(["1", 1, "-2"]), ["1", "-2"]);
  assert.equal(normalizeSourceMessageIds([{}]), null);
  assert.equal(normalizeSourceMessageIds(Array.from({ length: 33 }, (_, i) => String(i + 1))), null);
  const chain = Array.from({ length: 32 }, (_, i) => ({ messageId: String(i + 1), replyToMessageId: String(i + 2) }));
  assert.equal(collectSourceMessageIds(chain, ["1"]), null);
  assert.deepEqual(collectSourceMessageIds([{ messageId: "1", replyToMessageId: "2" }, { messageId: "2", turnId: "1" }], ["1"]), ["1", "2"]);
  assert.ok(expandMemorySourceExclusions([{ messageId: "3", memorySourceIds: ["1", "2"] }], new Set(["1"])).has("3"));
  assert.ok(createMemorySourceGraph([{ memorySourceIds: ["1"] }]).references.has("1"), "id-less assistant records still retain referenced tombstones");
});

test("an over-limit incoming quote is not silently truncated or fetched as usable evidence", async t => {
  const f = fixture(t);
  users[f.uid] = { chats: [{ group: f.groupId, messageId: "83993", ts: f.state.now,
    memorySourceIds: Array.from({ length: 32 }, (_, i) => String(84000 + i)) }] };
  const id = await f.receive(f.peer, "机器人模型超长引用链", "83993");
  assert.equal(users[f.peer].chats.find(row => row.messageId === id).retracted, true);
  const ctx = { replyData: { id: "83993" }, memorySourceExcluded: true };
  assert.equal(await resolveReplyContext(ctx), "");
  assert.equal(ctx.quoteEvidence.reason, "quote_memory_unavailable");
});
