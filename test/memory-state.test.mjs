import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-state-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { buildNoteSemantics, projectNoteSemantics, MEMORY_SEMANTIC_BOUNDARY } = await import("../bridge/memory-profile/semantics.mjs");
const { memoryEvidenceLayers } = await import("../bridge/memory-profile/evidence.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { validateQuotedReply } = await import("../bridge/context/quoted-reply.mjs");
const { recordConversationTurn } = await import("../bridge/cognition/index.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { users } = await import("../bridge/storage.mjs");
const { memoryProfiles } = await import("../bridge/memory-profile/store.mjs");
const { enforceContextBudget } = await import("../bridge/context/budget.mjs");
const { normalizeMemoryDependencies } = await import("../bridge/context/memory-dependencies.mjs");
const { generateProfile } = await import("../bridge/profile.mjs");
const scope = { userId: "60110", groupId: "50110" };
const time = 1790144000000;
const DAY = 86400000;

function fixture() {
  const profiles = { userProfiles: { legacy: { score: 21 } } };
  const state = { now: time, writable: true, writes: 0, invalidations: 0 };
  const service = createMemoryNoteService({ profiles, now: () => state.now, available: () => true,
    readPrivacy: () => ({ users: {} }), persist: () => { state.writes++; return state.writable; }, invalidate: () => state.invalidations++ });
  const act = (payload = {}, context = {}) => service.act({ ...scope, revision: service.snapshot(scope).revision,
    action: "create", title: "项目", text: "整理接口说明", ...payload }, { origin: "user_command", messageId: 70110, ...context });
  const transition = (id, status, extra = {}) => service.act({ ...scope, revision: service.snapshot(scope).revision,
    action: "transition", id, status, ...extra }, { origin: "user_command", messageId: 70111 });
  return { profiles, state, service, act, transition };
}

test("record semantics are independent of origin and never migrate a legacy note into a guessed fact", () => {
  const f = fixture();
  const item = f.act().items[0];
  for (const key of ["recordType", "status", "eventAt"]) delete f.profiles.notes.items[0][key];
  assert.deepEqual(projectNoteSemantics(f.service.snapshot(scope).items[0]), { recordType: "unclassified", status: "recorded", eventAt: null });
  assert.equal(f.profiles.notes.items[0].recordType, undefined);
  f.state.now++;
  const updated = f.act({ action: "update", id: item.id, text: "完成过一次检查", recordType: "event" }, { origin: "operator" }).items[0];
  assert.equal(updated.kind, "operator_note"); assert.equal(updated.recordType, "event"); assert.equal(updated.eventAt, null);
  assert.deepEqual(f.profiles.userProfiles, { legacy: { score: 21 } });
});

for (const [recordType, status] of [["unclassified", "recorded"], ["fact", "recorded"], ["event", "recorded"], ["todo", "pending"], ["current_state", "current"]]) {
  test("new " + recordType + " has only its explicit default status and unknown event time", () => {
    const f = fixture(); const item = f.act({ recordType }).items[0];
    assert.equal(item.recordType, recordType); assert.equal(item.status, status); assert.equal(item.eventAt, null);
    assert.equal(item.kind, "user_statement"); assert.equal(item.source.messageId, "70110");
    assert.equal(item.expiresAt, time + 30 * DAY);
  });
}

test("events distinguish occurrence from statement time and reject future or malformed dates", () => {
  const f = fixture(); const item = f.act({ recordType: "event", eventAt: time - DAY }).items[0];
  assert.equal(item.eventAt, time - DAY); assert.equal(item.source.at, time);
  for (const eventAt of [time + 1, 0, "yesterday", NaN, {}, 253402272000000]) {
    assert.throws(() => f.act({ title: "other", recordType: "event", eventAt }));
  }
  assert.throws(() => f.act({ title: "other", recordType: "fact", eventAt: time }));
  assert.equal(f.service.snapshot(scope).items.length, 1);
});

test("todo transitions are explicit revisions without text edits, renewed expiry or execution claims", () => {
  const f = fixture(); let item = f.act({ recordType: "todo", ttlDays: 2 }).items[0];
  const id = item.id; const expires = item.expiresAt;
  for (const status of ["in_progress", "done", "pending", "cancelled"]) {
    f.state.now++;
    item = f.transition(id, status).items[0];
    assert.equal(item.status, status); assert.equal(item.text, "整理接口说明"); assert.equal(item.expiresAt, expires);
  }
  assert.equal(item.revision, 5); assert.equal(item.source.messageId, "70111");
  assert.ok(f.service.corrections(scope).excludedMessageIds.has("70110"));
  assert.match(MEMORY_SEMANTIC_BOUNDARY, /不是机器人执行回执/);
});

test("current states can end but expiration cannot imply the opposite state or silently reactivate", () => {
  const f = fixture(); const item = f.act({ recordType: "current_state", ttlDays: 1 }).items[0];
  f.state.now++;
  assert.equal(f.transition(item.id, "ended").items[0].status, "ended");
  f.state.now = time + DAY + 1;
  const expired = f.service.snapshot(scope).items[0];
  assert.equal(expired.status, "ended"); assert.equal(expired.state, "expired");
  assert.throws(() => f.transition(item.id, "current"), /过期/);
  const layers = memoryEvidenceLayers(scope.userId, scope.groupId, { query: "当前状态", snapshot: f.service.snapshot, users: {}, readPrivacy: () => ({ users: {} }) });
  assert.ok(layers.layers.every(layer => !layer.contextSources.length));
});

test("invalid lifecycle changes, stale revisions and unknown categories fail without writes", () => {
  const f = fixture(); const fact = f.act({ recordType: "fact" }).items[0];
  assert.throws(() => f.transition(fact.id, "done"), /只有待办/);
  const todo = f.act({ title: "todo", recordType: "todo" }).items.find(item => item.recordType === "todo");
  for (const status of ["current", "ended", "constructor", null, { toString: null }]) assert.throws(() => f.transition(todo.id, status));
  for (const extra of [{ text: "replaced" }, { title: "renamed" }, { ttlDays: 90 }, { recordType: "event" }, { eventAt: null }]) assert.throws(() => f.transition(todo.id, "done", extra));
  assert.throws(() => f.transition(todo.id, "done", { revision: "stale" }), /已变化/);
  assert.throws(() => buildNoteSemantics({ recordType: "model_inference" }, null, time));
  assert.equal(f.state.writes, 2);
});

test("failed status persistence rolls back all values, source retractions and invalidation", () => {
  const f = fixture(); const item = f.act({ recordType: "todo" }).items[0];
  const before = globalThis.structuredClone(f.profiles.notes);
  f.state.writable = false; f.state.now++;
  assert.throws(() => f.transition(item.id, "done"), /未保存/);
  assert.deepEqual(f.profiles.notes, before); assert.equal(f.state.invalidations, 1);
});

test("ordinary corrections keep type/status and changing type requires a matching status", () => {
  const f = fixture(); const item = f.act({ recordType: "todo", status: "done" }).items[0];
  f.state.now++;
  const updated = f.act({ action: "update", id: item.id, title: "新标题", text: "已按要求重新整理" }).items[0];
  assert.equal(updated.recordType, "todo"); assert.equal(updated.status, "done"); assert.equal(updated.id, item.id);
  assert.throws(() => f.act({ action: "update", id: item.id, recordType: "event", status: "done" }), /不匹配/);
  const changed = f.act({ action: "update", id: item.id, recordType: "event" }).items[0];
  assert.equal(changed.status, "recorded"); assert.equal(changed.eventAt, null);
});

test("correction preserves the original expiry unless renewal is explicitly requested", () => {
  const f = fixture(); const item = f.act({ ttlDays: 90 }).items[0];
  f.state.now += DAY;
  assert.equal(f.act({ action: "update", id: item.id, text: "修正内容" }).items[0].expiresAt, item.expiresAt);
  f.state.now = item.expiresAt + 1;
  assert.throws(() => f.act({ action: "update", id: item.id, text: "过期了" }), /过期/);
  assert.equal(f.act({ action: "update", id: item.id, text: "明确重新保存", ttlDays: 2 }).items[0].expiresAt, f.state.now + 2 * DAY);
});

test("selected turn dependencies stay complete beyond diagnostic source limits and only follow selected content", () => {
  const dependencies = Array.from({ length: 32 }, (_, i) => ({ noteId: i.toString(16).padStart(12, "0"), revision: 1 }));
  const layer = { role: "user", content: "accepted complete turn", contextAtomic: true, contextMemorySources: dependencies,
    contextSources: dependencies.map(source => ({ kind: "note", ...source })) };
  const result = enforceContextBudget([layer], "current");
  assert.equal(result.memorySources.length, 32); assert.equal(result.sources.length, 32);
  assert.deepEqual(enforceContextBudget([layer], "current", { maxChars: 10 }).memorySources, []);
  assert.deepEqual(normalizeMemoryDependencies([...dependencies, ...dependencies]), dependencies);
  assert.equal(normalizeMemoryDependencies([...dependencies, { noteId: dependencies[0].noteId, revision: 2 }]), null);
  assert.equal(normalizeMemoryDependencies([...dependencies, { noteId: "abcdefabcdef", revision: 1 }]), null);
  assert.equal(enforceContextBudget([{ ...layer, contextMemorySources: [{ noteId: "bad", revision: 1 }] }], "current").messages.length, 0);
});

test("typed records remain isolated by user/group/private and survive a compatible store reload", () => {
  const f = fixture(); const item = f.act({ recordType: "todo" }).items[0];
  for (const foreign of [{ ...scope, userId: "60111" }, { ...scope, groupId: "50111" }, { ...scope, groupId: "private" }]) {
    assert.equal(f.service.snapshot(foreign).items.length, 0);
    assert.throws(() => f.service.act({ ...foreign, revision: f.service.snapshot(foreign).revision, action: "transition", id: item.id, status: "done" }), /不属于/);
  }
  const restored = createMemoryNoteService({ profiles: JSON.parse(JSON.stringify(f.profiles)), available: () => true, now: () => time, readPrivacy: () => ({ users: {} }) });
  assert.deepEqual(restored.snapshot(scope).items, f.service.snapshot(scope).items);
});

test("prompt and readonly recall expose task state separately from provenance and can find a generic todo question", () => {
  const f = fixture(); f.act({ title: "接口文档", recordType: "todo" });
  const options = { snapshot: f.service.snapshot, corrections: f.service.corrections, users: {}, now: time, readPrivacy: () => ({ users: {} }),
    cfg: { selfUin: 999, groupWhitelist: [50110], friendWhitelist: [], botBlacklist: [] } };
  const layers = memoryEvidenceLayers(scope.userId, scope.groupId, { ...options, query: "我的待办是什么" });
  assert.ok(layers.layers.some(layer => layer.content.includes("事项状态=待办") && layer.content.includes("接口文档")));
  const recalled = recallMemory({ surface: "group", ...scope }, { query: "待办", kind: "notes" }, options);
  assert.equal(recalled.status, "ok"); assert.equal(recalled.items[0].recordType, "todo");
  assert.equal(recalled.items[0].status, "pending"); assert.equal(recalled.items[0].kind, "user_statement");
  assert.equal(recalled.items[0].recordValidity, "active");
  assert.ok(layers.layers.some(layer => layer.content.includes("记录有效性=后端核验未过期")));
  assert.equal(recalled.memorySources[0].revision, 1);
});

test("new memory command heads never reappear as ordinary recalled history", () => {
  const f = fixture();
  const result = recallMemory({ surface: "group", ...scope }, { query: "整理接口", kind: "history" }, {
    snapshot: f.service.snapshot, corrections: f.service.corrections, now: time, readPrivacy: () => ({ users: {} }),
    cfg: { selfUin: 999, botNames: [], groupWhitelist: [50110], friendWhitelist: [], botBlacklist: [] },
    users: { [scope.userId]: { chats: ["记事 待办 整理接口 = 明天做", "事项状态 123abc 已完成 整理接口"].map((text, i) => ({ group: scope.groupId, messageId: 81000 + i, ts: time - 10, text })) } },
  });
  assert.equal(result.items.length, 0);
});

test("quotes reject replaced/deleted sources and unavailable correction state before accepting text or pixels", () => {
  const f = fixture(); const item = f.act({ recordType: "todo" }).items[0];
  const ctx = { message_type: "group", group_id: scope.groupId, user_id: "60200", message_id: 70200, replyData: { id: 70110 } };
  const reply = { text: "old statement", images: ["https://example.com/old.png"], source: { messageType: "group", groupId: scope.groupId, userId: scope.userId, messageId: 70110, time: time / 1000 } };
  const options = { now: time + 100, readPrivacy: () => ({ users: {} }), readCorrections: f.service.corrections };
  assert.equal(validateQuotedReply(ctx, reply, options).state, "verified");
  f.state.now++; f.transition(item.id, "done");
  assert.equal(validateQuotedReply(ctx, reply, options).reason, "quote_superseded");
  f.act({ action: "remove", id: item.id });
  assert.equal(validateQuotedReply(ctx, reply, options).reason, "quote_superseded");
  assert.equal(validateQuotedReply(ctx, reply, { ...options, readCorrections() { throw new Error("unreadable"); } }).reason, "quote_memory_unavailable");
});

test("legacy threads cannot resurrect an operator note after deletion even with no message retraction ID", () => {
  const oldUsers = users[scope.userId]; const oldNotes = memoryProfiles.notes;
  try {
    users[scope.userId] = { uid: scope.userId, chats: [], nicknames: [] };
    const service = createMemoryNoteService({ profiles: memoryProfiles, available: () => true, persist: () => true, readPrivacy: () => ({ users: {} }) });
    const item = service.act({ ...scope, revision: service.snapshot(scope).revision, action: "create", title: "接口", text: "OPERATOR_OLD_CONTEXT" }).items[0];
    recordConversationTurn({ uid: scope.userId, groupId: scope.groupId, messageId: 71001, userText: "接口怎么处理", assistantText: "OPERATOR_OLD_CONTEXT", now: Date.now() - 1 }, { save: false });
    service.act({ ...scope, revision: service.snapshot(scope).revision, action: "remove", id: item.id });
    const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "还是不行" });
    assert.doesNotMatch(JSON.stringify(packet.messages), /OPERATOR_OLD_CONTEXT/); assert.equal(packet.thread, null);
  } finally { if (oldUsers) users[scope.userId] = oldUsers; else delete users[scope.userId];
    if (oldNotes === undefined) delete memoryProfiles.notes; else memoryProfiles.notes = oldNotes; }
});

