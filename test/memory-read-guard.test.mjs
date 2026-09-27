import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-read-guard-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { createMemoryReadGuard, bindLayerMemoryReferences } = await import("../bridge/memory-profile/read-guard.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { normalizeChatOutcome } = await import("../bridge/chat-outcome.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { READ_TOOLS } = await import("../bridge/chat-tools/policy.mjs");
const scope = { surface: "group", userId: "60131", groupId: "50131" };
const source = { noteId: "abcdef123456", revision: 1 };
const start = 1800000000000;

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const state = { now: start, entries: [{ ...source, active: true, expiresAt: start + 100 }] };
  const guard = createMemoryReadGuard(scope, { now: () => state.now, read: given => {
    assert.deepEqual(given, { userId: scope.userId, groupId: scope.groupId });
    return { entries: state.entries };
  } });
  return { state, guard };
}

test("expiry is checked at every boundary, remains cancelled after clock reversal and needs no generation change", () => {
  const { state, guard } = fixture();
  guard.track([source]); state.now += 99;
  assert.equal(guard.reason(), "");
  state.now++;
  assert.equal(guard.reason(), "memory_expired");
  state.now = start;
  assert.throws(guard.assertCurrent, { code: "CHAT_MEMORY_CHANGED", message: "memory_expired" });
});

test("a later dependency cannot renew the earlier note or erase its revision", () => {
  const { state, guard } = fixture();
  guard.track([source]); state.now += 50;
  const later = { noteId: "abcdef123457", revision: 2 };
  state.entries.push({ ...later, active: true, expiresAt: start + 500 });
  guard.track([later]);
  assert.deepEqual(guard.sources(), [source, later]);
  state.now = start + 100;
  assert.equal(guard.reason(), "memory_expired");
});

for (const [name, mutate, expected = "memory_unavailable"] of [
  ["missing", state => { state.entries = []; }],
  ["wrong revision", state => { state.entries[0].revision++; }],
  ["unreadable", state => { state.entries = null; }],
  ["inactive", state => { state.entries[0].active = false; }],
  ["invalid expiry", state => { state.entries[0].expiresAt = NaN; }],
  ["already expired", state => { state.now += 100; state.entries[0].active = false; }, "memory_expired"],
]) test(`${name} metadata cannot be used as a valid memory dependency`, () => {
  const { state, guard } = fixture(); mutate(state); guard.track([source]);
  assert.equal(guard.reason(), expected);
  assert.throws(guard.assertCurrent, { code: "CHAT_MEMORY_CHANGED" });
});

test("clock reversal after an intermediate boundary permanently cancels the memory read", () => {
  const { state, guard } = fixture(); guard.track([source]);
  state.now += 50; assert.equal(guard.reason(), "");
  state.now--; assert.equal(guard.reason(), "memory_unavailable");
  state.now += 10; assert.equal(guard.reason(), "memory_unavailable");
});

test("empty-context chat does not read notes and privacy invalidation still cancels it", () => {
  let reads = 0;
  const guard = createMemoryReadGuard({}, { read: () => { reads++; throw new Error("unavailable"); } });
  guard.track([]); assert.equal(guard.reason(), ""); assert.equal(reads, 0);
  invalidateMemoryPrivacyGeneration(); assert.equal(guard.reason(), "privacy_changed");
});

for (const [name, value] of [
  ["invalid", [{}]], ["null", null], ["contradictory", [source, { ...source, revision: 2 }]],
  ["overflow", Array.from({ length: 33 }, (_, i) => ({ noteId: i.toString(16).padStart(12, "0"), revision: 1 }))],
]) test(`typed reply and guard reject ${name} dependencies instead of silently dropping them`, () => {
  const { guard } = fixture(); guard.track(value);
  assert.equal(guard.reason(), "memory_unavailable");
  assert.deepEqual(normalizeChatOutcome({ kind: "reply", text: "synthetic answer", memorySources: value }),
    { kind: "cancelled", text: null, reason: "memory_unavailable" });
});

