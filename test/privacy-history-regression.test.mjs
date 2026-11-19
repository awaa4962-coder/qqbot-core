import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, beforeEach, test } from "node:test";
import sharp from "sharp";

const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, "qqfriend-privacy-history-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") });
const { CFG } = await import("../bridge/config.mjs");
const { flushSavesSync, groupChats, users } = await import("../bridge/storage.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { recordConversationTurn } = await import("../bridge/cognition/index.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { buildInterjectionBackgroundBlock } = await import("../bridge/context-retriever.mjs");
const { executeChatTask } = await import("../bridge/model-router.mjs");
const { aiReply } = await import("../bridge/reply-ai.mjs");
const { pullRecentImages } = await import("../bridge/reply-handlers.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { memoryNotesSnapshot, applyMemoryNoteAction } = await import("../bridge/memory-profile/notes.mjs");
const { summaryRoot } = await import("../bridge/group-summary/state.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");

const groupId = "51180";
const uid = "61180";
const peer = "61181";
const scope = { surface: "group", groupId, userId: uid };
const base = { uid, groupId, userName: "Fixture author", userMsg: "Review the sample image", currentMessageId: "71100" };
const recentUrl = "https://example.invalid/history.png";
const currentUrl = "https://example.invalid/attachment.png";
const privacyFile = path.join(summaryRoot(), "privacy.json");
const tinyTextBudget = { maxMessageChars: 25 };
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer();

function persistCutoff(usersAt = {}) {
  fs.writeFileSync(privacyFile, JSON.stringify({ epoch: 1, users: usersAt }));
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(privacyFile), { recursive: true });
  persistCutoff();
  for (const key of Object.keys(users)) delete users[key];
  groupChats[groupId] = [];
  Object.assign(CFG, { groupWhitelist: [Number(groupId)], friendWhitelist: [Number(uid), Number(peer)], botBlacklist: [], stickerEnabled: false });
});

after(() => {
  cleanupLogger();
  assert.equal(path.dirname(fs.realpathSync(root)), tempParent);
  fs.rmSync(root, { recursive: true, force: true });
});

function archived(messageId, author, text, ts, extra = {}) {
  return { group: groupId, uid: author, nickname: "Fixture author", text, ts, messageId, role: "member", ...extra };
}

function recentImage(extra = {}) {
  const row = archived("71101", peer, "Archived image caption", Date.now() - 2000, { imageUrls: [recentUrl] });
  groupChats[groupId].push(row);
  const source = { kind: "recent", userId: peer, messageId: row.messageId, at: row.ts };
  return { row, options: { ...base, imageAnchor: source, imageSources: [source], imageUrls: [recentUrl], contextBudget: tinyTextBudget, ...extra } };
}

function configureModels(primary = "chat-pixels") {
  for (const [id, capabilities] of [["chat-pixels", ["text", "vision"]], ["chat-text", ["text"]], ["vision-description", ["text", "vision"]]]) {
    saveApiProvider({ id, model: id, presetId: "custom-openai-chat", auth: "none", enabled: true,
      endpoint: "https://example.invalid/" + id, capabilities }, { root });
  }
  saveApiProvider({ id: "deepseek", model: "chat-fallback", presetId: "custom-openai-chat", auth: "none", enabled: true,
    endpoint: "https://example.invalid/chat-fallback", capabilities: ["text"] }, { root });
  saveApiRoutes({ group_chat: { primary, fallback: "deepseek" }, vision: { primary: "vision-description", fallback: null } }, { root });
}

function mockTransport(t, hooks = {}) {
  const downloads = [], calls = [], sends = [];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const address = String(url);
    if ([recentUrl, currentUrl].includes(address)) {
      downloads.push(address);
      hooks.onDownload?.(address);
      return new globalThis.Response(png, { headers: { "content-type": "image/png" } });
    }
    if (address === CFG.napcatApi + "/send_group_msg") {
      assert.equal(typeof hooks.outboundStart, "number", "unexpected outbound chat");
      const body = JSON.parse(request.body);
      assert.equal(String(body.group_id), groupId);
      const id = hooks.outboundStart + sends.length;
      sends.push(id);
      return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: id } }) };
    }
    const body = JSON.parse(request.body);
    assert.ok(["chat-pixels", "chat-text", "chat-fallback", "vision-description"].includes(body.model), "unexpected provider");
    assert.equal(address, "https://example.invalid/" + body.model);
    calls.push(body);
    const text = body.model === "vision-description" ? "A small blue square." : (hooks.answer || "Synthetic answer.");
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
  });
  return { calls, downloads, sends };
}

function runPacket(packet, toolSession) {
  const images = packet.imageInput;
  return executeChatTask({ userMsg: base.userMsg, userName: base.userName, groupId, isAtMe: true, history: packet.messages,
    imageUrls: images.urls, options: { currentUserId: uid, currentInput: packet.currentInput, allowTools: false, toolSession,
      imageSources: images.sources, imageBindings: images.bindings, requiredImageBindings: images.requiredBindings } });
}

