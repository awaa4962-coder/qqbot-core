import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

// Imports must not load a developer's real memory or provider configuration.
const root = path.join(os.tmpdir(), "qqfriend-read-only-" + randomUUID());
process.env.NODE_ENV = "test";
process.env.QQBOT_CONFIG_ROOT = root;
process.env.QQBOT_DATA_DIR = root;
process.env.QQBOT_LOG_DIR = path.join(root, "logs");
process.env.QQBOT_MEMORY_PROFILE_FILE = path.join(root, "profiles.json");
const { recallMemory, readBotStatus } = await import("../bridge/chat-tools/read.mjs");
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { VERSION } = await import("../bridge/version.mjs");
const { peekJmRuntimeHealth } = await import("../bridge/jm/runtime.mjs");
const { getCachedNapCatReadiness } = await import("../bridge/napcat-readiness.mjs");

const DAY = 86400000;
const NOW = 1800000000000;
const GROUP = { surface: "group", userId: "61001", groupId: "51001" };
const PRIVATE = { surface: "private", userId: "61001" };
const cfg = { ...CFG, selfUin: 91001, groupWhitelist: [51001], friendWhitelist: [61001],
  botBlacklist: [], adminUins: [61001, 61002], jmUserWhitelist: [61001, 61002],
  resourceGroupWhitelist: [51001], featureGroupWhitelist: [], summaryGroupWhitelist: [],
  conversationSummaryGroupWhitelist: [], stickerEnabled: false, linkPreviewEnabled: false };

function note(overrides = {}) {
  return { id: "abcdef123456", revision: 1, userId: GROUP.userId, groupId: GROUP.groupId,
    title: "Project", text: "Project uses Linux", kind: "user_statement", state: "active",
    source: { kind: "user_command", messageId: "71001", at: NOW - DAY },
    createdAt: NOW - DAY, updatedAt: NOW - DAY, expiresAt: NOW + DAY, replacedSources: [], ...overrides };
}

function chat(overrides = {}) {
  return { group: GROUP.groupId, text: "Project discussed yesterday", messageId: "72001", ts: NOW - 1000, ...overrides };
}

function options(notes = [], chats = [], overrides = {}) {
  return { cfg, now: NOW, readPrivacy: () => ({ epoch: 0, users: {} }), users: { [GROUP.userId]: { chats } },
    snapshot: () => ({ ok: true, items: notes }),
    corrections: () => ({ excludedMessageIds: new Set(), revisions: new Map(notes.map(item => [item.id, item.revision])), replacedSources: [] }),
    modelHealth: { tasks: Object.fromEntries(["group_chat", "private_chat", "vision"].map(task => [task, { ready: true, primary: { ready: true } }])) },
    jmHealth: { dependencyReady: true, sevenZipReady: true, health: "ready", stale: false },
    napcatHealth: { ready: false }, stickerSettings: { mode: "off" }, ...overrides };
}

const recall = (settings, args = { query: "Project" }, scope = GROUP) => recallMemory(scope, args, settings);

test("recall is synchronous and projects only attributed notes and same-user raw statements", () => {
  const settings = options([note()], [chat()]);
  const output = recall(settings);
  assert.equal(output.status, "ok");
  assert.equal(output.scope, "current_group");
  assert.deepEqual(output.items.map(item => item.kind), ["user_statement", "historical_message"]);
  assert.deepEqual(output.memorySources, [{ noteId: "abcdef123456", revision: 1 }]);
  assert.deepEqual(output.items[0].source, { noteId: "abcdef123456", revision: 1, messageId: "71001", at: NOW - DAY, expiresAt: NOW + DAY });
  assert.deepEqual(output.items[1].source, { messageId: "72001", at: NOW - 1000 });
  assert.equal(output instanceof Promise, false);
  assert.doesNotMatch(JSON.stringify(output), /userId|groupId|verified|nicknames|description/);
  assert.equal(recall(settings, { query: "unrelatedword" }).status, "empty");
});

