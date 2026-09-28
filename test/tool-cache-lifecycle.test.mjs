import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after, beforeEach } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tool-cache-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_TEMP_DIR: path.join(root, "temp"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") });

const { CFG } = await import("../bridge/config.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { CHAT_TOOL_LIMITS: LIMITS, READ_TOOLS } = await import("../bridge/chat-tools/policy.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { getMemoryPrivacyGeneration, getUserMemoryGeneration, invalidateMemoryPrivacyGeneration,
  invalidateUserMemoryGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { setUserStylePreference } = await import("../bridge/user-preferences.mjs");

const GROUP = Object.freeze({ surface: "group", userId: "60139", groupId: "50139", currentMessageId: "70139" });
const SOURCE = Object.freeze({ noteId: "abcdef123439", revision: 1 });
const START = 1800000000000;
const settings = () => ({ groupWhitelist: [50139, 50140], friendWhitelist: [60139, 60140],
  botBlacklist: [], selfUin: 99939, botNames: ["TestBot"], tavilyKey: "synthetic-search-key" });
const call = (name, args, id = "read-a") => ({ id, type: "function", function: {
  name, arguments: typeof args === "string" ? args : JSON.stringify(args),
} });
const invoke = (session, args = { query: "Project" }, id, provider) =>
  session.execute(call("recall_memory", args, id), READ_TOOLS, provider);
const wire = response => JSON.parse(response.content);
const create = options => createChatToolSession({ scope: GROUP, cfg: settings(), task: "group_chat",
  userMessage: "search Debian release", ...options });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(t => {
  let unexpectedNetwork = 0;
  t.mock.method(globalThis, "fetch", () => { unexpectedNetwork++; throw new Error("real network forbidden"); });
  t.after(() => assert.equal(unexpectedNetwork, 0));
});

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function notesFixture(t) {
  const state = { now: START, reads: 0, scopes: [] };
  const cfg = settings();
  t.mock.method(Date, "now", () => state.now);
  const service = createMemoryNoteService({ profiles: {}, available: () => true, persist: () => true,
    now: () => state.now, readPrivacy: () => ({ users: {} }) });
  t.mock.method(memoryNoteService, "metadata", service.metadata);
  const act = (payload, scope = GROUP) => {
    const target = { userId: scope.userId, groupId: scope.surface === "private" ? "private" : scope.groupId };
    state.now++;
    return service.act({ ...target, revision: service.snapshot(target).revision, ...payload },
      { origin: "user_command", messageId: String(state.now) });
  };
  const session = (scope = GROUP) => create({ scope, cfg, memoryRead: service.metadata,
    recallMemory: (given, args) => {
      state.reads++;
      state.scopes.push({ ...given });
      return recallMemory(given, args, { cfg, now: () => state.now, snapshot: service.snapshot,
        corrections: service.corrections, users: {}, readPrivacy: () => ({ users: {} }) });
    } });
  return { state, service, act, session };
}

test("same-session raw reads reuse deterministic argument keys but still consume all four tool slots", async () => {
  let reads = 0;
  const result = { status: "ok", items: [{ text: "RAW_EVIDENCE" }], memorySources: [SOURCE] };
  const session = create({ memoryRead: given => {
    assert.deepEqual(given, { userId: GROUP.userId, groupId: GROUP.groupId });
    return { entries: [{ ...SOURCE, active: true, expiresAt: Date.now() + 60000 }] };
  }, recallMemory: given => { reads++; assert.deepEqual(given, GROUP); return result; } });
  const queries = [{ query: "Project", days: 30, limit: 4, kind: "both" },
    { kind: "both", limit: 4, days: 30, query: "Project" }];
  const first = await invoke(session, queries[0]);
  result.items[0].text = "MUTATED_BACKEND_OBJECT";
  for (let index = 1; index < LIMITS.toolCalls; index++) {
    const repeated = await invoke(session, queries[index % 2], "read-" + index);
    assert.equal(repeated.content, first.content);
    assert.equal(repeated.tool_call_id, "read-" + index);
  }
  assert.equal(reads, 1);
  assert.deepEqual(session.sources(), [SOURCE]);
  assert.doesNotMatch(first.content, /memorySources|memoryExpiresAt/);
  assert.equal(session.snapshot().toolCalls, 4);
  assert.equal(session.remainingTools(), 0);
  await assert.rejects(invoke(session), { code: "CHAT_TOOL_STOPPED", message: "tool_budget" });
  assert.equal(reads, 1);
  assert.equal(session.snapshot().toolCalls, 4);
});

test("90-second cache deadline is exact and cannot revive after clock reversal", async () => {
  let time = 0;
  let reads = 0;
  const session = create({ now: () => time, recallMemory: () => {
    reads++; return { status: "ok", text: "bounded raw evidence" };
  } });
  const first = await invoke(session);
  time = LIMITS.durationMs - 1;
  assert.equal((await invoke(session)).content, first.content);
  time++;
  await assert.rejects(invoke(session), /tool_deadline/);
  assert.throws(session.fallbackContext, /tool_deadline/);
  time = 0;
  await assert.rejects(invoke(session), /tool_deadline/);
  assert.equal(reads, 1);
});

test("the real timer abort is checked even when the injected monotonic clock has not advanced", async t => {
  const timer = new globalThis.AbortController();
  t.mock.method(globalThis.AbortSignal, "timeout", duration => {
    assert.equal(duration, LIMITS.durationMs); return timer.signal;
  });
  let reads = 0;
  const session = create({ now: () => 0, recallMemory: () => { reads++; return { status: "ok", text: "raw" }; } });
  await invoke(session);
  timer.abort();
  assert.equal(session.signal.aborted, true);
  await assert.rejects(invoke(session), /tool_deadline/);
  assert.equal(reads, 1);
});

for (const [label, failed] of [
  ["unavailable", () => ({ status: "unavailable", text: "FAILED_BODY" })],
  ["denied", () => ({ status: "denied", text: "DENIED_BODY" })],
  ["invalid arguments", () => ({ status: "invalid_arguments" })],
  ["unknown status", () => ({ status: "unknown", text: "UNKNOWN_BODY" })],
  ["null", () => null],
  ["array", () => []],
  ["missing usable payload", () => ({ status: "ok", items: "not-an-array" })],
  ["null memory row", () => ({ status: "ok", items: [null] })],
  ["blank memory row", () => ({ status: "ok", items: [{ text: " " }] })],
  ["contradictory empty result", () => ({ status: "empty", items: [{ text: "OLD_BODY" }] })],
  ["blank payload", () => ({ status: "ok", text: "  " })],
  ["unserializable", () => { const value = { status: "ok", text: "CIRCULAR_BODY" }; value.self = value; return value; }],
  ["oversized", () => ({ status: "ok", text: "x".repeat(LIMITS.resultChars + 1), memorySources: [SOURCE] })],
  ["thrown failure", () => { throw new Error("synthetic failure"); }],
]) test(`${label} is neither successful cache nor fallback evidence, and a later usable read retries`, async () => {
  let reads = 0;
  const session = create({ recallMemory: () => ++reads === 1 ? failed() : { status: "ok", text: "FRESH_RAW_BODY" } });
  const first = await invoke(session);
  assert.notEqual(wire(first).status, "ok");
  assert.deepEqual(session.fallbackContext(), []);
  assert.deepEqual(session.sources(), []);
  const second = await invoke(session, undefined, "read-b");
  assert.equal(wire(second).text, "FRESH_RAW_BODY");
  assert.equal((await invoke(session, undefined, "read-c")).content, second.content);
  assert.equal(reads, 2);
});

test("aggregate-budget rejection is not cached and a smaller fourth result really executes", async () => {
  let reads = 0;
  const base = { status: "ok", text: "" };
  const large = { ...base, text: "x".repeat(LIMITS.resultChars - JSON.stringify(base).length) };
  const session = create({ recallMemory: () => { reads++; return reads < 4 ? large : { status: "ok", text: "fresh small raw" }; } });
  const responses = [await invoke(session, { query: "one" }), await invoke(session, { query: "two" })];
  responses.push(await invoke(session, { query: "blocked" }));
  assert.equal(wire(responses[2]).reason, "result_budget");
  responses.push(await invoke(session, { query: "blocked" }));
  assert.equal(wire(responses[3]).text, "fresh small raw");
  assert.equal(reads, 4);
  assert.ok(responses.reduce((sum, response) => sum + response.content.length, 0) <= LIMITS.totalResultChars);
  assert.equal(session.snapshot().toolOutputChars, responses.reduce((sum, response) => sum + response.content.length, 0));
});

test("unknown, undeclared and invalid calls cannot reach a reader or create fallback evidence", async () => {
  const invalid = ["{", "[]", "null", { query: "Project", userId: "60140" }, { query: { text: "Project" } },
    { query: " " }, { query: "Project", days: 0 }, { query: "Project", days: 91 },
    { query: "Project", limit: 7 }, { query: "Project", kind: "all" }, { days: 30 }];
  let reads = 0;
  for (const args of invalid) {
    const session = create({ recallMemory: () => { reads++; return { status: "ok", text: "SHOULD_NOT_RUN" }; } });
    for (let index = 0; index < 2; index++) assert.equal(wire(await invoke(session, args)).status, "invalid_arguments");
    assert.deepEqual(session.fallbackContext(), []);
  }
  const session = create({ recallMemory: () => { reads++; return { status: "ok", text: "SHOULD_NOT_RUN" }; } });
  const unknown = call("delete_files", {});
  assert.equal(wire(await session.execute(unknown, [{ function: { name: "delete_files" } }])).status, "denied");
  assert.equal(wire(await session.execute(call("recall_memory", { query: "Project" }), [])).status, "denied");
  assert.equal(wire(await invoke(session)).text, "SHOULD_NOT_RUN");
  assert.equal(reads, 1);
});

test("empty memory cache stops on the actual notes creation revision, and a new session reads the new note", async t => {
  const fixture = notesFixture(t);
  const session = fixture.session();
  const empty = await invoke(session);
  assert.equal(wire(empty).status, "empty");
  assert.equal((await invoke(session)).content, empty.content);
  assert.equal(fixture.state.reads, 1);
  const generation = getMemoryPrivacyGeneration();
  fixture.act({ action: "create", title: "Project", text: "Project uses Debian" });
  assert.ok(getMemoryPrivacyGeneration() > generation);
  await assert.rejects(invoke(session), /privacy_changed/);
  assert.throws(session.fallbackContext, /privacy_changed/);
  assert.equal(fixture.state.reads, 1);
  const fresh = await invoke(fixture.session());
  assert.equal(wire(fresh).items[0].text, "Project uses Debian");
  assert.equal(fixture.state.reads, 2);
});

for (const action of ["update", "remove"]) test(`actual notes ${action} invalidates an already populated cache before another read`, async t => {
  const fixture = notesFixture(t);
  const note = fixture.act({ action: "create", title: "Project", text: "Project OLD_NOTE_BODY" }).items[0];
  const session = fixture.session();
  assert.match((await invoke(session)).content, /OLD_NOTE_BODY/);
  const generation = getMemoryPrivacyGeneration();
  fixture.act({ action, id: note.id, ...(action === "update" ? { text: "Project NEW_NOTE_BODY" } : {}) });
  assert.ok(getMemoryPrivacyGeneration() > generation);
  await assert.rejects(invoke(session), /privacy_changed/);
  assert.throws(session.fallbackContext, /privacy_changed/);
  assert.equal(fixture.state.reads, 1);
  const fresh = wire(await invoke(fixture.session()));
  assert.doesNotMatch(JSON.stringify(fresh), /OLD_NOTE_BODY/);
  assert.equal(fresh.status, action === "update" ? "ok" : "empty");
  assert.equal(fixture.state.reads, 2);
});

for (const [label, mutate, reason] of [
  ["revision", entries => { entries[0].revision++; }, "memory_unavailable"],
  ["inactive", entries => { entries[0].active = false; }, "memory_unavailable"],
  ["removed", entries => { entries.length = 0; }, "memory_unavailable"],
  ["expiry", entries => { entries[0].expiresAt = START; }, "memory_expired"],
]) test(`the existing notes guard rejects ${label} without relying on generation bumps or dispatching a new read`, async t => {
  t.mock.method(Date, "now", () => START);
  const entries = [{ ...SOURCE, active: true, expiresAt: START + 10000 }];
  let reads = 0;
  const session = create({ memoryRead: () => ({ entries }), recallMemory: () => {
    reads++; return { status: "ok", text: "STALE_RAW_BODY", memorySources: [SOURCE] };
  } });
  await invoke(session);
  const generation = getMemoryPrivacyGeneration();
  mutate(entries);
  await assert.rejects(invoke(session), { code: "CHAT_MEMORY_CHANGED", message: reason });
  assert.throws(session.fallbackContext, { code: "CHAT_MEMORY_CHANGED", message: reason });
  assert.throws(() => session.prepareModel({ messages: [] }), { code: "CHAT_MEMORY_CHANGED", message: reason });
  assert.equal(getMemoryPrivacyGeneration(), generation);
  assert.equal(reads, 1);
});

test("tracked source expiry and result expiry each stop reuse at the exact wall-clock boundary", async t => {
  let time = START;
  t.mock.method(Date, "now", () => time);
  for (const dependencies of [
    { memorySources: [SOURCE] }, { memorySources: [], memoryExpiresAt: START + 100 },
  ]) {
    let reads = 0;
    time = START;
    const session = create({ memoryRead: () => ({ entries: [{ ...SOURCE, active: true, expiresAt: START + 100 }] }),
      recallMemory: () => { reads++; return { status: "ok", text: "EXPIRING_BODY", ...dependencies }; } });
    const first = await invoke(session);
    time += 99;
    assert.equal((await invoke(session)).content, first.content);
    time++;
    await assert.rejects(invoke(session), /memory_expired/);
    assert.throws(session.fallbackContext, /memory_expired/);
    assert.equal(reads, 1);
  }
});

for (const [label, invalidate] of [
  ["global privacy", () => invalidateMemoryPrivacyGeneration()],
  ["current-user forget", () => invalidateUserMemoryGeneration(GROUP.userId)],
  ["another-user privacy clear", () => invalidateUserMemoryGeneration("60140")],
]) test(`${label} invalidates raw public cache with zero subsequent fake HTTP calls`, async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(String(url), "https://api.tavily.com/search");
    assert.equal(JSON.parse(options.body).query, "Debian");
    assert.equal(options.signal.aborted, false);
    return new globalThis.Response(JSON.stringify({ results: [{ title: "Debian", content: "SYNTHETIC_PUBLIC_RAW" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const session = create();
  const query = call("web_search", { query: "Debian" });
  const declared = session.definitions();
  const first = await session.execute(query, declared);
  assert.match(first.content, /SYNTHETIC_PUBLIC_RAW/);
  assert.equal((await session.execute(query, declared)).content, first.content);
  assert.equal(requests, 1);
  invalidate();
  await assert.rejects(session.execute(query, declared), /privacy_changed/);
  assert.throws(session.fallbackContext, /privacy_changed/);
  assert.equal(requests, 1);
});

test("actual user style/template preference invalidation stops the old session without clearing another user's raw reads", async () => {
  let reads = 0;
  const make = scope => create({ scope, recallMemory: () => { reads++; return { status: "ok", text: "raw independent evidence" }; } });
  const owner = make(GROUP);
  const other = make({ ...GROUP, userId: "60140" });
  await invoke(owner);
  await invoke(other);
  const globalGeneration = getMemoryPrivacyGeneration();
  const userGeneration = getUserMemoryGeneration(GROUP.userId);
  assert.equal(setUserStylePreference(GROUP.userId, "\u7b80\u77ed", { users: {}, skipSave: true }).ok, true);
  assert.ok(getUserMemoryGeneration(GROUP.userId) > userGeneration);
  assert.equal(getMemoryPrivacyGeneration(), globalGeneration);
  await assert.rejects(invoke(owner), /preferences_changed/);
  assert.throws(owner.fallbackContext, /preferences_changed/);
  assert.equal(wire(await invoke(other)).text, "raw independent evidence");
  assert.equal(reads, 2);
});

for (const [label, change] of [
  ["group permission", cfg => { cfg.groupWhitelist = []; }],
  ["blacklist", cfg => { cfg.botBlacklist = [Number(GROUP.userId)]; }],
  ["read command template", cfg => { cfg.botNames = ["DifferentBot"]; }],
  ["bot identity", cfg => { cfg.selfUin++; }],
  ["search configuration", cfg => { cfg.tavilyKey = "changed-synthetic-key"; }],
]) test(`${label} changes cannot revive cached evidence after the old configuration is restored`, async () => {
  const cfg = settings();
  const before = globalThis.structuredClone(cfg);
  let reads = 0;
  const session = create({ cfg, recallMemory: () => { reads++; return { status: "ok", text: "OLD_CONFIGURATION_BODY" }; } });
  await invoke(session);
  change(cfg);
  await assert.rejects(invoke(session), { code: "CHAT_TOOL_STOPPED" });
  assert.throws(session.fallbackContext, { code: "CHAT_TOOL_STOPPED" });
  Object.assign(cfg, before);
  await assert.rejects(invoke(session), { code: "CHAT_TOOL_STOPPED" });
  assert.equal(reads, 1);
});

test("live default search configuration and current-message authorization are checked before cache hits", async t => {
  const originalKey = CFG.tavilyKey;
  let searches = 0;
  const options = { scope: GROUP, cfg: settings(), task: "group_chat", userMessage: "search Debian",
    webSearch: () => { searches++; return "raw authorized public evidence"; } };
  const session = createChatToolSession(options);
  const query = call("web_search", { query: "Debian" });
  const declared = session.definitions();
  await session.execute(query, declared);
  options.userMessage = "do not search Debian";
  await assert.rejects(session.execute(query, declared), /permission_changed/);
  assert.throws(session.fallbackContext, /permission_changed/);
  assert.equal(searches, 1);
  const current = create({ webSearch: options.webSearch });
  await current.execute(query, current.definitions());
  t.after(() => { CFG.tavilyKey = originalKey; });
  CFG.tavilyKey = "new-synthetic-default-key";
  await assert.rejects(current.execute(query, current.definitions()), /tool_configuration_changed/);
  assert.equal(searches, 2);
});

test("initially denied and private revoked sessions cannot gain cached or fresh evidence through captured declarations", async () => {
  let reads = 0;
  const cfg = { ...settings(), groupWhitelist: [] };
  const denied = create({ cfg, recallMemory: () => { reads++; return { status: "ok", text: "SHOULD_NOT_RUN" }; } });
  cfg.groupWhitelist = [50139];
  assert.deepEqual(denied.definitions(), []);
  assert.equal(wire(await invoke(denied)).status, "denied");
  const privateCfg = settings();
  const session = create({ cfg: privateCfg, scope: { surface: "private", userId: GROUP.userId },
    recallMemory: () => { reads++; return { status: "ok", text: "PRIVATE_RAW" }; } });
  await invoke(session);
  privateCfg.friendWhitelist = [];
  await assert.rejects(invoke(session), /permission_changed/);
  assert.throws(session.fallbackContext, /permission_changed/);
  assert.equal(reads, 1);
});

test("independent sessions never share cached results across the same owner, other users, groups or private scope", async t => {
  const fixture = notesFixture(t);
  const scopes = [GROUP, { ...GROUP, userId: "60140" }, { ...GROUP, groupId: "50140" },
    { surface: "private", userId: GROUP.userId }, { surface: "private", userId: "60140" }];
  for (const [index, scope] of scopes.entries()) {
    fixture.act({ action: "create", title: "Project", text: "Project SCOPE_BODY_" + index }, scope);
  }
  for (const [index, scope] of scopes.entries()) {
    const session = fixture.session(scope);
    const first = await invoke(session);
    assert.deepEqual(wire(first).items.map(item => item.text), ["Project SCOPE_BODY_" + index]);
    assert.equal((await invoke(session)).content, first.content);
  }
  assert.equal(fixture.state.reads, scopes.length);
  const independent = await invoke(fixture.session());
  assert.match(independent.content, /SCOPE_BODY_0/);
  assert.equal(fixture.state.reads, scopes.length + 1);
  assert.deepEqual(fixture.state.scopes.map(scope => [scope.surface, scope.userId, scope.groupId || "private"]),
    [...scopes, GROUP].map(scope => [scope.surface, scope.userId, scope.groupId || "private"]));
});

test("model and answer-template switches reuse only raw data, refresh status and regenerate model requests", async () => {
  let reads = 0;
  let statusReads = 0;
  const session = create({ recallMemory: () => { reads++; return { status: "ok", text: "RAW_DATA_NOT_AN_ANSWER" }; },
    readBotStatus: (_scope, _args, { provider }) => { statusReads++; return { status: "ok", requestedModel: provider.model }; } });
  const primary = session.prepareModel({ messages: [{ role: "system", content: "PRIMARY_TEMPLATE" }],
    promptMetadata: { promptVersion: "template-a" }, model: "primary-model" });
  const first = await invoke(session, undefined, "read-primary", { model: "primary-model" });
  const primaryStatus = await session.execute(call("read_bot_status", {}), READ_TOOLS, { model: "primary-model" });
  const fallback = session.prepareModel({ messages: [{ role: "system", content: "FALLBACK_TEMPLATE" }, ...session.fallbackContext()],
    promptMetadata: { promptVersion: "template-b" }, model: "fallback-model" });
  const repeated = await invoke(session, undefined, "read-fallback", { model: "fallback-model" });
  const fallbackStatus = await session.execute(call("read_bot_status", {}), READ_TOOLS, { model: "fallback-model" });
  assert.equal(repeated.content, first.content);
  assert.equal(reads, 1);
  assert.equal(statusReads, 2);
  assert.equal(wire(primaryStatus).requestedModel, "primary-model");
  assert.equal(wire(fallbackStatus).requestedModel, "fallback-model");
  assert.equal(primary.model, "primary-model");
  assert.equal(fallback.model, "fallback-model");
  assert.equal(fallback.messages[0].content, "FALLBACK_TEMPLATE");
  assert.match(fallback.messages[1].content, /RAW_DATA_NOT_AN_ANSWER/);
  assert.doesNotMatch(JSON.stringify(session.fallbackContext()), /primary-model|fallback-model|PRIMARY_TEMPLATE|FALLBACK_TEMPLATE/);
  assert.equal(session.fallbackContext()[0].role, "user");
  assert.equal(session.snapshot().modelRounds, 2);
});

test("public search empty results may reuse, but unavailable, blank and invalid results really retry", async () => {
  for (const [first, expected] of [["\u672a\u627e\u5230\u76f8\u5173\u7ed3\u679c", "empty"],
    ["\u641c\u7d22\u6682\u65f6\u4e0d\u53ef\u7528", "unavailable"], [" ", "unavailable"],
    ["\u641c\u7d22\u6682\u65f6\u4e0d\u53ef\u7528 " + "x".repeat(2000), "unavailable"], [undefined, "unavailable"]]) {
    let searches = 0;
    const session = create({ webSearch: () => ++searches === 1 ? first : "fresh raw search evidence" });
    const query = call("web_search", { query: "Debian" });
    const declared = session.definitions();
    assert.equal(wire(await session.execute(query, declared)).status, expected);
    if (expected === "unavailable") assert.deepEqual(session.fallbackContext(), []);
    const repeated = wire(await session.execute(query, declared));
    assert.equal(repeated.status, expected === "empty" ? "empty" : "ok");
    assert.equal(searches, expected === "empty" ? 1 : 2);
  }
});

for (const engine of ["Tavily", "Bing"]) test(`${engine} long formatted searches cache only authorized 1600-character excerpts with an explicit truncation marker`, async t => {
  const originalKey = CFG.tavilyKey;
  CFG.tavilyKey = engine === "Tavily" ? "synthetic-tavily-credential" : "";
  t.after(() => { CFG.tavilyKey = originalKey; });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(options.signal.aborted, false);
    if (engine === "Tavily") {
      assert.equal(String(url), "https://api.tavily.com/search");
      assert.equal(JSON.parse(options.body).query, "Debian");
      return new globalThis.Response(JSON.stringify({ results: [{ title: "SEARCH_TAVILY_HEAD", content: "public evidence" }],
        answer: "useful public detail ".repeat(200) + "DISCARDED_RAW_TAIL" }), { status: 200 });
    }
    assert.equal(new globalThis.URL(url).origin, "https://cn.bing.com");
    assert.equal(new globalThis.URL(url).searchParams.get("q"), "Debian");
    const html = Array.from({ length: 5 }, (_, index) => '<li class="b_algo"><h2><a href="https://example.com/' + index +
      '">SEARCH_BING_HEAD_' + index + " public title ".repeat(40) + (index === 4 ? "DISCARDED_RAW_TAIL" : "") +
      "</a></h2><p>" + "public detail ".repeat(20) + "</p></li>").join("");
    return new globalThis.Response(html, { status: 200 });
  });
  const cfg = settings();
  const session = create({ cfg });
  const declared = session.definitions();
  const query = call("web_search", { query: "Debian" });
  assert.equal(wire(await session.execute(call("web_search", { query: "PRIVATE_NOTE" }), declared)).status, "denied");
  assert.equal(requests, 0);
  const first = await session.execute(query, declared);
  const result = wire(first);
  assert.equal(result.status, "ok");
  assert.equal(result.text.length, 1600);
  assert.equal(result.truncated, true);
  assert.equal(result.source, "public_web");
  assert.equal(result.untrusted, true);
  assert.match(result.text, /SEARCH_(?:TAVILY|BING)_HEAD/);
  assert.doesNotMatch(first.content, /DISCARDED_RAW_TAIL/);
  assert.ok(first.content.length <= LIMITS.resultChars);
  assert.equal((await session.execute(query, declared)).content, first.content);
  assert.equal(requests, 1);
  assert.equal(wire(await session.execute(call("web_search", { query: "Debian", userId: "60140" }), declared)).status, "invalid_arguments");
  assert.equal(requests, 1);
  const exposed = JSON.stringify({ fallback: session.fallbackContext(), snapshot: session.snapshot(), sources: session.sources(), result });
  for (const key of [cfg.tavilyKey, CFG.tavilyKey].filter(Boolean)) assert.equal(exposed.includes(key), false);
  assert.match(exposed, /"truncated":true/);
});

test("search excerpts trim only dangling surrogates at the emoji boundary and cache the truncation marker", async () => {
  const emoji = "\uD83D\uDE00";
  for (const prefixLength of [1598, 1599]) {
    const prefix = "x".repeat(prefixLength);
    let searches = 0;
    const session = create({ webSearch: () => { searches++; return prefix + emoji + "DISCARDED_TAIL"; } });
    const query = call("web_search", { query: "Debian" });
    const declared = session.definitions();
    const first = await session.execute(query, declared);
    const result = wire(first);
    assert.equal(result.status, "ok");
    assert.equal(result.text, prefixLength === 1598 ? prefix + emoji : prefix);
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/u);
    assert.equal(result.truncated, true);
    assert.ok(first.content.length <= LIMITS.resultChars);
    assert.equal((await session.execute(query, declared)).content, first.content);
    assert.equal(searches, 1);
  }
});

test("a truncated search excerpt that still exceeds the packed budget is not cached and a usable retry really executes", async () => {
  let searches = 0;
  const session = create({ webSearch: () => ++searches < 3 ? '"'.repeat(2000) : "fresh bounded search evidence" });
  const query = call("web_search", { query: "Debian" });
  const declared = session.definitions();
  for (let index = 0; index < 2; index++) {
    const response = wire(await session.execute(query, declared));
    assert.equal(response.status, "unavailable");
    assert.equal(response.reason, "result_budget");
    assert.deepEqual(session.fallbackContext(), []);
  }
  assert.equal(searches, 2);
  const fresh = await session.execute(query, declared);
  assert.equal(wire(fresh).text, "fresh bounded search evidence");
  assert.equal(Object.hasOwn(wire(fresh), "truncated"), false);
  assert.equal((await session.execute(query, declared)).content, fresh.content);
  assert.equal(searches, 3);
  assert.ok(session.snapshot().toolOutputChars <= LIMITS.totalResultChars);
});

test("public queries are authorized before dispatch, never from private extras or a forged definition", async () => {
  let searches = 0;
  const session = create({ webSearch: () => { searches++; return "SHOULD_NOT_RUN"; } });
  const declared = session.definitions();
  for (const args of [{ query: "Debian PRIVATE_NOTE" }, { query: "PRIVATE_NOTE" },
    { query: "Debian", userId: "60140" }, { query: "Debian", querySource: "memory" }]) {
    const response = wire(await session.execute(call("web_search", args), declared));
    assert.ok(["denied", "invalid_arguments"].includes(response.status));
  }
  assert.equal(searches, 0);
  assert.deepEqual(session.fallbackContext(), []);
});

test("caller abort rejects cache, fallback and model boundaries without another tool call", async () => {
  const caller = new globalThis.AbortController();
  let reads = 0;
  const session = create({ signal: caller.signal, recallMemory: () => { reads++; return { status: "ok", text: "raw" }; } });
  await invoke(session);
  caller.abort();
  assert.equal(session.signal.aborted, true);
  await assert.rejects(invoke(session), { name: "AbortError" });
  assert.throws(session.fallbackContext, { name: "AbortError" });
  assert.throws(() => session.prepareModel({ messages: [] }), { name: "AbortError" });
  assert.equal(reads, 1);
  const alreadyStopped = create({ signal: caller.signal, recallMemory: () => { reads++; return { status: "ok", text: "late" }; } });
  await assert.rejects(invoke(alreadyStopped), { name: "AbortError" });
  assert.equal(reads, 1);
});

test("caller cancellation reaches an in-flight fake search and blocks its late result from becoming evidence", async () => {
  const caller = new globalThis.AbortController();
  const ready = deferred();
  const response = deferred();
  let searches = 0;
  let toolSignal;
  const session = create({ signal: caller.signal, webSearch: (_query, { signal }) => {
    searches++; toolSignal = signal; ready.resolve(); return response.promise;
  } });
  const pending = session.execute(call("web_search", { query: "Debian" }), session.definitions());
  await ready.promise;
  caller.abort();
  assert.equal(toolSignal.aborted, true);
  response.resolve("LATE_CANCELLED_RAW_BODY");
  await assert.rejects(pending, { name: "AbortError" });
  assert.throws(session.fallbackContext, { name: "AbortError" });
  assert.equal(searches, 1);
});

test("chat-run supersession aborts the tool signal and prevents a same-owner new run from reusing old cache", async () => {
  const cfg = settings();
  const ready = deferred();
  const release = deferred();
  let reads = 0;
  let session;
  const scope = { surface: GROUP.surface, userId: GROUP.userId, groupId: GROUP.groupId };
  const old = withChatRun(scope, async () => {
    session = create({ cfg, recallMemory: () => { reads++; return { status: "ok", text: "OLD_RUN_RAW" }; } });
    await invoke(session);
    ready.resolve();
    await release.promise;
    return await invoke(session);
  }, { cfg });
  await ready.promise;
  await withChatRun(scope, async () => {
    assert.equal(session.signal.aborted, true);
    await assert.rejects(invoke(session), /reply_superseded/);
    return { kind: "silence", text: null };
  }, { cfg });
  release.resolve();
  assert.equal((await old).reason, "reply_superseded");
  assert.throws(session.fallbackContext, /reply_superseded/);
  assert.equal(reads, 1);
});

test("an active chat scope overrides supplied scope and a foreign chat cannot consume that session's cache", async () => {
  const cfg = settings();
  let reads = 0;
  const scope = { surface: GROUP.surface, userId: GROUP.userId, groupId: GROUP.groupId };
  await withChatRun(scope, async () => {
    const session = create({ cfg, scope: { ...GROUP, userId: "60140" }, recallMemory: given => {
      reads++; assert.equal(given.userId, GROUP.userId); return { status: "ok", text: "OWNER_ONLY_RAW" };
    } });
    assert.equal(session.scope.userId, GROUP.userId);
    await invoke(session);
    await withChatRun({ ...scope, userId: "60140", groupId: "50140" }, async () => {
      await assert.rejects(invoke(session), { code: "CHAT_TOOL_STOPPED" });
      assert.throws(session.fallbackContext, { code: "CHAT_TOOL_STOPPED" });
      return { kind: "silence", text: null };
    }, { cfg });
    return { kind: "silence", text: null };
  }, { cfg });
  assert.equal(reads, 1);
});