test("persisted cutoff overrides stale archives after a partial forget and restart", () => {
  const cutoff = Date.now() - 4000;
  // Only the privacy write survived; the old archive and thread were loaded again.
  persistCutoff({ [peer]: cutoff, [uid]: cutoff });
  groupChats[groupId] = [
    archived("71101", peer, "project erased-group", cutoff),
    archived("71102", peer, "project retained-group", cutoff + 1000),
    archived("71103", "61182", "project derived-from-old", cutoff + 1100, { memorySourceIds: ["71101"] }),
    archived("71104", "61182", "project retained-other", cutoff + 1200),
  ];
  users[uid] = { chats: [archived("71107", uid, "project erased-own", cutoff - 1)] };
  recordConversationTurn({ uid, groupId, messageId: "71108", userText: "project erased-turn", assistantText: "prior answer",
    now: cutoff - 10 }, { save: false });
  for (const mode of ["group-at", "interjection"]) {
    const packet = buildReplyContextPacket({ ...base, mode, userMsg: "project current-input" });
    const text = packet.messages.map(message => message.content).join("\n");
    assert.match(text, /retained-group/);
    assert.match(text, /retained-other/);
    assert.doesNotMatch(text, /erased-|derived-from-old/);
    assert.equal(packet.thread, null);
    assert.match(packet.currentInput, /project current-input/);
  }
  assert.doesNotMatch(buildInterjectionBackgroundBlock(groupId, base), /erased-group|derived-from-old/);
});

test("unreadable privacy state drops old history but leaves admitted current input and attachment usable", async t => {
  configureModels();
  const transport = mockTransport(t);
  const { options } = recentImage();
  fs.writeFileSync(privacyFile, "[");
  const imageOptions = { ...options, imageUrls: [recentUrl, currentUrl], imageSources: [...options.imageSources, { kind: "current", userId: uid }] };
  for (const mode of ["group-at", "interjection"]) {
    const packet = buildReplyContextPacket({ ...imageOptions, mode, contextBudget: undefined });
    assert.deepEqual(packet.messages, []);
    assert.deepEqual(packet.imageInput.urls, [currentUrl]);
    assert.match(packet.currentInput, /Review the sample image/);
  }
  const result = await withChatRun(scope, () => runPacket(buildReplyContextPacket(imageOptions)));
  assert.equal(result.kind, "reply");
  assert.deepEqual(transport.downloads, [currentUrl]);
  assert.equal(transport.calls.length, 1);
  assert.match(JSON.stringify(transport.calls[0].messages), /Review the sample image/);
});

test("a valid image retains its scope and inherited note dependency with all history text pruned", async t => {
  configureModels();
  const transport = mockTransport(t);
  const noteScope = { groupId, userId: peer };
  const note = applyMemoryNoteAction({ ...noteScope, revision: memoryNotesSnapshot(noteScope).revision, action: "create",
    text: "Fixture scope only", title: "Fixture" }, { origin: "user_command", messageId: "71109" });
  assert.equal(note.items.length, 1);
  const { row, options } = recentImage();
  row.memorySourceIds = ["71109"];
  await withChatRun(scope, async () => {
    const packet = buildReplyContextPacket(options);
    assert.deepEqual(packet.messages, []);
    assert.deepEqual(packet.imageInput.requiredBindings, []);
    const result = await runPacket(packet);
    assert.equal(result.kind, "reply");
    assert.ok(result.memorySources.some(source => source.noteId === note.items[0].id));
    assert.equal(result.memoryExpiresAt, row.ts + 300001);
  });
  assert.deepEqual(transport.downloads, [recentUrl]);
  assert.deepEqual(transport.calls.map(call => call.model), ["chat-pixels"]);
});

test("a previously verified quote is checked again before download, without losing the current attachment", async t => {
  configureModels();
  const transport = mockTransport(t);
  const at = Date.now() - 600000;
  const quote = { state: "verified", groupId, messageId: "71102", userId: peer, at };
  const options = { ...base, replyToMessageId: quote.messageId, quoteEvidence: quote, contextBudget: tinyTextBudget,
    imageUrls: [currentUrl, recentUrl], imageSources: [{ kind: "current", userId: uid }, { kind: "quote", messageId: quote.messageId, userId: peer }] };
  const result = await withChatRun(scope, () => {
    const packet = buildReplyContextPacket(options);
    assert.deepEqual(packet.imageInput.urls, [currentUrl, recentUrl]);
    persistCutoff({ [peer]: at });
    return runPacket(packet);
  });
  assert.equal(result.kind, "reply");
  assert.deepEqual(transport.downloads, [currentUrl]);
  assert.deepEqual(transport.calls.map(call => call.model), ["chat-pixels"]);
});

test("history invalidated during download never reaches the description model", async t => {
  configureModels("chat-text");
  const { row, options } = recentImage();
  const transport = mockTransport(t, { onDownload() { row.recalled = true; } });
  const result = await withChatRun(scope, () => runPacket(buildReplyContextPacket(options)));
  assert.equal(result.kind, "cancelled");
  assert.deepEqual(transport.downloads, [recentUrl]);
  assert.deepEqual(transport.calls, []);
});