test("operator notes have note provenance but never fabricate a user message source", () => {
  const output = recall(options([note({ kind: "operator_note", source: { kind: "operator", messageId: "", at: NOW - 1 } })]));
  assert.equal(output.items[0].kind, "operator_note");
  assert.equal(output.items[0].source.messageId, "");
  assert.equal(output.items[0].source.noteId, "abcdef123456");
});

test("strict argument schemas reject identity, scope, filename, command and task injection", () => {
  const forbidden = [null, [], "Project", { query: "" }, { query: " " }, { query: 2 }, { query: "x".repeat(161) },
    ...["userId", "groupId", "scope", "filename", "task", "command", "provider", "currentMessageId", "__proto__"].map(key => ({ query: "Project", [key]: "other" })),
    ...[0, 91, 1.5, "1", null].map(days => ({ query: "Project", days })),
    ...[0, 7, 1.5, "1", null].map(limit => ({ query: "Project", limit })), { query: "Project", kind: "all" },
    Object.assign(Object.create({ userId: "61002" }), { query: "Project" }), { query: "Project", [Symbol("scope")]: GROUP }];
  const accessor = Object.defineProperty({}, "query", { get() { throw new Error("must_not_read"); } });
  forbidden.push(accessor);
  for (const args of forbidden) assert.equal(recall(options(), args).status, "invalid_arguments");
  for (const args of [null, [], "", { query: "Project" }, { filename: "secret" }, { provider: {} }]) {
    assert.equal(readBotStatus(GROUP, args, options()).status, "invalid_arguments");
  }
  assert.equal(recallMemory(GROUP, undefined, options()).status, "invalid_arguments");
  assert.equal(readBotStatus(GROUP, Object.create(null), options()).status, "ok");
});

test("numeric identities and canonical private scope are mandatory, with no admin or JM AI bypass", () => {
  const scopes = [{}, { ...GROUP, userId: 0 }, { ...GROUP, userId: "01" }, { ...GROUP, userId: "1e3" },
    { ...GROUP, userId: 9007199254740992 }, { ...GROUP, userId: "9007199254740993" },
    { ...GROUP, groupId: "private" }, { ...GROUP, groupId: null }, { ...GROUP, surface: "console" },
    { ...PRIVATE, groupId: 51001 }, { ...GROUP, currentMessageId: {} }, { ...PRIVATE, userId: 61002 }];
  for (const scope of scopes) {
    assert.equal(recall(options([note()]), { query: "Project" }, scope).status, "denied");
    assert.equal(readBotStatus(scope, {}, options()).status, "denied");
  }
  assert.equal(recall(options([note()]), { query: "Project" }, { ...GROUP, userId: 61001, groupId: 51001 }).status, "ok");
});

test("permission denial occurs before any store reads and reflects current config on every call", () => {
  const local = { ...cfg };
  let reads = 0;
  const settings = options([], [], { cfg: local, readPrivacy() { reads++; throw new Error("unreachable"); } });
  for (const change of [{ botBlacklist: [61001] }, { botBlacklist: [], groupWhitelist: [] }, { botBlacklist: null, groupWhitelist: [51001] }]) {
    Object.assign(local, change);
    assert.equal(recall(settings).status, "denied");
    assert.equal(readBotStatus(GROUP, {}, settings).status, "denied");
  }
  assert.equal(reads, 0);
  const saved = CFG.groupWhitelist;
  try {
    CFG.groupWhitelist = [51001];
    const defaults = options([note()], [], { cfg: undefined });
    assert.equal(recall(defaults).status, "ok");
    CFG.groupWhitelist = [];
    assert.equal(recall(defaults).status, "denied");
  } finally { CFG.groupWhitelist = saved; }
});

test("private explicit-note exception never touches legacy profiles, private logs or other groups", () => {
  const settings = options([note({ groupId: "private" }), note({ id: "abcdef123457" }),
    note({ id: "abcdef123458", groupId: "private", userId: "61002" })]);
  Object.defineProperty(settings, "users", { get() { throw new Error("private_history_must_not_be_read"); } });
  const output = recall(settings, { query: "Project" }, PRIVATE);
  assert.equal(output.status, "ok");
  assert.equal(output.scope, "private");
  assert.equal(output.items.length, 1);
  assert.equal(recall(settings, { query: "Project", kind: "history" }, PRIVATE).status, "empty");
  assert.equal(recall(options(), { query: "Project" }, PRIVATE).status, "empty");
});

