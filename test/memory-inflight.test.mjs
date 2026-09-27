import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-inflight-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { getMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { aiReply } = await import("../bridge/reply-ai.mjs");
const { privateReply, handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { executeChatTask } = await import("../bridge/model-router.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { runScopedChat } = await import("../bridge/chat-tools/runner.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { recordConversationTurn, getConversationThread, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");
const { chatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const { createTraceRecorder, traceStage, withMessageTrace } = await import("../bridge/diagnostics/message-trace.mjs");
const UID = "60231";
const PEER = "60232";
const GROUP = "50231";
let nextId = 80231;
CFG.groupWhitelist = [Number(GROUP)]; CFG.friendWhitelist = [Number(UID), Number(PEER)]; CFG.botBlacklist = [];
CFG.stickerEnabled = false; CFG.legacyProfileRefreshEnabled = false;
for (const id of ["expiry-primary", "deepseek"]) {
  saveApiProvider({ id, presetId: "custom-openai-chat", model: id, endpoint: "https://example.com/" + id,
    auth: "none", enabled: true, capabilities: ["text", "tools"] }, { root });
}
saveApiRoutes(Object.fromEntries(["group_chat", "private_chat", "file_chat", "interjection"].map(task =>
  [task, { primary: "expiry-primary", fallback: "deepseek" }])), { root });
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const modelReply = message => response({ choices: [{ message }] });

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t, groupId = GROUP) {
  const scope = { userId: UID, groupId };
  const state = { now: Date.now(), models: 0, sends: 0 };
  const service = createMemoryNoteService({ profiles: {}, available: () => true, now: () => state.now,
    persist: () => true, readPrivacy: () => ({ users: {} }) });
  for (const method of ["snapshot", "corrections", "metadata"]) t.mock.method(memoryNoteService, method, service[method]);
  t.mock.method(Date, "now", () => state.now);
  users[UID] = { uid: UID, nicknames: ["Synthetic owner"], chats: [] };
  users[PEER] = { uid: PEER, nicknames: ["Synthetic peer"], chats: [] };
  groupChats[GROUP] = [];
  const act = (payload, messageId = "70231") => service.act({ ...scope, revision: service.snapshot(scope).revision, ...payload },
    { origin: "user_command", messageId });
  const note = act({ action: "create", title: "Project", text: "Project MEMORY_INFLIGHT_SENTINEL", ttlDays: 1 }).items[0];
  state.now = note.expiresAt - 1000;
  const generation = getMemoryPrivacyGeneration();
  const expire = () => { state.now = note.expiresAt; assert.equal(getMemoryPrivacyGeneration(), generation); };
  t.after(() => { delete users[UID]; delete users[PEER]; delete groupChats[GROUP]; resetCognitionForTest(); });
  return { scope, state, service, act, note, expire };
}

async function tracedReply(f, surface) {
  const messageId = nextId++;
  const recorder = createTraceRecorder();
  let result;
  await withMessageTrace({ message_type: surface, group_id: GROUP, user_id: UID, message_id: messageId }, async () => {
    traceStage("route", { status: "ok", route: surface === "group" ? "group_at" : "private_chat" });
    result = surface === "group"
      ? await aiReply(GROUP, UID, "Project", "Synthetic owner", [], messageId, "", true, [], { messageId })
      : await privateReply(UID, "Project");
  }, recorder);
  assert.equal(getConversationThread(UID, f.scope.groupId), null);
  return { trace: recorder.list().items[0], result, messageId };
}

for (const surface of ["group", "private"]) {
  test(`${surface}: note expiry during the actual model call stops reply, fallback and thread creation`, async t => {
    const f = fixture(t, surface === "private" ? "private" : GROUP);
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), "https://example.com/expiry-primary", "no QQ send or fallback after expiry");
      f.state.models++;
      assert.match(options.body, /MEMORY_INFLIGHT_SENTINEL/);
      f.expire();
      return modelReply({ content: "Project stale model answer", reasoning_content: "PRIVATE_REASONING_SENTINEL" });
    });
    const { trace, result } = await tracedReply(f, surface);
    assert.equal(result.kind, "cancelled"); assert.equal(result.reason, "memory_expired");
    assert.equal(f.state.models, 1); assert.equal(trace.sends, 0);
    assert.equal(trace.status, "cancelled"); assert.equal(trace.reason, "memory_expired");
    assert.doesNotMatch(JSON.stringify(trace), /MEMORY_INFLIGHT_SENTINEL|PRIVATE_REASONING_SENTINEL|stale model answer/);
  });

  test(`${surface}: expiry after first acknowledged chunk preserves partial delivery and prevents remaining chunks`, async t => {
    const f = fixture(t, surface === "private" ? "private" : GROUP);
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).startsWith("https://example.com/")) {
        f.state.models++; assert.match(options.body, /MEMORY_INFLIGHT_SENTINEL/);
        return modelReply({ content: "这是一段合成验收正文。".repeat(260) });
      }
      assert.ok(String(url).endsWith(surface === "group" ? "/send_group_msg" : "/send_private_msg"));
      f.state.sends++; f.expire();
      return response({ status: "ok", retcode: 0, data: { message_id: 90231 } });
    });
    const { trace, result, messageId } = await tracedReply(f, surface);
    assert.equal(result.kind, "cancelled"); assert.equal(f.state.models, 1); assert.equal(f.state.sends, 1);
    assert.equal(trace.status, "partial"); assert.equal(trace.reason, "memory_expired");
    if (surface === "group") {
      const row = chatDeliveryLedger().find({ surface, groupId: GROUP, userId: UID, messageId });
      assert.equal(row.status, "partial"); assert.equal(row.confirmed, 1);
      const ledger = JSON.parse(fs.readFileSync(path.join(CFG.dataRoot, ".qqfriend", "chat-delivery.json"), "utf8"));
      assert.ok(Object.values(ledger.records).every(item => item.pending === 0));
    }
  });
}