test("history that expires after description and request composition never reaches ordinary model transport", async t => {
  configureModels("chat-text");
  const transport = mockTransport(t);
  const { row, options } = recentImage();
  const result = await withChatRun(scope, () => {
    const toolSession = createChatToolSession({ scope, task: "group_chat", userMessage: base.userMsg, allowTools: false });
    const prepareModel = toolSession.prepareModel;
    t.mock.method(toolSession, "prepareModel", request => {
      const prepared = prepareModel(request);
      t.mock.method(Date, "now", () => row.ts + 300001);
      return prepared;
    });
    return runPacket(buildReplyContextPacket(options), toolSession);
  });
  assert.equal(result.kind, "cancelled");
  assert.equal(result.reason, "memory_expired");
  assert.deepEqual(transport.downloads, [recentUrl]);
  assert.deepEqual(transport.calls.map(call => call.model), ["vision-description"]);
});

function peerImageRuntime(kind) {
  if (kind === "recent") {
    const { row, options } = recentImage();
    return { row, source: options.imageAnchor, runtime: { imageAnchor: options.imageAnchor, imageSources: options.imageSources } };
  }
  const source = { kind, userId: peer, messageId: "71201", at: Date.now() - 600000 };
  return { source, runtime: { replyToMessageId: source.messageId, replyUserId: peer, imageSources: [source],
    quoteEvidence: { ...source, groupId, state: "verified" } } };
}

function sendChat(messageId, question, urls, runtime = {}) {
  return aiReply(groupId, uid, question, base.userName, urls, null, "", true, [], {
    messageId, eventTime: Date.now(), ...runtime,
  });
}

function storedTurns() { return users[uid].cognition.threads[groupId].turns; }

for (const [kind, id] of [["recent", 71210], ["quote", 71310]]) {
  test(kind + " image erasure invalidates the collaborator's sent and inherited turns after reload", async t => {
    configureModels();
    const marker = "Sample image shows a cobalt fixture.";
    const transport = mockTransport(t, { answer: marker, outboundStart: id + 40 });
    const image = peerImageRuntime(kind);
    await sendChat(id, "Review the sample image", [recentUrl], image.runtime);
    assert.deepEqual(storedTurns()[0].historicalImageSources, [image.source]);
    await sendChat(id + 1, "Review the sample image again", []);
    assert.equal(storedTurns().length, 2);
    assert.deepEqual(storedTurns()[1].historicalImageSources, [image.source]);
    assert.match(JSON.stringify(transport.calls[1].messages), /cobalt fixture/);
    assert.deepEqual(transport.downloads, [recentUrl]);
    assert.deepEqual(transport.sends, [id + 40, id + 41]);
    assert.equal(flushSavesSync({ durable: true }), true);
    users[uid] = JSON.parse(fs.readFileSync(CFG.memoryFile, "utf8"))[uid];
    if (image.row) {
      image.row.recalled = true;
      assert.equal(buildReplyContextPacket(base).thread, null);
      delete image.row.recalled;
    }
    persistCutoff({ [peer]: image.source.at });
    await sendChat(id + 2, "Review the sample image again", []);
    assert.doesNotMatch(JSON.stringify(transport.calls[2].messages), /cobalt fixture/);
    const savedReplyId = String(id + 40);
    const packet = buildReplyContextPacket({ ...base, replyToMessageId: savedReplyId, replyUserId: String(CFG.selfUin), replyText: marker,
      quoteEvidence: { state: "verified", groupId, messageId: savedReplyId, userId: String(CFG.selfUin), at: Date.now() } });
    assert.doesNotMatch(JSON.stringify(packet.messages), /cobalt fixture/);
    assert.match(packet.currentInput, /Review the sample image/);
  });
}

test("legacy group turns with unknown image provenance are not recalled", () => {
  recordConversationTurn({ uid, groupId, messageId: "71420", userText: base.userMsg, assistantText: "Legacy fixture answer" }, { save: false });
  delete storedTurns()[0].historicalImageSources;
  const packet = buildReplyContextPacket(base);
  assert.equal(packet.thread, null);
  assert.doesNotMatch(JSON.stringify(packet.messages), /Legacy fixture answer/);
});

test("recent image selection skips the newest erased descendant and chooses an eligible backup", () => {
  const cutoff = Date.now() - 4000;
  persistCutoff({ [peer]: cutoff });
  groupChats[groupId] = [
    archived("71400", peer, "Erased parent", cutoff),
    archived("71401", uid, "Eligible backup image", cutoff + 1000, { imageUrls: [currentUrl] }),
    ...Array.from({ length: 120 }, (_, index) => archived(String(71402 + index), uid, "Derived image", cutoff + 2000,
      { imageUrls: [recentUrl], memorySourceIds: ["71400"] })),
  ];
  const selected = [];
  const opts = { ...base, onSource: source => selected.push(source.messageId) };
  assert.deepEqual(pullRecentImages(groupId, opts), [currentUrl]);
  assert.deepEqual(selected, ["71401"]);
  assert.deepEqual(pullRecentImages(groupId, { ...opts, replyToMessageId: "71402" }), []);
});
