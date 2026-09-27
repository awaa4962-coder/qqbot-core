import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after, afterEach, beforeEach } from "node:test";

// Isolate before dynamic imports: notes transitively loads persisted profiles/chats.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-relationship-notes-"));
const environment = {
  NODE_ENV: "test",
  QQBOT_CONFIG_ROOT: path.join(sandbox, "config"),
  QQBOT_DATA_DIR: path.join(sandbox, "data"),
  QQBOT_LOG_DIR: path.join(sandbox, "logs"),
  QQBOT_TEMP_DIR: path.join(sandbox, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(sandbox, "data", "profiles.json"),
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats, logGroupMsg, flushSavesSync } = await import("../bridge/storage.mjs");
const { memoryProfiles, createRoot, saveMemoryProfiles, flushMemoryProfilesSync } = await import("../bridge/memory-profile/store.mjs");
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { getActiveMemoryContext } = await import("../bridge/memory-profile/query.mjs");
const { observeMemoryEvent } = await import("../bridge/memory-profile/updates.mjs");
const { computeRelationship, scopeRelationshipUser, RELATIONSHIP_SCORE_FIELDS } = await import("../bridge/relationship.mjs");
const { buildRelationshipCommandReply, buildRelationshipCommandReplyAsync } = await import("../bridge/commands/modules/relationship.mjs");
const { buildMemoryCommandReplyAsync } = await import("../bridge/commands/modules/memory.mjs");

const NOW = Date.UTC(2026, 8, 20, 12);
const DAY = 86400000;
const UID = "60108";
const OTHER_UID = "60109";
const GROUP = "50108";
const OTHER_GROUP = "50109";
const SCOPES = [GROUP, OTHER_GROUP, "private"].map(groupId => ({ userId: UID, groupId }));
const SCORE_AND_EVIDENCE = [...RELATIONSHIP_SCORE_FIELDS, "groupFamiliarity", "confidence",
  "messageCount", "groupMessageCount", "activeDays", "groupActiveDays", "evidenceCount"];
const RECORDS = [
  { recordType: "fact", status: "recorded", transitions: [] },
  { recordType: "event", status: "recorded", eventAt: NOW - 400 * DAY, transitions: [] },
  { recordType: "todo", status: "pending", transitions: ["in_progress", "done", "pending", "cancelled"] },
  { recordType: "current_state", status: "current", transitions: ["ended", "current"] },
];
let service;
let messageId;
let fetchGuard;

beforeEach(t => {
  t.mock.method(Date, "now", () => NOW);
  fetchGuard = t.mock.method(globalThis, "fetch", () => assert.fail("P3-08 must not access the network"));
  reset(users, {});
  reset(groupChats, {});
  reset(memoryProfiles, createRoot());
  messageId = 710800;
  service = createMemoryNoteService({
    profiles: memoryProfiles,
    now: () => NOW,
    persist: () => saveMemoryProfiles() && flushMemoryProfilesSync(),
  });
});

afterEach(() => {
  flushSavesSync();
  assert.equal(flushMemoryProfilesSync(), true);
  assert.equal(fetchGuard.mock.callCount(), 0, "even swallowed network attempts are forbidden");
});

after(() => {
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(sandbox).startsWith("qqfriend-relationship-notes-"));
  fs.rmSync(sandbox, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function reset(target, value) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, value);
}

function seedInteractions() {
  users[UID] = {
    uid: UID, nicknames: ["GlobalAlias", "GroupAlias", "OtherAlias", "PrivateAlias"],
    firstSeen: NOW - 80 * DAY,
    chats: [
      { group: GROUP, nickname: "GroupAlias", text: "npm error", ts: NOW - 2 * DAY, messageId: "70101" },
      { group: GROUP, nickname: "GroupAlias", text: "node bug", ts: NOW - DAY, messageId: "70102" },
      { group: GROUP, nickname: "GroupAlias", text: "git test", ts: NOW, messageId: "70103" },
      { group: OTHER_GROUP, nickname: "OtherAlias", text: "6", ts: NOW - 30 * DAY, messageId: "70104" },
      { group: "private", nickname: "PrivateAlias", text: "hello there", ts: NOW - 3 * DAY, messageId: "70105" },
    ],
  };
  users[OTHER_UID] = { uid: OTHER_UID, chats: [], nicknames: [] };
  memoryProfiles.userProfiles[UID] = {
    nicknames: ["GlobalAlias"], dislikes: [],
    commonTopics: ["GLOBAL_TOPIC"], replyStyle: "GLOBAL_STYLE", preferredTone: "serious",
    confidence: 0.8, evidenceCount: 9, expiresAt: NOW + 30 * DAY,
  };
  for (const { groupId } of SCOPES) {
    memoryProfiles.groupProfiles[groupId] = {
      activeTopics: ["TOPIC_" + groupId], tone: "normal", expiresAt: NOW + 30 * DAY,
    };
    memoryProfiles.userGroupProfiles[groupId + ":" + UID] = {
      recentTopics: ["USER_TOPIC_" + groupId], interactionStyle: "normal",
      confidence: 0.4, evidenceCount: 5, expiresAt: NOW + 30 * DAY,
    };
  }
}

function contextFor(scope) {
  return getActiveMemoryContext(scope.userId, scope.groupId, { now: NOW, groupOnly: scope.groupId !== "private" });
}

function scopedRelation(scope) {
  return computeRelationship(scopeRelationshipUser(users[scope.userId], scope.groupId), {
    currentGroupId: scope.groupId, memoryContext: contextFor(scope), now: NOW,
  });
}

function commandOptions(groupId, extra = {}) {
  return { userId: UID, groupId, users, now: NOW, ...extra };
}

function relationshipState() {
  return globalThis.structuredClone({
    users, groupChats,
    legacyProfiles: Object.fromEntries(["userProfiles", "groupProfiles", "userGroupProfiles"].map(key => [key, memoryProfiles[key]])),
    allChats: computeRelationship(users[UID], { now: NOW }),
    scopes: SCOPES.map(scope => ({
      context: contextFor(scope), relation: scopedRelation(scope),
      command: buildRelationshipCommandReply("/my-status", commandOptions(scope.groupId)),
    })),
  });
}

function act(scope, payload, origin = "operator") {
  return service.act({ ...scope, revision: service.snapshot(scope).revision, ...payload },
    { origin, messageId: String(++messageId) });
}

function createNote(scope, definition, origin = "operator") {
  const fields = { ...definition };
  delete fields.transitions;
  return act(scope, {
    action: "create", title: definition.recordType, text: "npm error bug 6 repeated interaction claim",
    ...fields,
  }, origin).items.find(item => item.title === definition.recordType);
}

function metrics(relation) {
  return Object.fromEntries(SCORE_AND_EVIDENCE.map(key => [key, relation[key]]));
}

test("P3-08: every imported mutable store is rooted in the synthetic sandbox", () => {
  for (const filename of [CFG.configRoot, CFG.dataRoot, CFG.logDir, CFG.memoryFile, CFG.chatLogFile, CFG.memoryProfileFile]) {
    const relative = path.relative(sandbox, filename);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), filename);
  }
  assert.deepEqual(users, {});
  assert.deepEqual(groupChats, {});
  assert.deepEqual(memoryProfiles, createRoot());
});