test("scope filtering excludes other groups/users and all records without usable timestamps or IDs", () => {
  const chats = [chat(), chat({ group: "private", messageId: "1" }), chat({ group: "51002", messageId: "2" }),
    chat({ uid: "61002", messageId: "3" }), chat({ messageId: undefined }), chat({ messageId: {} }),
    chat({ messageId: "4", ts: 0 }), chat({ messageId: "5", ts: "yesterday" }), chat({ messageId: "6", ts: NOW + 1 }),
    chat({ messageId: "7", text: { unexpected: "Project" } })];
  const notes = [note({ userId: "61002" }), note({ groupId: "private" }), note({ groupId: "51002" }),
    note({ id: "bad" }), note({ source: { kind: "user_command", messageId: "", at: NOW - 1 } }), note({ revision: 0 })];
  const settings = options(notes, chats);
  settings.users["61002"] = { chats: [chat({ messageId: "8", text: "Project other user" })] };
  const output = recall(settings);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].source.messageId, "72001");
  assert.deepEqual(output.memorySources, []);
});

test("durable erasure cutoff excludes stale snapshots and replayed history even with new arrival times", () => {
  let cutoff = NOW - 1000;
  const settings = options([note()], [chat(), chat({ messageId: "72002", ts: NOW - 2000, receivedAt: NOW }),
    chat({ messageId: "72003", ts: NOW, receivedAt: NOW - 2000 }), chat({ messageId: "72004", ts: NOW, text: "Project after erasure" })],
  { readPrivacy: () => ({ epoch: 1, users: { [GROUP.userId]: cutoff } }) });
  const output = recall(settings);
  assert.deepEqual(output.items.map(item => item.source.messageId), ["72004"]);
  assert.deepEqual(output.memorySources, []);
  cutoff = NOW;
  assert.equal(recall(settings).status, "empty");
});

test("unreadable or malformed privacy and correction state fail closed without leaking exceptions", () => {
  const broken = () => { throw new Error("C:/private/API_KEY=do-not-leak"); };
  for (const readPrivacy of [broken, () => null, () => ({ users: [] }), () => ({ users: {}, epoch: -1 }),
    ...["100", -1, null, undefined, NaN, Infinity].map(value => () => ({ users: { [GROUP.userId]: value } }))]) {
    const settings = options([note()], [chat()], { readPrivacy });
    assert.equal(recall(settings).status, "unavailable");
    assert.equal(readBotStatus(GROUP, {}, settings).status, "unavailable");
    assert.doesNotMatch(JSON.stringify(recall(settings)), /private|API_KEY|do-not-leak/);
  }
  for (const overrides of [{ snapshot: broken }, { corrections: broken }, { snapshot: () => ({ items: null }) },
    { corrections: () => ({ excludedMessageIds: [] }) }]) {
    assert.equal(recall(options([note()], [chat()], overrides)).status, "unavailable");
  }
});

test("note TTL, requested days, kind and default limits are enforced independently", () => {
  const notes = [note({ expiresAt: NOW }), note({ id: "abcdef123457", state: "expired" }),
    note({ id: "abcdef123458", source: { kind: "user_command", messageId: "4", at: NOW - 31 * DAY } })];
  const settings = options(notes, [chat({ ts: NOW - 31 * DAY })]);
  assert.equal(recall(settings).status, "empty");
  assert.equal(recall(settings, { query: "Project", days: 90 }).items.length, 2);
  assert.equal(recall(settings, { query: "Project", days: 90, kind: "notes" }).items.length, 1);
  assert.equal(recall(settings, { query: "Project", days: 90, kind: "history" }).items[0].kind, "historical_message");
  const many = options([], Array.from({ length: 8 }, (_, i) => chat({ text: "Project event " + i, messageId: String(80 + i) })));
  assert.equal(recall(many).items.length, 4);
  assert.equal(recall(many, { query: "Project", limit: 6 }).items.length, 6);
  assert.equal(recall(many, { query: "Project", limit: 1 }).items.length, 1);
});