test("private file entrypoint with injected model also obeys selected note expiry", async t => {
  const f = fixture(t, "private");
  t.mock.method(globalThis, "fetch", () => assert.fail("no network is allowed for this injected file test"));
  await handlePrivateMessage({ message_type: "private", user_id: Number(UID), message_id: nextId++, nickname: "Synthetic owner",
    text: "Project: compare this file", images: [], files: [{ name: "project.txt", url: "https://example.com/file" }] }, {
    fetchEvidence: async () => ({ status: "ok", text: "SYNTHETIC_FILE_BODY" }),
    executeChatTask: async request => {
      assert.match(JSON.stringify(request.history), /SYNTHETIC_FILE_BODY/);
      assert.match(JSON.stringify(request.history), /MEMORY_INFLIGHT_SENTINEL/);
      f.state.models++; f.expire(); return { kind: "reply", text: "stale file answer" };
    },
    sendPrivateMsg: async () => assert.fail("expired file reply must not be sent"),
  });
  assert.equal(f.state.models, 1); assert.equal(getConversationThread(UID, "private"), null);
});

test("tool-only note recall is tracked even without initial history or AsyncLocalStorage run", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://example.com/expiry-primary");
    f.state.models++;
    if (f.state.models === 1) {
      assert.doesNotMatch(options.body, /MEMORY_INFLIGHT_SENTINEL/);
      return modelReply({ content: null, tool_calls: [{ id: "read-note", type: "function", function: {
        name: "recall_memory", arguments: '{"query":"Project"}',
      } }] });
    }
    assert.match(options.body, /MEMORY_INFLIGHT_SENTINEL/);
    f.expire(); return modelReply({ content: "stale tool answer" });
  });
  const result = await executeChatTask({ userMsg: "Project", userName: "Synthetic owner", groupId: GROUP, isAtMe: true,
    history: [], options: { currentUserId: UID } });
  assert.equal(result.kind, "cancelled"); assert.equal(result.reason, "memory_expired"); assert.equal(f.state.models, 2);
});

test("prebuilt expired context cannot start vision, search or model calls outside an active run", async t => {
  const f = fixture(t);
  const packet = buildReplyContextPacket({ uid: UID, groupId: GROUP, mode: "group-at", userMsg: "Project" });
  assert.equal(packet.memorySources.length, 1);
  const session = createChatToolSession({ scope: { surface: "group", ...f.scope }, cfg: CFG });
  f.expire();
  t.mock.method(globalThis, "fetch", () => assert.fail("expired context must not reach transport"));
  const result = await runScopedChat({ messages: packet.messages }, { providerId: "expiry-primary", toolSession: session,
    task: "group_chat", userMessage: "Project", visionSession: { message: () => assert.fail("expired context must not launch vision") } });
  assert.equal(result.kind, "cancelled"); assert.equal(result.reason, "memory_expired");
});

