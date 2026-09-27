import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, mock, test } from "node:test";

// Isolate every singleton before importing production consumers.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-cross-entry-"));
const environment = {
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"),
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const network = mock.method(globalThis, "fetch", () => assert.fail("cross-entry acceptance must not access the network"));

const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { buildLayeredReplyContext } = await import("../bridge/context-retriever.mjs");
const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
const { validateQuotedReply } = await import("../bridge/context/quoted-reply.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { generateProfile } = await import("../bridge/profile.mjs");
const { recentTopicEvidence } = await import("../bridge/memory-profile/evidence.mjs");
const { expandMemorySourceExclusions } = await import("../bridge/memory-profile/source-exclusions.mjs");
const { recordConversationTurn, getConversationThread, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");

const CREATED_AT = 1800000000000;
const UID = "68101";
const PEER = "68102";
const GROUP = "58101";
const SOURCE_ID = "78101";
const CHILD_ID = "78102";
const CONTROL_ID = "78103";
const OLD = /OBSOLETE_NOTE_BODY|OBSOLETE_DERIVED_BODY/;
const CONTINUE = "\u7ee7\u7eed";
const changes = ["correction", "deletion", "expiry"];

after(() => {
  try {
    assert.equal(network.mock.callCount(), 0, "no model, bot or QQ requests are permitted");
  } finally {
    mock.restoreAll();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(t, groupId = GROUP) {
  const scope = { userId: UID, groupId };
  const state = { now: CREATED_AT, writes: 0, invalidations: 0 };
  const profiles = {};
  const service = createMemoryNoteService({
    profiles, available: () => true, now: () => state.now,
    persist: () => { state.writes++; return true; },
    invalidate: () => { state.invalidations++; },
    readPrivacy: () => ({ epoch: 0, users: {} }),
  });
  // Keep production read paths intact, replacing only their backing store and clock.
  t.mock.method(memoryNoteService, "snapshot", service.snapshot);
  t.mock.method(memoryNoteService, "corrections", service.corrections);
  t.mock.method(memoryNoteService, "metadata", service.metadata);
  t.mock.method(Date, "now", () => state.now);
  const cfg = { selfUin: 98101, groupWhitelist: [Number(GROUP)], friendWhitelist: [Number(UID)],
    botBlacklist: [], adminUins: [], botNames: ["SyntheticBot"] };
  const previousCfg = Object.fromEntries(Object.keys(cfg).map(key => [key, CFG[key]]));
  Object.assign(CFG, cfg);
  users[UID] = { uid: UID, nicknames: ["SyntheticOwner"], chats: [] };
  users[PEER] = { uid: PEER, nicknames: ["SyntheticPeer"], chats: [] };
  groupChats[GROUP] = [];
  t.after(() => {
    Object.assign(CFG, previousCfg);
    delete users[UID]; delete users[PEER]; delete groupChats[GROUP];
    resetCognitionForTest();
  });
  const act = (payload, messageId) => service.act({ ...scope, revision: service.snapshot(scope).revision, ...payload },
    { origin: "user_command", messageId });
  const note = act({ action: "create", title: "Project", text: "Project OBSOLETE_NOTE_BODY", ttlDays: 1 }, SOURCE_ID).items[0];
  act({ action: "create", title: "Project control", text: "Project UNAFFECTED_NOTE", ttlDays: 90 }, "78104");
  // Cross the note's TTL while histories and newly derived threads remain alive.
  state.now = note.expiresAt - 1000;
  const options = { uid: UID, groupId, mode: groupId === "private" ? "private" : "group-at",
    userName: "SyntheticOwner", userMsg: "Project", currentMessageId: "78999" };
  const packet = extra => buildReplyContextPacket({ ...options, ...extra });
  const recall = (kind = "both") => recallMemory({ surface: groupId === "private" ? "private" : "group",
    ...scope, currentMessageId: options.currentMessageId }, { query: "Project", kind, limit: 6 });
  function change(kind) {
    state.now++;
    if (kind === "correction") act({ action: "update", id: note.id, text: "Project CURRENT_NOTE_BODY" }, "78105");
    else if (kind === "deletion") act({ action: "remove", id: note.id }, "78106");
    else state.now = note.expiresAt + 1;
    const current = service.snapshot(scope).items.find(item => item.id === note.id);
    if (kind === "correction") {
      assert.equal(current.revision, 2);
      assert.equal(current.text, "Project CURRENT_NOTE_BODY");
    } else if (kind === "deletion") assert.equal(current, undefined);
    else assert.equal(current.state, "expired");
  }
  return { scope, state, profiles, service, note, options, packet, recall, change };
}

function chat(f, messageId, text, extra = {}) {
  return { uid: UID, group: f.scope.groupId, nickname: "SyntheticOwner", role: "member",
    messageId, text, ts: f.state.now - 100, textChars: text.length, textTruncated: false, ...extra };
}

function seedHistory(f, { group = false } = {}) {
  // Legacy source archives may lack memoryCommand; identity must still retract them.
  const rows = [
    chat(f, SOURCE_ID, f.note.text, { ts: f.note.source.at }),
    chat(f, CHILD_ID, "Project OBSOLETE_DERIVED_BODY", { replyToMessageId: SOURCE_ID }),
    chat(f, CONTROL_ID, "Project UNAFFECTED_HISTORY"),
  ];
  if (group) groupChats[GROUP] = rows;
  else users[UID].chats = rows;
}

function assertCurrentOnly(value, f, change) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, OLD, `${change}: obsolete source or derived content reached the consumer`);
  assert.match(serialized, /UNAFFECTED_NOTE/, "an unrelated active note must remain readable");
  if (change === "correction") {
    assert.match(serialized, /CURRENT_NOTE_BODY/);
    assert.ok(value.memorySources.some(source => source.noteId === f.note.id && source.revision === 2));
  } else assert.ok(value.memorySources.every(source => source.noteId !== f.note.id));
  assert.ok(value.memorySources.every(source => source.noteId !== f.note.id || source.revision !== 1));
}

function interjectionQuote(f) {
  const ctx = { message_type: "group", group_id: GROUP, user_id: PEER,
    message_id: "78999", replyData: { id: SOURCE_ID } };
  const reply = { text: f.note.text, images: [], source: { messageType: "group", groupId: GROUP,
    userId: UID, messageId: SOURCE_ID, time: f.note.source.at / 1000 } };
  const evidence = validateQuotedReply(ctx, reply);
  return { evidence, packet: f.packet({ uid: PEER, mode: "interjection", userMsg: "Project?",
    replyToMessageId: SOURCE_ID, replyText: evidence.state === "verified" ? reply.text : "",
    replyUserId: evidence.userId, replySpeaker: "SyntheticOwner", quoteEvidence: evidence }) };
}

for (const change of changes) {
  test(`${change}: ordinary group context excludes old notes and personal source history`, t => {
    const f = fixture(t);
    seedHistory(f);
    const before = f.packet();
    assert.match(JSON.stringify(before.messages), /OBSOLETE_NOTE_BODY/);
    assert.ok(before.retrieval.sources.some(source => source.kind === "memory" && source.messageId === SOURCE_ID));
    f.change(change);
    const afterPacket = f.packet();
    assertCurrentOnly(afterPacket, f, change);
    assert.match(JSON.stringify(afterPacket.messages), /UNAFFECTED_HISTORY/);
    assert.ok(afterPacket.retrieval.sources.every(source => ![SOURCE_ID, CHILD_ID].includes(source.messageId)));
  });

  test(`${change}: another speaker's ordinary group background excludes source-dependent replies`, t => {
    const f = fixture(t);
    seedHistory(f, { group: true });
    const read = () => f.packet({ uid: PEER });
    const before = read();
    assert.match(JSON.stringify(before.messages), /OBSOLETE_DERIVED_BODY/);
    assert.ok(before.retrieval.sources.some(source => source.kind === "group" && source.messageId === CHILD_ID));
    f.change(change);
    const result = read();
    assert.doesNotMatch(JSON.stringify(result.messages), OLD);
    assert.match(JSON.stringify(result.messages), /UNAFFECTED_HISTORY/);
    assert.ok(result.retrieval.sources.every(source => source.messageId !== CHILD_ID));
  });

  test(`${change}: private context uses only current explicit notes`, t => {
    const f = fixture(t, "private");
    assert.match(JSON.stringify(f.packet().messages), /OBSOLETE_NOTE_BODY/);
    f.change(change);
    assertCurrentOnly(f.packet(), f, change);
    assert.deepEqual(users[UID].chats, [], "private history must not be persisted by these reads");
  });

  test(`${change}: interjection quote validation cannot restore an old explicit source`, t => {
    const f = fixture(t);
    const before = interjectionQuote(f);
    assert.equal(before.evidence.state, "verified");
    assert.match(JSON.stringify(before.packet.messages), /OBSOLETE_NOTE_BODY/);
    assert.equal(before.packet.metadata.hasQuotedMessage, true);
    f.change(change);
    const result = interjectionQuote(f);
    assert.doesNotMatch(JSON.stringify(result.packet.messages), OLD);
    assert.equal(result.evidence.state, "unavailable");
    assert.equal(result.packet.metadata.hasQuotedMessage, false);
    assert.ok(result.packet.retrieval.sources.every(source => source.messageId !== SOURCE_ID));
  });

  test(`${change}: interjection background excludes recent replies to the old source`, t => {
    const f = fixture(t);
    seedHistory(f, { group: true });
    const read = () => f.packet({ uid: PEER, mode: "interjection" });
    assert.match(JSON.stringify(read().messages), /OBSOLETE_DERIVED_BODY/);
    f.change(change);
    const result = read();
    assert.doesNotMatch(JSON.stringify(result.messages), OLD);
    assert.match(JSON.stringify(result.messages), /UNAFFECTED_HISTORY/);
    assert.ok(result.retrieval.sources.every(source => source.messageId !== CHILD_ID));
  });

  for (const groupId of [GROUP, "private"]) {
    const surface = groupId === "private" ? "private" : "group";
    test(`${change}: ${surface} recall_memory excludes old notes and dependent history`, t => {
      const f = fixture(t, groupId);
      if (surface === "group") seedHistory(f);
      const before = f.recall();
      assert.equal(before.status, "ok");
      assert.match(JSON.stringify(before), /OBSOLETE_NOTE_BODY/);
      assert.ok(before.memorySources.some(source => source.noteId === f.note.id && source.revision === 1));
      f.change(change);
      const storeBeforeRead = JSON.stringify(f.profiles);
      for (const kind of ["both", "notes"]) {
        const result = f.recall(kind);
        assert.equal(result.status, "ok");
        assertCurrentOnly(result, f, change);
      }
      const history = f.recall("history");
      assert.doesNotMatch(JSON.stringify(history), OLD);
      assert.deepEqual(history.memorySources, []);
      if (surface === "group") {
        assert.equal(history.status, "ok");
        assert.deepEqual(history.items.map(item => item.source.messageId), [CONTROL_ID]);
      } else {
        assert.equal(history.status, "empty");
        assert.deepEqual(history.items, []);
      }
      assert.equal(JSON.stringify(f.profiles), storeBeforeRead, "recall must not mutate the synthetic store");
    });

    test(`${change}: ${surface} thread-derived memory dependencies invalidate later turns`, t => {
      const f = fixture(t, groupId);
      const initial = f.packet();
      assert.ok(initial.memorySources.some(source => source.noteId === f.note.id && source.revision === 1));
      const record = (messageId, memorySources, assistantText) => recordConversationTurn({ uid: UID, groupId,
        messageId, userText: CONTINUE, assistantText, memorySources, now: f.state.now }, { save: false });
      record("78201", initial.memorySources, "Project OBSOLETE_DERIVED_BODY first turn");
      const layered = buildLayeredReplyContext({ ...f.options, userMsg: CONTINUE });
      const threadLayers = layered.history.filter(layer => layer.contextSources?.some(source => source.kind === "thread"));
      assert.equal(threadLayers.length, 1);
      // Exercise the real budget/dependency path with no direct note layer left.
      const derived = enforceContextBudget(threadLayers, layered.currentInput);
      assert.ok(derived.sources.every(source => source.kind === "thread"));
      assert.deepEqual(derived.memorySources, initial.memorySources);
      const recorded = record("78202", derived.memorySources, "Project OBSOLETE_DERIVED_BODY second turn");
      assert.deepEqual(recorded.turns.at(-1).memorySources, derived.memorySources);
      assert.equal(recorded.turns.at(-1).memoryDependencyVersion, 2);
      const before = f.packet({ userMsg: CONTINUE });
      assert.match(JSON.stringify(before.messages), /OBSOLETE_DERIVED_BODY second turn/);
      assert.ok(before.retrieval.sources.some(source => source.kind === "thread" && source.messageId === "78202"));
      f.change(change);
      const liveThread = getConversationThread(UID, groupId);
      assert.equal(liveThread.turnCount, 2, "note expiry must not be confused with thread TTL expiry");
      assert.ok(liveThread.expiresAt > f.state.now);
      const result = f.packet({ userMsg: CONTINUE });
      assert.doesNotMatch(JSON.stringify(result.messages), OLD);
      assert.ok(result.retrieval.sources.every(source => !["78201", "78202"].includes(source.messageId)));
      assert.ok(result.memorySources.every(source => source.noteId !== f.note.id || source.revision === 2));
      if (change === "correction") assert.match(JSON.stringify(result.messages), /CURRENT_NOTE_BODY/);
      else assert.ok(result.memorySources.every(source => source.noteId !== f.note.id));
    });
  }
}

test("source exclusion follows explicit multi-hop replies and stops at cycles", () => {
  const rows = [
    { messageId: "3", replyToMessageId: "2" }, { messageId: "2", replyToMessageId: "1" },
    { messageId: "4", turnId: "3" }, { messageId: "2", replyToMessageId: "4" },
    { messageId: "5", text: "same words are not a dependency" },
  ];
  const original = new Set(["1"]);
  assert.deepEqual([...expandMemorySourceExclusions(rows, original)].sort(), ["1", "2", "3", "4"]);
  assert.deepEqual([...original], ["1"]);
});

test("discarding a corrected turn also removes its stale topic while preserving independent turns", t => {
  const f = fixture(t);
  recordConversationTurn({ uid: UID, groupId: GROUP, messageId: "78211", userText: "继续", assistantText: "UNAFFECTED_ANSWER",
    memorySources: [], now: f.state.now - 10 }, { save: false });
  recordConversationTurn({ uid: UID, groupId: GROUP, messageId: SOURCE_ID, userText: "继续 OBSOLETE_NOTE_BODY", assistantText: "OBSOLETE_DERIVED_BODY",
    memorySources: [], now: f.state.now - 5 }, { save: false });
  users[UID].cognition.threads[GROUP].topic = "OBSOLETE_NOTE_BODY";
  f.change("correction");
  const result = f.packet({ userMsg: CONTINUE });
  assert.doesNotMatch(JSON.stringify(result.messages), OLD);
  assert.match(JSON.stringify(result.messages), /UNAFFECTED_ANSWER/);
  assert.equal(result.thread.topic, "");
});

for (const change of changes) {
  test(`${change}: topic hints and a newly started profile cannot reintroduce old linked sources`, async t => {
    const f = fixture(t);
    seedHistory(f);
    users[UID].chats[0].text += " lint";
    users[UID].chats[1].text += " lint";
    assert.ok(recentTopicEvidence(UID, GROUP).length);
    f.change(change);
    assert.deepEqual(recentTopicEvidence(UID, GROUP), []);
    let calls = 0;
    const output = await generateProfile(UID, { generate: async prompt => {
      calls++;
      assert.doesNotMatch(prompt, OLD);
      assert.match(prompt, /UNAFFECTED_HISTORY/);
      return "current clean profile";
    } });
    assert.equal(output, "current clean profile");
    assert.equal(calls, 1);
  });
}

test("expiry pruning and creation preserve source exclusions instead of reviving old archive rows", t => {
  const f = fixture(t);
  seedHistory(f);
  f.change("expiry");
  f.service.prune(f.state.now + 8 * 86400000);
  assert.equal(f.service.snapshot(f.scope).items.some(item => item.id === f.note.id), false);
  assert.ok(f.service.corrections(f.scope).excludedMessageIds.has(SOURCE_ID));
  assert.ok(f.service.corrections(f.scope).excludedMessageIds.has(CHILD_ID));
  f.service.act({ ...f.scope, revision: f.service.snapshot(f.scope).revision, action: "create", title: "fresh", text: "fresh only" });
  assert.ok(f.service.corrections(f.scope).excludedMessageIds.has(SOURCE_ID));
});