test("current message, memory commands, retractions and dependent old-source messages never return", () => {
  const settings = options([note()], [chat({ messageId: "71001" }), chat({ messageId: "2", memoryCommand: true }),
    chat({ messageId: "3", retracted: true }), chat({ messageId: "4", text: "[command] Project" }),
    chat({ messageId: "5", text: "\u8bb0\u4f4f Project = old" }),
    chat({ messageId: "6", text: "[CQ:at,qq=91001] /\u7ea0\u6b63\u8bb0\u5fc6 Project = old" }),
    chat({ messageId: "7" }), chat({ messageId: "8", replyToMessageId: "9" }), chat({ messageId: "9" })],
  { corrections: () => ({ excludedMessageIds: new Set(["9"]), revisions: new Map([["abcdef123456", 1]]) }) });
  assert.equal(recall(settings, { query: "Project", kind: "history" }, { ...GROUP, currentMessageId: "7" }).status, "empty");
  assert.equal(recall(settings, { query: "Project", kind: "notes" }, { ...GROUP, currentMessageId: 71001 }).status, "empty");
});

test("actual store consumer snapshots honor corrections, removals and durable retractions beyond eight revisions", () => {
  let now = NOW - DAY;
  const profiles = {};
  const service = createMemoryNoteService({ profiles, available: () => true, persist: () => true,
    invalidate() {}, now: () => now, readPrivacy: () => ({ users: {} }) });
  const scope = { userId: GROUP.userId, groupId: GROUP.groupId };
  const act = (payload, id) => service.act({ ...scope, revision: service.snapshot(scope).revision, ...payload },
    { origin: "user_command", messageId: id });
  const original = act({ action: "create", title: "Project", text: "Project obsolete choice" }, "100").items[0];
  const chats = [chat({ text: "Project obsolete choice", messageId: "100" }), chat({ text: "Project raw record", messageId: "200" })];
  for (let i = 1; i <= 10; i++) {
    now++;
    act({ action: "update", id: original.id, text: "Project correction " + i }, String(100 + i));
    chats.push(chat({ text: "Project correction " + i, messageId: String(100 + i) }));
  }
  const settings = options([], chats, { snapshot: service.snapshot, corrections: service.corrections });
  const before = JSON.stringify(profiles);
  const output = recall(settings);
  assert.equal(output.items[0].text, "Project correction 10");
  assert.equal(output.items[0].source.revision, 11);
  assert.deepEqual(output.items.map(item => item.source.messageId), ["110", "200"]);
  assert.equal(JSON.stringify(profiles), before);
  now++;
  act({ action: "remove", id: original.id }, "111");
  const afterRemoval = recall(settings);
  assert.deepEqual(afterRemoval.items.map(item => item.source.messageId), ["200"]);
  assert.deepEqual(afterRemoval.memorySources, []);
});

test("current correction notes outrank older notes and duplicate raw records", () => {
  const corrected = note({ revision: 2, text: "Project uses Rust" });
  const output = recall(options([note({ id: "abcdef123457", text: "Project uses Ruby", source: { kind: "user_command", messageId: "71002", at: NOW } }), corrected],
    [chat({ text: "Project uses Rust", messageId: "1" }), chat({ text: "Project raw", messageId: "2" }),
      chat({ text: "Project raw!", messageId: "3" }), chat({ text: "Project transport duplicate", messageId: "2" })]));
  assert.equal(output.items[0].text, "Project uses Rust");
  assert.equal(output.items.filter(item => item.text === "Project uses Rust").length, 1);
  assert.equal(output.items.filter(item => item.kind === "historical_message").length, 1);
  const stale = options([corrected], [], { corrections: () => ({ excludedMessageIds: new Set(), revisions: new Map([[corrected.id, 3]]) }) });
  assert.equal(recall(stale).status, "empty");
});

