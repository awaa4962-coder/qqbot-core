import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-derived-readers-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { memoryProfiles } = await import("../bridge/memory-profile/store.mjs");
const { clearUserMemoryProfile, clearGroupMemoryProfile } = await import("../bridge/memory-profile/updates.mjs");
const { recentTopicEvidence } = await import("../bridge/memory-profile/evidence.mjs");
const { generateProfile } = await import("../bridge/profile.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { recordConversationTurn, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");
const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { READ_TOOLS } = await import("../bridge/chat-tools/policy.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { getRelationshipShortComment } = await import("../bridge/relationship-comment.mjs");
const { buildRelationshipCommandReplyAsync } = await import("../bridge/commands/modules/relationship.mjs");
const { createPersonalReadGuard } = await import("../bridge/commands/read-guard.mjs");
const { dispatchGroupCommand } = await import("../bridge/commands/action-dispatcher.mjs");
const { sendMsg } = await import("../bridge/napcat.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { buildSelfProfileText, buildStyleRecommendation } = await import("../bridge/user-preferences.mjs");
const { buildAdminCommandReply } = await import("../bridge/commands/modules/admin.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { buildMemoryManagerSnapshot } = await import("../bridge/admin-api/memory-manager.mjs");
const DAY = 86400000;
const UID = "60431", PEER = "60432", GROUP = "50431";
const start = 1800000000000;

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t) {
  const state = { now: start };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(globalThis, "fetch", () => assert.fail("unit fixture must not access the network"));
  CFG.groupWhitelist = [Number(GROUP)]; CFG.friendWhitelist = [Number(UID)]; CFG.botBlacklist = [];
  for (const id of [UID, PEER]) users[id] = { uid: id, nicknames: ["Synthetic"], chats: [] };
  groupChats[GROUP] = [];
  const service = createMemoryNoteService({ profiles: {}, now: () => state.now, available: () => true,
    readPrivacy: () => ({ users: {} }), persist: () => true });
  for (const name of ["snapshot", "corrections", "metadata"]) t.mock.method(memoryNoteService, name, service[name]);
  const scope = { userId: PEER, groupId: GROUP };
  const act = payload => service.act({ ...scope, revision: service.snapshot(scope).revision, ...payload }, { origin: "user_command", messageId: "70431" });
  t.after(() => {
    for (const id of [UID, PEER]) delete users[id];
    delete groupChats[GROUP];
    delete memoryProfiles.groupProfiles[GROUP];
    delete memoryProfiles.userGroupProfiles[GROUP + ":" + UID];
    delete memoryProfiles.userProfiles[UID];
    resetCognitionForTest();
  });
  return { state, service, act };
}

function historical(id, ts, extra = {}) {
  return { uid: PEER, group: GROUP, nickname: "Synthetic", messageId: id, text: "代码模型测试 " + id, ts, ...extra };
}

test("mentioned person's selected topic evidence participates in note expiry even outside the recent group window", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "代码模型测试", ttlDays: 1 }).items[0];
  f.state.now = note.expiresAt - 100;
  users[PEER].chats = [historical("70432", f.state.now - 2 * 60 * 60 * 1000, { replyToMessageId: "70431" })];
  const outcome = await withChatRun({ surface: "group", groupId: GROUP, userId: UID }, async () => {
    const packet = buildReplyContextPacket({ uid: UID, groupId: GROUP, userMsg: "这个群友聊过什么", mentions: [{ qq: PEER }] });
    assert.match(JSON.stringify(packet.messages), /近期谈过/);
    assert.deepEqual(packet.memorySources, [{ noteId: note.id, revision: 1 }]);
    f.state.now = note.expiresAt;
    return { kind: "reply", text: "STALE_MENTION" };
  });
  assert.equal(outcome.reason, "memory_expired");
});