for (const origin of ["operator", "user_command"]) {
  for (const definition of RECORDS) {
    test(`P3-08: ${origin} ${definition.recordType} CRUD/transitions leave all relationship inputs and results unchanged`, () => {
      seedInteractions();
      const baseline = relationshipState();
      for (const scope of SCOPES) {
        let item = createNote(scope, definition, origin);
        assert.equal(item.recordType, definition.recordType);
        assert.equal(item.status, definition.status);
        assert.equal(item.kind, origin === "user_command" ? "user_statement" : "operator_note");
        assert.deepEqual(relationshipState(), baseline, "create " + scope.groupId);

        item = act(scope, { action: "update", id: item.id, text: "git node config 6 changed claim",
          ...(definition.recordType === "event" ? { eventAt: NOW - DAY } : {}) }, origin).items[0];
        assert.equal(item.revision, 2);
        assert.equal(item.text, "git node config 6 changed claim");
        if (definition.recordType === "event") assert.equal(item.eventAt, NOW - DAY);
        assert.deepEqual(relationshipState(), baseline, "update " + scope.groupId);

        for (const status of definition.transitions) {
          item = act(scope, { action: "transition", id: item.id, status }, origin).items[0];
          assert.equal(item.status, status);
          assert.deepEqual(relationshipState(), baseline, "transition " + status);
        }
        assert.equal(act(scope, { action: "remove", id: item.id }, origin).items.length, 0);
        assert.deepEqual(relationshipState(), baseline, "remove " + scope.groupId);
      }
    });
  }
}