test("metadata exposes only same-scope invalidation fields and private owner isolation", () => {
  const profiles = {};
  const service = createMemoryNoteService({ profiles, available: () => true, now: () => start, persist: () => true,
    invalidate: () => {}, readPrivacy: () => ({ users: {} }) });
  for (const [userId, groupId] of [["60131", "50131"], ["60132", "50131"], ["60131", "50132"], ["60131", "private"], ["60132", "private"]]) {
    const target = { userId, groupId };
    service.act({ ...target, revision: service.snapshot(target).revision, action: "create", title: "PRIVATE_TITLE",
      text: "PRIVATE_BODY", ttlDays: 1 }, { origin: "user_command", messageId: "70131" });
  }
  const group = service.metadata(scope);
  assert.deepEqual(group.entries.map(item => item.userId), ["60131", "60132"]);
  assert.doesNotMatch(JSON.stringify(group), /PRIVATE_TITLE|PRIVATE_BODY|text|title/);
  const personal = service.metadata({ userId: "60131", groupId: "private" });
  assert.deepEqual(personal.entries.map(item => item.userId), ["60131"]);
  assert.equal(service.snapshot(scope).items.length, 1, "scope revisions do not expand recall permission");
  assert.equal(service.corrections(scope).revisions.size, 1);
  assert.equal(service.corrections(scope).scopeRevisions.size, 2);
});

test("unreadable privacy state fails even for an empty metadata store", () => {
  const service = createMemoryNoteService({ profiles: {}, available: () => true, readPrivacy: () => ({ users: [] }) });
  assert.throws(() => service.metadata(scope), /隐私状态/);
});

test("selected exact source identity binds all matching notes without emitting their contents", t => {
  const second = { ...source, noteId: "abcdef123457" };
  const entries = [source, second].map(item => ({ ...item, userId: "60132", messageId: "70131", expiresAt: start + 100, active: true }));
  t.mock.method(memoryNoteService, "metadata", () => ({ entries }));
  const layer = { role: "user", content: "quoted text", contextSources: [{ kind: "quote", userId: "60132", messageId: "70131" }] };
  const [bound] = bindLayerMemoryReferences([layer], scope);
  assert.deepEqual(bound.contextMemorySources, [source, second]);
  assert.equal(bound.content, layer.content);
  assert.deepEqual(bindLayerMemoryReferences([{ ...layer, contextSources: [{ userId: "60131", messageId: "70131" }] }], scope)[0].contextMemorySources, []);
  entries[1].active = false;
  assert.equal(bindLayerMemoryReferences([layer], scope)[0].contextMemorySources, null);
});

test("tool reuse and fallback cannot expose expired cached results outside an active chat run", async t => {
  let time = start;
  t.mock.method(Date, "now", () => time);
  const session = createChatToolSession({ scope, cfg: { groupWhitelist: [50131], botBlacklist: [] },
    memoryRead: () => ({ entries: [{ ...source, expiresAt: start + 100, active: true }] }),
    recallMemory: () => ({ status: "ok", text: "OLD_TOOL_BODY", memorySources: [source] }) });
  const call = { id: "read-a", function: { name: "recall_memory", arguments: '{"query":"project"}' } };
  const result = await session.execute(call, READ_TOOLS);
  assert.match(result.content, /OLD_TOOL_BODY/);
  time += 100;
  assert.throws(session.fallbackContext, { code: "CHAT_MEMORY_CHANGED", message: "memory_expired" });
  await assert.rejects(session.execute({ ...call, id: "read-b" }, READ_TOOLS), { code: "CHAT_MEMORY_CHANGED" });
  assert.throws(() => session.prepareModel({ messages: [] }), { code: "CHAT_MEMORY_CHANGED" });
});

test("contradictory tool revisions cannot overwrite earlier dependencies", async () => {
  let revision = 1;
  const session = createChatToolSession({ scope, cfg: { groupWhitelist: [50131], botBlacklist: [] },
    memoryRead: () => ({ entries: [{ ...source, revision, expiresAt: Date.now() + 10000, active: true }] }),
    recallMemory: () => ({ status: "ok", text: "OLD_TOOL_BODY", memorySources: [{ ...source, revision }] }) });
  const call = query => ({ id: query, function: { name: "recall_memory", arguments: JSON.stringify({ query }) } });
  await session.execute(call("first"), READ_TOOLS); revision++;
  await assert.rejects(session.execute(call("second"), READ_TOOLS), { code: "CHAT_MEMORY_CHANGED", message: "memory_unavailable" });
});