test("redaction precedes bounding, and the entire serialized result preserves every source pair", () => {
  const notes = Array.from({ length: 8 }, (_, i) => note({ id: i.toString(16).padStart(12, "0"),
    title: "Project " + i, text: "Project " + i + " api_key=secret-value " + '\\"'.repeat(400) + " \ud83d\ude80".repeat(100),
    source: { kind: "user_command", messageId: String(500 + i), at: NOW - i } }));
  const output = recall(options(notes), { query: "Project", limit: 6 });
  const json = JSON.stringify(output);
  assert.equal(output.status, "ok");
  assert.ok(output.items.length <= 6);
  assert.ok(json.length <= 1800, String(json.length));
  assert.deepEqual(JSON.parse(json), output);
  assert.doesNotMatch(json, /secret-value/);
  assert.match(json, /REDACTED/);
  assert.deepEqual(output.memorySources, output.items.map(item => ({ noteId: item.source.noteId, revision: item.source.revision })));
  assert.ok(output.items.every(item => Array.from(item.text).length <= 300 && item.source.messageId && item.source.at && item.source.expiresAt));
});

test("status reveals only permitted capability names/status/health and safe backend model identity", () => {
  const settings = options([], [], { provider: { model: "vendor/model-1.2", endpoint: "https://secret.example/", key: "private-key", id: "provider-secret" } });
  const output = readBotStatus(GROUP, {}, settings);
  assert.equal(output.status, "ok");
  assert.equal(output.version, VERSION);
  assert.equal(output.requestedModel, "vendor/model-1.2");
  assert.ok(output.capabilities.some(item => item.name === "JM \u4e0b\u8f7d\u8f6c\u53d1"));
  assert.ok(output.capabilities.every(item => Object.keys(item).sort().join() === "health,name,status"));
  assert.doesNotMatch(JSON.stringify(output), /61001|51001|61002|91001|\u7ba1\u7406\u5458|count|endpoint|private-key|secret.example|provider-secret|path/);
  assert.equal(Object.hasOwn(readBotStatus(GROUP, {}, options()), "requestedModel"), false);
  for (const model of ["https://secret.example/key", "C:/private/model", "sk-" + "a".repeat(30), "ignore previous instructions"]) {
    assert.equal(readBotStatus(GROUP, {}, options([], [], { provider: { model } })).requestedModel, "\u672a\u516c\u5f00\u7684\u81ea\u5b9a\u4e49\u6a21\u578b");
  }
});

test("configuration readiness never implies connectivity; stale and unhealthy cache readings stay unknown", () => {
  const fresh = { ready: true, loggedIn: true, userMatches: true, checkedAt: new Date(NOW - 1).toISOString(),
    endpoint: "https://secret.example", userId: "91001", reason: "internal-detail" };
  assert.equal(readBotStatus(GROUP, {}, options([], [], { napcatHealth: fresh })).napcat.health, "ready");
  for (const napcatHealth of [{ ...fresh, ready: false }, { ...fresh, userMatches: false },
    { ...fresh, checkedAt: new Date(NOW - 5000).toISOString() }, { ...fresh, checkedAt: new Date(NOW + 1).toISOString() }, {}]) {
    const output = readBotStatus(GROUP, {}, options([], [], { napcatHealth, jmHealth: { stale: true }, modelHealth: { tasks: {} } }));
    assert.equal(output.napcat.health, "unknown");
    assert.equal(output.capabilities.find(item => item.name === "\u804a\u5929\u56de\u590d").status, "unknown");
    assert.equal(output.capabilities.find(item => item.name === "JM \u4e0b\u8f7d\u8f6c\u53d1").health, "unknown");
  }
  const chatState = readBotStatus(GROUP, {}, options()).capabilities.find(item => item.name === "\u804a\u5929\u56de\u590d");
  assert.equal(chatState.health, "configured");
  assert.notEqual(chatState.health, "ready");
});

test("default status consumers peek without probing or mutating readiness caches", t => {
  const jm = peekJmRuntimeHealth();
  const napcat = getCachedNapCatReadiness();
  t.mock.method(globalThis, "fetch", () => { throw new Error("network forbidden"); });
  const output = readBotStatus(GROUP, {}, options([], [], { jmHealth: undefined, napcatHealth: undefined, modelHealth: undefined }));
  assert.equal(output.status, "ok");
  assert.equal(output.napcat.health, "unknown");
  assert.deepEqual(peekJmRuntimeHealth(), jm);
  assert.deepEqual(getCachedNapCatReadiness(), napcat);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