test("P3-08: notes alone do not create a user, chat, active day, or relationship evidence", () => {
  const baseline = relationshipState();
  for (const scope of SCOPES) {
    for (const definition of RECORDS) createNote(scope, definition, "user_command");
    assert.equal(service.snapshot(scope).items.length, RECORDS.length);
    const relation = scopedRelation(scope);
    for (const key of ["messageCount", "groupMessageCount", "activeDays", "evidenceCount", "interactionScore"]) {
      assert.equal(relation[key], 0, key);
    }
    assert.deepEqual(relationshipState(), baseline);
  }
});

test("P3-08: note reads and writes stay within user/group/private scope", () => {
  seedInteractions();
  const baseline = relationshipState();
  const scopes = [...SCOPES, { userId: OTHER_UID, groupId: GROUP }];
  const entries = scopes.map(scope => createNote(scope, RECORDS[2], "user_command"));
  for (const [index, scope] of scopes.entries()) {
    const own = service.snapshot(scope);
    assert.deepEqual(own.items.map(item => item.id), [entries[index].id]);
    for (const foreign of entries.filter(item => item.id !== entries[index].id)) {
      for (const payload of [
        { action: "update", text: "foreign edit" }, { action: "remove" }, { action: "transition", status: "done" },
      ]) {
        assert.throws(() => act(scope, { ...payload, id: foreign.id }), error => error.statusCode === 404);
        assert.deepEqual(service.snapshot(scope), own);
      }
    }
  }
  assert.deepEqual(relationshipState(), baseline);
});

test("P3-08: legitimate legacy chats and observed interactions still contribute normally", () => {
  seedInteractions();
  users[UID] = { uid: UID, ...scopeRelationshipUser(users[UID], GROUP) };
  reset(memoryProfiles, createRoot());
  const before = scopedRelation(SCOPES[0]);
  assert.deepEqual(metrics(before), {
    familiarity: 24, affinity: 19, trustScore: 5, humorTolerance: 30, interactionScore: 27, styleMatch: 58,
    groupFamiliarity: 30, confidence: 0.01, messageCount: 3, groupMessageCount: 3,
    activeDays: 3, groupActiveDays: 3, evidenceCount: 10,
  });
  logGroupMsg(GROUP, "GroupAlias", "npm error fixed", UID, "member", null, { messageId: "70201" });
  for (let i = 0; i < 3; i++) observeMemoryEvent({ uid: UID, groupId: GROUP, nickname: "GroupAlias", text: "npm error fixed" }, { now: NOW });
  const afterInteraction = scopedRelation(SCOPES[0]);
  assert.equal(afterInteraction.messageCount, 4);
  assert.ok(afterInteraction.familiarity > before.familiarity);
  assert.ok(afterInteraction.interactionScore > before.interactionScore);
  assert.ok(afterInteraction.confidence > before.confidence);
  assert.ok(memoryProfiles.userGroupProfiles[GROUP + ":" + UID].evidenceCount > 0);
  const baseline = relationshipState();
  const item = createNote(SCOPES[0], RECORDS[0]);
  act(SCOPES[0], { action: "remove", id: item.id });
  assert.deepEqual(relationshipState(), baseline);
});

test("P3-08: scoped computation and group command exclude foreign chats, aliases and global profiles", () => {
  seedInteractions();
  const scope = SCOPES[0];
  const before = scopedRelation(scope);
  const reply = buildRelationshipCommandReply("/my-status", commandOptions(GROUP));
  assert.equal(before.messageCount, 3);
  assert.equal(before.firstSeenAt, new Date(NOW - 2 * DAY).toISOString());
  assert.doesNotMatch(reply, /GLOBAL_|OtherAlias|PrivateAlias|TOPIC_private|TOPIC_50109/);
  for (const foreign of SCOPES.slice(1)) {
    logGroupMsg(foreign.groupId, "FOREIGN_ALIAS", "6 npm error", UID, "member", null, { messageId: String(++messageId) });
    observeMemoryEvent({ uid: UID, groupId: foreign.groupId, nickname: "FOREIGN_ALIAS", text: "6 npm error" }, { now: NOW });
  }
  assert.deepEqual(scopedRelation(scope), before);
  assert.equal(buildRelationshipCommandReply("/my-status", commandOptions(GROUP)), reply);
  assert.equal(scopeRelationshipUser(users[UID], "50110"), null);
  for (const current of SCOPES) {
    assert.ok(scopeRelationshipUser(users[UID], current.groupId).chats.every(chat => chat.group === current.groupId));
  }
});