test("topic counts, source references and expiry cover the same selected witnesses", t => {
  const f = fixture(t);
  users[PEER].chats = Array.from({ length: 8 }, (_, i) => historical(String(70500 + i), f.state.now - (i + 1) * 100));
  const hints = recentTopicEvidence(PEER, GROUP);
  assert.ok(hints.length);
  for (const hint of hints) {
    assert.equal(hint.sourceCount, hint.sources.length);
    assert.ok(hint.sourceCount <= 3);
    assert.equal(hint.expiresAt, Math.min(...hint.sources.map(source => source.at + 7 * DAY + 1)));
  }
  const manager = buildMemoryManagerSnapshot({ userId: PEER, groupId: GROUP });
  assert.deepEqual(manager.inferences.map(item => item.expiresAt), hints.map(item => item.expiresAt));
  assert.ok(manager.inferences.every(item => !Object.hasOwn(item, "sources")));
});

test("an expiring topic hint without a saved note cancels its pending chat", async t => {
  const f = fixture(t);
  users[PEER].chats = [historical("70531", f.state.now - 7 * DAY + 100)];
  const outcome = await withChatRun({ surface: "group", groupId: GROUP, userId: UID }, async () => {
    const packet = buildReplyContextPacket({ uid: UID, groupId: GROUP, userMsg: "他聊过什么", mentions: [{ qq: PEER }] });
    assert.deepEqual(packet.memorySources, []);
    assert.equal(packet.memoryExpiresAt, start + 101);
    f.state.now += 101;
    return { kind: "reply", text: "STALE_TOPIC" };
  });
  assert.equal(outcome.reason, "memory_expired");
});

test("discarded inference groups neither expire unrelated chat nor leak expiry metadata on the wire", t => {
  fixture(t);
  const bounded = enforceContextBudget([{ role: "user", content: "x".repeat(200), contextExpiresAt: start - 1 }], "current", { maxChars: 7 });
  assert.equal(bounded.memoryExpiresAt, null); assert.deepEqual(bounded.messages, []);
  const current = enforceContextBudget([{ role: "user", content: "current", contextExpiresAt: start + 100 }]);
  assert.equal(current.memoryExpiresAt, start + 100);
  assert.deepEqual(current.messages, [{ role: "user", content: "current" }]);
  for (const bad of [NaN, -1, "1800000000000"]) {
    const rejected = enforceContextBudget([{ role: "user", content: "invalid", contextExpiresAt: bad }]);
    assert.deepEqual(rejected.messages, []);
    assert.equal(rejected.budget.rejectedDependencyGroups, 1);
  }
});

test("tool history time windows expire cached results and do not disclose internal expiry fields", async t => {
  const f = fixture(t);
  users[UID].chats = [{ ...historical("70532", f.state.now - DAY + 100), uid: UID }];
  const scope = { surface: "group", userId: UID, groupId: GROUP };
  const session = createChatToolSession({ scope, cfg: CFG });
  const call = { id: "history", function: { name: "recall_memory", arguments: '{"query":"代码","kind":"history","days":1}' } };
  const raw = recallMemory(scope, { query: "代码", kind: "history", days: 1 });
  assert.equal(raw.memoryExpiresAt, start + 101);
  const result = await session.execute(call, READ_TOOLS);
  assert.match(result.content, /代码/); assert.doesNotMatch(result.content, /memoryExpiresAt|memorySources/);
  f.state.now += 101;
  assert.throws(session.fallbackContext, /memory_expired/);
});

test("real model wrappers preserve prebuilt evidence deadlines without AsyncLocalStorage", async t => {
  const f = fixture(t);
  for (const id of ["derived-readers-primary", "deepseek"]) saveApiProvider({ id, model: id, presetId: "custom-openai-chat",
    endpoint: "https://example.com/" + id, auth: "none", enabled: true, capabilities: ["text"] }, { root });
  saveApiRoutes({ group_chat: { primary: "derived-readers-primary", fallback: "deepseek" },
    private_chat: { primary: "derived-readers-primary", fallback: "deepseek" } }, { root });
  const context = enforceContextBudget([{ role: "user", content: "EXPIRED_TOPIC", contextExpiresAt: start + 10 }]);
  f.state.now += 10;
  const request = { userMsg: "Project", userName: "Synthetic", groupId: GROUP, isAtMe: true,
    history: context.messages, options: { currentUserId: UID } };
  const group = await executeChatTask(request);
  const personal = await executePrivateChatTask({ ...request, groupId: null });
  assert.equal(group.reason, "memory_expired"); assert.equal(personal.reason, "memory_expired");
  assert.equal(group.kind, "cancelled"); assert.equal(personal.kind, "cancelled");
});