for (const change of ["correction", "deletion", "expiry"]) {
  test(`cross-author group quote and later paraphrases invalidate after ${change} without sharing private notes`, t => {
    const f = fixture(t);
    const base = { uid: PEER, groupId: GROUP, mode: "group-at", userMsg: "Project?", currentMessageId: String(nextId++),
      replyToMessageId: "70231", replyUserId: UID, replyText: f.note.text, replySpeaker: "Synthetic owner",
      quoteEvidence: { state: "verified", userId: UID, messageId: "70231", at: f.note.source.at } };
    const packet = buildReplyContextPacket(base);
    const deps = [{ noteId: f.note.id, revision: 1 }];
    assert.deepEqual(packet.memorySources, deps);
    assert.equal(f.service.snapshot({ userId: PEER, groupId: GROUP }).items.length, 0);
    recordConversationTurn({ uid: PEER, groupId: GROUP, messageId: base.currentMessageId, userText: "Project?",
      assistantText: "Project DERIVED_QUOTE_SENTINEL", memorySources: deps, now: f.state.now }, { save: false });
    const continuation = () => buildReplyContextPacket({ uid: PEER, groupId: GROUP, mode: "group-at", userMsg: "继续" });
    const next = continuation();
    assert.match(JSON.stringify(next.messages), /DERIVED_QUOTE_SENTINEL/);
    assert.deepEqual(next.memorySources, deps);
    recordConversationTurn({ uid: PEER, groupId: GROUP, messageId: String(nextId++), userText: "继续",
      assistantText: "ANOTHER_DERIVED_QUOTE_SENTINEL", memorySources: next.memorySources, now: f.state.now }, { save: false });
    if (change === "correction") f.act({ action: "update", id: f.note.id, text: "Project NEW_NOTE" }, "70232");
    else if (change === "deletion") f.act({ action: "remove", id: f.note.id });
    else f.expire();
    const current = continuation();
    assert.doesNotMatch(JSON.stringify(current.messages), /DERIVED_QUOTE_SENTINEL|MEMORY_INFLIGHT_SENTINEL/);
    assert.deepEqual(current.memorySources, []);
  });
}

test("linked raw group history and tool recall inherit a peer note even when its original message is absent", t => {
  const f = fixture(t);
  const rows = [
    { uid: PEER, nickname: "Synthetic peer", group: GROUP, messageId: "70332", replyToMessageId: "70231", text: "Project CHILD_SENTINEL", ts: f.state.now - 200 },
    { uid: PEER, nickname: "Synthetic peer", group: GROUP, messageId: "70333", replyToMessageId: "70332", turnId: "70334", text: "Project GRANDCHILD_SENTINEL", ts: f.state.now - 100 },
    { uid: PEER, nickname: "Synthetic peer", group: GROUP, messageId: "70334", replyToMessageId: "70333", text: "Project CYCLE_SENTINEL", ts: f.state.now - 50 },
  ];
  groupChats[GROUP] = rows; users[PEER].chats = rows;
  const packet = buildReplyContextPacket({ uid: PEER, groupId: GROUP, mode: "group-at", userMsg: "Project" });
  assert.match(JSON.stringify(packet.messages), /GRANDCHILD_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(packet.messages), /MEMORY_INFLIGHT_SENTINEL/);
  const deps = [{ noteId: f.note.id, revision: 1 }];
  assert.deepEqual(packet.memorySources, deps);
  const recalled = recallMemory({ surface: "group", userId: PEER, groupId: GROUP }, { query: "Project", kind: "history" });
  assert.equal(recalled.status, "ok"); assert.deepEqual(recalled.memorySources, deps);
  assert.doesNotMatch(JSON.stringify(recalled), /MEMORY_INFLIGHT_SENTINEL/);
  f.expire();
  assert.equal(recallMemory({ surface: "group", userId: PEER, groupId: GROUP }, { query: "Project", kind: "history" }).status, "empty");
});