test("a paraphrase turn inherits memory dependencies even when the direct note is pruned by budget", () => {
  const oldUsers = users[scope.userId]; const oldNotes = memoryProfiles.notes;
  try {
    users[scope.userId] = { uid: scope.userId, chats: [], nicknames: [] };
    const service = createMemoryNoteService({ profiles: memoryProfiles, available: () => true, persist: () => true, readPrivacy: () => ({ users: {} }) });
    const item = service.act({ ...scope, revision: service.snapshot(scope).revision, action: "create", title: "项目", text: "只读资料".repeat(60) }).items[0];
    recordConversationTurn({ uid: scope.userId, groupId: scope.groupId, messageId: 71011, userText: "项目如何", assistantText: "ORIGINAL_NOTE_RESULT", memorySources: [{ noteId: item.id, revision: 1 }] }, { save: false });
    const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "继续", contextBudget: { maxMessageChars: 400 } });
    assert.ok(packet.messages.some(row => row.content.includes("ORIGINAL_NOTE_RESULT")));
    assert.ok(packet.retrieval.sources.every(source => source.kind !== "note"));
    assert.deepEqual(packet.memorySources, [{ noteId: item.id, revision: 1 }]);
    recordConversationTurn({ uid: scope.userId, groupId: scope.groupId, messageId: 71012, userText: "继续", assistantText: "PARAPHRASED_OLD_RESULT", memorySources: packet.memorySources }, { save: false });
    service.act({ ...scope, revision: service.snapshot(scope).revision, action: "remove", id: item.id });
    const next = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "还是不行" });
    assert.doesNotMatch(JSON.stringify(next.messages), /PARAPHRASED_OLD_RESULT|ORIGINAL_NOTE_RESULT/);
    recordConversationTurn({ uid: scope.userId, groupId: scope.groupId, messageId: 71013, userText: "继续", assistantText: "OLD_EMPTY_DEPENDENCIES", memorySources: [] }, { save: false });
    delete users[scope.userId].cognition.threads[scope.groupId].turns.at(-1).memoryDependencyVersion;
    assert.doesNotMatch(JSON.stringify(buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "继续" }).messages), /OLD_EMPTY_DEPENDENCIES/);
  } finally { if (oldUsers) users[scope.userId] = oldUsers; else delete users[scope.userId];
    if (oldNotes === undefined) delete memoryProfiles.notes; else memoryProfiles.notes = oldNotes; }
});

test("a memory change blocks late background profile writeback even outside a chat run", async () => {
  const old = users[scope.userId];
  let release; let calls = 0;
  try {
    users[scope.userId] = { profile: "retained", chats: [{ text: "synthetic history", group: scope.groupId, ts: time }] };
    const pending = generateProfile(scope.userId, { generate: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
    const service = createMemoryNoteService({ profiles: {}, available: () => true, persist: () => true, readPrivacy: () => ({ users: {} }) });
    service.act({ ...scope, revision: service.snapshot(scope).revision, action: "create", title: "新状态", text: "当前已改变", recordType: "current_state" });
    release("STALE_PROFILE");
    assert.equal(await pending, ""); assert.equal(calls, 1); assert.equal(users[scope.userId].profile, "retained");
  } finally { if (old) users[scope.userId] = old; else delete users[scope.userId]; }
});