test("P3-08: async relationship comments and their cache do not refresh from note-only edits", async () => {
  seedInteractions();
  const calls = [];
  for (const scope of SCOPES) {
    const options = commandOptions(scope.groupId, {
      callMiMo: async prompt => { calls.push({ groupId: scope.groupId, prompt }); return "Synthetic local comment"; },
      callDeepSeek: async () => assert.fail("local primary stub must satisfy the comment"),
    });
    const before = await buildRelationshipCommandReplyAsync("/my-status", options);
    const cache = globalThis.structuredClone(users[UID].relationshipComments[scope.groupId]);
    const item = createNote(scope, RECORDS[2]);
    act(scope, { action: "update", id: item.id, text: "NOTE_ONLY_SENTINEL npm 6" });
    act(scope, { action: "transition", id: item.id, status: "done" });
    assert.equal(await buildRelationshipCommandReplyAsync("/my-status", options), before);
    act(scope, { action: "remove", id: item.id });
    assert.equal(await buildRelationshipCommandReplyAsync("/my-status", options), before);
    assert.deepEqual(users[UID].relationshipComments[scope.groupId], cache);
  }
  assert.equal(calls.length, SCOPES.length);
  assert.doesNotMatch(JSON.stringify(calls), /NOTE_ONLY_SENTINEL/);
});

// Preserve the existing self-query scope; note edits must not redefine the scoring contract.
for (const groupId of ["private", undefined]) {
  for (const asynchronous of [false, true]) {
    test(`P3-08: ${asynchronous ? "async" : "sync"} private self command (${String(groupId)}) keeps its existing aggregate after note edits`, async () => {
      seedInteractions();
      const build = asynchronous ? buildRelationshipCommandReplyAsync : buildRelationshipCommandReply;
      const options = commandOptions(groupId, {
        memoryContext: {}, callMiMo: async () => "Synthetic local comment", callDeepSeek: async () => "",
      });
      const expected = await build("/my-status", options);
      const item = createNote({ userId: UID, groupId: "private" }, RECORDS[0]);
      act({ userId: UID, groupId: "private" }, { action: "update", id: item.id, text: "PRIVATE_NOTE_NOT_SCORE_INPUT" });
      const actual = await build("/my-status", options);
      assert.equal(actual, expected, "private self-query scoring and source scope remain unchanged");
      assert.doesNotMatch(actual, /PRIVATE_NOTE_NOT_SCORE_INPUT/);
      assert.match(actual, /GlobalAlias/);
    });
  }
}

test("P3-08: saving a logged explicit-memory command adds no second interaction or type-based points", async () => {
  seedInteractions();
  const scope = SCOPES[0];
  const before = metrics(scopedRelation(scope));
  const text = "\u8bb0\u4e8b \u4e8b\u5b9e tool = npm error 6";
  // These are the real storage/observation calls made before dispatch in reply-group.mjs.
  logGroupMsg(GROUP, "GroupAlias", text, UID, "member", null, { messageId: "70301", memoryCommand: true });
  observeMemoryEvent({ uid: UID, groupId: GROUP, nickname: "GroupAlias", text }, { now: NOW });
  const afterIngress = metrics(scopedRelation(scope));
  assert.equal(afterIngress.messageCount, before.messageCount + 1, "the received message follows the existing message-count rule");
  await buildMemoryCommandReplyAsync(text, {
    userId: UID, groupId: GROUP, surface: "group", messageId: "70301", noteService: service,
    cfg: { selfUin: 999, groupWhitelist: [Number(GROUP)], friendWhitelist: [], botBlacklist: [] },
  });
  assert.equal(service.snapshot(scope).items.length, 1, "the real memory command saved a note");
  assert.equal(users[UID].chats.at(-1).memoryCommand, true);
  assert.deepEqual(metrics(scopedRelation(scope)), afterIngress,
    "persisting the explicit note must not add a second interaction or any type-based score");
});