test("new thread evidence lifetimes survive paraphrase, cannot renew, and old version-one turns are not trusted", t => {
  const f = fixture(t);
  const record = expiry => recordConversationTurn({ uid: UID, groupId: GROUP, userText: "Project", assistantText: "EXPIRED_DERIVED_BODY",
    memorySources: [], memoryExpiresAt: expiry, now: f.state.now }, { save: false });
  const original = record(start + 100);
  assert.equal(original.turns[0].memoryDependencyVersion, 2);
  const packet = () => buildReplyContextPacket({ uid: UID, groupId: GROUP, userMsg: "继续" });
  assert.equal(packet().memoryExpiresAt, start + 100);
  f.state.now++;
  record(packet().memoryExpiresAt);
  f.state.now = start + 100;
  assert.doesNotMatch(JSON.stringify(packet().messages), /EXPIRED_DERIVED_BODY/);
  f.state.now++;
  record(null);
  users[UID].cognition.threads[GROUP].turns.at(-1).memoryDependencyVersion = 1;
  assert.doesNotMatch(JSON.stringify(packet().messages), /EXPIRED_DERIVED_BODY/);
});

test("background profile generation outside a chat cannot write or fall back after a linked note expires", async t => {
  const f = fixture(t);
  const note = f.act({ action: "create", title: "Project", text: "代码模型测试", ttlDays: 1 }).items[0];
  f.state.now = note.expiresAt - 100;
  users[PEER].chats = [historical("70533", f.state.now - 1000, { replyToMessageId: "70431" })];
  let calls = 0;
  const text = await generateProfile(PEER, { generate: async () => { calls++; f.state.now = note.expiresAt; return "STALE_GENERATED_PROFILE"; } });
  assert.equal(text, ""); assert.equal(calls, 1); assert.equal(users[PEER].profile, undefined);
});

const relation = { familiarity: 60, groupFamiliarity: 40, topics: ["代码"], relationshipTags: ["技术搭子"],
  replyStyle: "简短", groupInteractionStyle: "technical", confidence: 0.7, recentHeat: "普通", messageCount: 50, groupMessageCount: 20 };

test("changed comment semantics invalidate a young cache while minor score movement retains throttling", async t => {
  const f = fixture(t); let calls = 0;
  const options = { uid: UID, user: users[UID], groupId: GROUP, callMiMo: async () => "COMMENT_" + (++calls), callDeepSeek: () => assert.fail("unneeded fallback") };
  const initial = await getRelationshipShortComment(relation, options);
  const fingerprint = users[UID].relationshipComments[GROUP].fingerprint;
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await getRelationshipShortComment({ ...relation, familiarity: 61, confidence: 0.71, messageCount: 51 }, options), initial);
  assert.equal(calls, 1);
  f.state.now++;
  assert.notEqual(await getRelationshipShortComment({ ...relation, topics: ["摄影"] }, options), initial);
  assert.equal(calls, 2);
});

for (const operation of ["group-clear", "profile-expiry"]) {
  test(`${operation} cancels a pending relationship card, suppresses fallback and never caches stale text`, async t => {
    const f = fixture(t);
    users[UID].chats = [{ ...historical("70534", f.state.now - 100), uid: UID }];
    memoryProfiles.userGroupProfiles[GROUP + ":" + UID] = { confidence: 0.8, expiresAt: start + 100, recentTopics: ["STALE_PROFILE_TOPIC"] };
    let calls = 0;
    const reply = await buildRelationshipCommandReplyAsync("关系", { users, userId: UID, groupId: GROUP,
      callMiMo: async () => { calls++; if (operation === "group-clear") clearGroupMemoryProfile(GROUP); else f.state.now += 100; return "STALE_RELATION_COMMENT"; },
      callDeepSeek: () => assert.fail("stale relationship cannot use fallback") });
    assert.equal(reply, "资料已更新，请重新查询。");
    assert.equal(calls, 1); assert.equal(users[UID].relationshipComments?.[GROUP], undefined);
  });
}

test("comment cache expires with the profiles it read, not only the six-hour cache timer", async t => {
  const f = fixture(t); let calls = 0;
  const options = { uid: UID, user: users[UID], groupId: GROUP, memoryExpiresAt: start + 100,
    callMiMo: async () => "CURRENT_" + (++calls), callDeepSeek: () => assert.fail("unused") };
  await getRelationshipShortComment(relation, options);
  assert.equal(users[UID].relationshipComments[GROUP].expiresAt, start + 100);
  f.state.now += 100;
  assert.equal(await getRelationshipShortComment(relation, options), "");
  assert.equal(calls, 1);
});

test("profile clears remove only their dependent cached prose and preserve scoring source messages", t => {
  fixture(t);
  users[UID].chats = [historical("70535", start)]; users[UID].profile = "LEGACY_PROFILE";
  users[UID].relationshipComments = { [GROUP]: { text: "GROUP_COMMENT" }, "50432": { text: "OTHER_COMMENT" } };
  users[PEER].relationshipComments = { [GROUP]: { text: "PEER_GROUP_COMMENT" }, "50432": { text: "PEER_OTHER_COMMENT" } };
  const before = JSON.stringify(users[UID].chats);
  clearGroupMemoryProfile(GROUP);
  assert.deepEqual(Object.keys(users[UID].relationshipComments), ["50432"]);
  assert.deepEqual(Object.keys(users[PEER].relationshipComments), ["50432"]);
  clearUserMemoryProfile(UID);
  assert.equal(users[UID].profile, ""); assert.deepEqual(users[UID].relationshipComments, {});
  assert.equal(users[PEER].relationshipComments["50432"].text, "PEER_OTHER_COMMENT");
  assert.equal(JSON.stringify(users[UID].chats), before);
});

test("personal read guard keeps the existing private admin command exception but not arbitrary users", t => {
  fixture(t);
  const cfg = { groupWhitelist: [], friendWhitelist: [], botBlacklist: [], adminUins: [Number(UID)] };
  assert.equal(createPersonalReadGuard({ surface: "private", userId: UID, cfg }).stopReason(), "");
  assert.equal(createPersonalReadGuard({ surface: "private", userId: PEER, cfg }).stopReason(), "permission_changed");
});

test("actual group command cannot send late cached prose after privacy changes before the first chunk", async t => {
  fixture(t);
  users[UID].chats = [{ ...historical("70536", start - 100), uid: UID }];
  let sends = 0;
  await dispatchGroupCommand({ isAtMe: true, text: "关系", user_id: UID, group_id: GROUP, message_id: 80536 }, {
    users, callMiMo: async () => "CURRENT_COMMENT", callDeepSeek: () => assert.fail("unused"), recordCommand: () => {},
    sender: async (groupId, reply, replyTo, settings) => {
      clearGroupMemoryProfile(GROUP);
      assert.equal(settings.stopReason(), "privacy_changed");
      const result = await sendMsg(groupId, reply, replyTo, settings);
      if (result?.status === "ok") sends++;
      return result;
    },
  });
  assert.equal(sends, 0);
});

test("relationship command stops later chunks at profile expiry and does not record a complete command", async t => {
  const f = fixture(t);
  users[UID].chats = [{ ...historical("70537", start - 100), uid: UID }];
  memoryProfiles.userGroupProfiles[GROUP + ":" + UID] = { confidence: 0.8, expiresAt: start + 100, recentTopics: ["代码"] };
  let sends = 0, records = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).endsWith("/send_group_msg")); sends++; f.state.now += 100;
    return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 90537 } }) };
  });
  await dispatchGroupCommand({ isAtMe: true, text: "关系", user_id: UID, group_id: GROUP, message_id: 80537 }, {
    users, callMiMo: async () => "CURRENT_COMMENT", callDeepSeek: () => assert.fail("unused"), recordCommand: () => { records++; },
    sender: (groupId, reply, replyTo, settings) => sendMsg(groupId, reply.repeat(15), replyTo, settings),
  });
  assert.equal(sends, 1); assert.equal(records, 0);
});

test("actual private profile command retains its admin exception and stops partial output after expiry", async t => {
  const f = fixture(t);
  const admins = CFG.adminUins; CFG.adminUins = [Number(UID)]; CFG.friendWhitelist = [];
  t.after(() => { CFG.adminUins = admins; });
  memoryProfiles.userProfiles[UID] = { confidence: 0.8, expiresAt: start + 100, commonTopics: ["合成主题".repeat(500)] };
  let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).endsWith("/send_private_msg")); sends++; f.state.now += 100;
    return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 90538 } }) };
  });
  await handlePrivateMessage({ message_type: "private", user_id: UID, message_id: 80538, text: "我的档案", files: [], images: [] });
  assert.equal(sends, 1);
});

test("group personal profile and style recommendation never use the global user inference", t => {
  fixture(t);
  const globalProfile = { confidence: 0.8, expiresAt: start + DAY, commonTopics: ["GLOBAL_PRIVATE_TOPIC"], preferredTone: "gentle" };
  const context = { userProfile: globalProfile, userGroupProfile: null, groupProfile: null };
  const group = buildSelfProfileText(UID, GROUP, { memoryContext: context });
  assert.doesNotMatch(group, /GLOBAL_PRIVATE_TOPIC/);
  assert.doesNotMatch(buildStyleRecommendation(UID, GROUP, { memoryContext: context }), /温柔/);
  assert.match(buildSelfProfileText(UID, "private", { memoryContext: context }), /GLOBAL_PRIVATE_TOPIC/);
  assert.match(buildStyleRecommendation(UID, "private", { memoryContext: context }), /温柔/);
});

test("admin group memory summary does not expose global inferred topics or survive admin revocation", async t => {
  fixture(t);
  const admins = CFG.adminUins; CFG.adminUins = [Number(UID)];
  t.after(() => { CFG.adminUins = admins; delete memoryProfiles.userProfiles[PEER]; delete memoryProfiles.userGroupProfiles[GROUP + ":" + PEER]; });
  memoryProfiles.userProfiles[PEER] = { confidence: 1, expiresAt: start + DAY, commonTopics: ["FOREIGN_GLOBAL_TOPIC"], dislikes: [] };
  memoryProfiles.userGroupProfiles[GROUP + ":" + PEER] = { confidence: 1, expiresAt: start + DAY, recentTopics: ["LOCAL_TOPIC"], interactionStyle: "normal" };
  let reached = 0;
  await dispatchGroupCommand({ isAtMe: true, text: "memory summary " + PEER, user_id: UID, group_id: GROUP, message_id: 80539 }, {
    sender: async (groupId, text, replyTo, settings) => {
      reached++;
      assert.match(text, /LOCAL_TOPIC/); assert.doesNotMatch(text, /FOREIGN_GLOBAL_TOPIC/);
      CFG.adminUins = [];
      assert.equal(settings.stopReason(), "permission_changed");
      return sendMsg(groupId, text, replyTo, settings);
    },
    recordCommand: () => assert.fail("not delivered"),
  });
  assert.equal(reached, 1);
});

for (const command of ["memory clear user " + UID, "memory clear group"]) {
  test(`${command}: explicit profile clear confirms durable cache removal or reports a retryable failure`, t => {
    fixture(t);
    users[UID].profile = "PERSISTED_PROFILE";
    users[UID].relationshipComments = { [GROUP]: { text: "PERSISTED_COMMENT" } };
    memoryProfiles.userGroupProfiles[GROUP + ":" + UID] = { confidence: 1, expiresAt: start + DAY, recentTopics: ["PERSISTED_TOPIC"] };
    const rename = fs.renameSync;
    const failure = t.mock.method(fs, "renameSync", (...args) => {
      if (args[1] === CFG.memoryFile) throw new Error("synthetic profile storage failure");
      return rename(...args);
    });
    const options = { userId: UID, groupId: GROUP, admins: [Number(UID)] };
    assert.match(buildAdminCommandReply(command, options), /落盘未确认/);
    assert.equal(users[UID].relationshipComments[GROUP], undefined);
    failure.mock.restore();
    assert.match(buildAdminCommandReply(command, options), /已清理/);
    const saved = JSON.parse(fs.readFileSync(CFG.memoryFile, "utf8"));
    assert.equal(saved[UID].relationshipComments[GROUP], undefined);
    const profiles = JSON.parse(fs.readFileSync(CFG.memoryProfileFile, "utf8"));
    assert.equal(profiles.userGroupProfiles[GROUP + ":" + UID], undefined);
  });
}
