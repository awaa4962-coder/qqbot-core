import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { after, beforeEach, mock, test } from "node:test";
import sharp from "sharp";
import { P5_FIXTURE as F, P5_QUALITY_MATRIX, P5_MODEL_PROBES, P5_REVIEW_POLICY, P5_BITMAP_LABELS,
  p5SyntheticConfig, buildP5ProbePacket, createP5ProbeRecord, getP5QualityFixtures } from "../scripts/p5-quality-fixtures.mjs";

const tempRoot = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempRoot, "qqfriend-p5-matrix-"));
const environment = { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") };
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const network = mock.method(globalThis, "fetch", () => assert.fail("P5 forbids real network, paid APIs and QQ sends"));

const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { validateQuotedReply } = await import("../bridge/context/quoted-reply.mjs");
const { createMemoryNoteService, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { recallMemory } = await import("../bridge/chat-tools/read.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { READ_TOOLS } = await import("../bridge/chat-tools/policy.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { withChatRun, noteChatOutcome } = await import("../bridge/cognition/chat-run.mjs");
const { recordConversationTurn, getConversationThread, resetCognitionForTest, isSuccessfulOutbound } =
  await import("../bridge/cognition/index.mjs");
const { createChatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const { sendTextToGroup, sendTextToPrivate } = await import("../bridge/outbound-message.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { createVisionSession } = await import("../bridge/vision/session.mjs");
const { runReplayChecks } = await import("../bridge/diagnostics/replay.mjs");
const { parseChatOutcome } = await import("../bridge/chat-outcome.mjs");

const previousConfig = { ...CFG };
const scope = surface => ({ surface, userId: F.userId, ...(surface === "group" ? { groupId: F.groupId } : {}) });
const call = (name, args, id = "p5-read") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const response = message => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message }] }) });
const matrixCoverage = new Set();
const cover = (...ids) => ids.forEach(id => matrixCoverage.add(id));
const wireFacts = body => JSON.parse(body.messages.find(item => typeof item.content === "string" &&
  item.content.startsWith("[\u672c\u8f6e\u673a\u5668\u4eba\u8fd0\u884c\u4e8b\u5b9e]")).content.split("\n").at(-1));
const imageParts = body => body.messages.flatMap(item => Array.isArray(item.content)
  ? item.content.filter(part => part.type === "image_url") : []);

function configure(primaryVision = false) {
  Object.assign(CFG, p5SyntheticConfig());
  for (const [id, model] of [["p5-primary", "p5-primary-model"], ["deepseek", "p5-fallback-model"]]) {
    saveApiProvider({ id, model, presetId: "custom-openai-chat", auth: "none", enabled: true,
      endpoint: "https://p5-model.invalid/" + model,
      capabilities: ["text", "tools", ...(primaryVision && id === "p5-primary" ? ["vision"] : [])] }, { root });
  }
  saveApiRoutes(Object.fromEntries(["group_chat", "private_chat", "file_chat", "interjection"].map(task =>
    [task, { primary: "p5-primary", fallback: "deepseek" }])), { root });
}

beforeEach(() => {
  configure();
  resetCognitionForTest();
  for (const id of [F.userId, F.peerId]) users[id] = { uid: id, nicknames: [F.sameName], chats: [] };
  groupChats[F.groupId] = [];
});

after(() => {
  try { assert.equal(network.mock.callCount(), 0, "all transports must be explicit local stubs"); }
  finally {
    mock.restoreAll();
    Object.assign(CFG, previousConfig);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(fs.realpathSync(root)), tempRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function captureModels(t, answer) {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).origin, "https://p5-model.invalid", "unexpected network/QQ path");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.ok(["p5-primary-model", "p5-fallback-model"].includes(body.model));
    bodies.push(body);
    return response(await answer(body, bodies));
  });
  return bodies;
}

function packet(extra = {}) {
  return buildReplyContextPacket({ uid: F.userId, groupId: F.groupId, userName: F.sameName,
    userMsg: "Project", currentMessageId: F.currentMessageId, mode: "group-at", ...extra });
}

function request(context, extra = {}) {
  return { userMsg: "Project", userName: F.sameName, groupId: F.groupId, isAtMe: true, history: context.messages,
    options: { currentUserId: F.userId, currentInput: context.currentInput, personaCue: "none" }, ...extra };
}

async function execute(surface, input) {
  return surface === "group" ? executeChatTask(input) : executePrivateChatTask({ ...input, groupId: null,
    ...(surface === "file" ? { task: "file_chat" } : {}) });
}

function memoryFixture(t, groupId = F.groupId) {
  const state = { now: F.now };
  const service = createMemoryNoteService({ profiles: {}, available: () => true, persist: () => true,
    now: () => state.now, readPrivacy: () => ({ users: {} }) });
  for (const method of ["snapshot", "corrections", "metadata"]) t.mock.method(memoryNoteService, method, service[method]);
  t.mock.method(Date, "now", () => state.now);
  const target = { userId: F.userId, groupId };
  const act = (payload, messageId = F.noteSourceId) => service.act({ ...target,
    revision: service.snapshot(target).revision, ...payload }, { origin: "user_command", messageId });
  const note = act({ action: "create", title: "Project", text: F.obsolete, ttlDays: 1 }).items[0];
  act({ action: "create", title: "Project control", text: F.independent, ttlDays: 90 }, "70153");
  state.now = note.expiresAt - 1000;
  const source = { noteId: note.id, revision: 1 };
  const readScope = { surface: groupId === "private" ? "private" : "group", userId: F.userId, groupId };
  const read = () => recallMemory(readScope, { query: "Project", kind: "both", limit: 6 }, {
    cfg: CFG, now: () => state.now, snapshot: service.snapshot, corrections: service.corrections,
    users, readPrivacy: () => ({ users: {} }) });
  const session = createChatToolSession({ scope: readScope, cfg: CFG, task: groupId === "private" ? "private_chat" : "group_chat",
    userMessage: "Project", memoryRead: service.metadata, recallMemory: read });
  recordConversationTurn({ uid: F.userId, groupId, messageId: "70154", userText: "\u7ee7\u7eed",
    assistantText: F.obsolete + " derived answer", memorySources: [source], now: state.now }, { save: false });
  return { state, service, target, note, source, readScope, read, act, session,
    context: () => packet({ groupId, mode: groupId === "private" ? "private" : "group-at", userMsg: "\u7ee7\u7eed Project" }) };
}

test("matrix and human probe schema do not predeclare semantic success or fabricated usage", async () => {
  assert.equal(P5_MODEL_PROBES.length, 8);
  assert.equal(new Set(P5_MODEL_PROBES.map(item => item.id)).size, 8);
  assert.equal(P5_REVIEW_POLICY.method, "human");
  const ids = new Set(P5_QUALITY_MATRIX.map(item => item.id));
  for (const probe of P5_MODEL_PROBES) {
    assert.ok(probe.covers.every(id => ids.has(id)));
    const built = await buildP5ProbePacket(probe);
    const record = createP5ProbeRecord(probe, built);
    assert.equal(record.review.verdict, "not_verified");
    assert.ok(Object.values(record.review.scores).every(value => value === null));
    assert.ok(Object.values(record.review.blockers).every(value => value === "unknown"));
    for (const entry of [record.baseline, record.candidate]) {
      assert.equal(entry.status, "not_run"); assert.equal(entry.cleanedFinalText, null);
      assert.ok(Object.values(entry.calls).every(value => value === null));
      assert.ok(Object.values(entry.usage.reported).every(value => value === false));
      assert.deepEqual(entry.usage.attempts, []);
      for (const field of ["promptTokens", "cachedTokens", "completionTokens", "reasoningTokens", "totalTokens", "durationMs"])
        assert.equal(entry.usage[field], null);
    }
    assert.notEqual(record.baseline.usage, record.candidate.usage);
  }
});

test("parent helper exposes only stable id/history/input/bitmap/rubric, keeping original four exact semantics", async () => {
  const fixtures = await getP5QualityFixtures();
  assert.equal(fixtures.length, 8);
  const originals = [
    { quote: "\u6211\u8003\u8bd5\u6ca1\u8fc7", input: "\u8fd9\u53e5\u662f\u4ec0\u4e48\u610f\u601d\uff1f", bitmap: "good" },
    { quote: "\u6211\u8003\u8bd5\u901a\u8fc7\u4e86", input: "\u8fd9\u53e5\u662f\u4ec0\u4e48\u610f\u601d\uff1f", bitmap: "good" },
    { quote: "\u6211\u521a\u7834\u4e86\u4e2a\u4eba\u7eaa\u5f55", input: "\u4e00\u53e5\u8bdd\u89e3\u91ca\u8fd9\u56fe", bitmap: "terrible" },
    { quote: "\u5148\u91cd\u542f\u518d\u8bd5", input: "\u91cd\u542f\u8bd5\u4e86\u8fd8\u662f\u4e0d\u884c\uff0c\u4e0b\u4e00\u6b65\u5462\uff1f", bitmap: null },
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(Object.keys(fixture), ["id", "history", "input", "bitmap", "rubric"]);
    assert.ok(["good", "terrible", null].includes(fixture.bitmap));
    assert.ok(fixture.history.every(item => item.role === "user"));
    for (const text of Object.values(P5_BITMAP_LABELS)) assert.ok(!JSON.stringify(fixture.history).includes(text));
  }
  for (const [index, original] of originals.entries()) {
    assert.equal(fixtures[index].input, original.input);
    assert.equal(fixtures[index].bitmap, original.bitmap);
    assert.ok(fixtures[index].history.some(item => item.content.includes("message=" + original.quote + "\n")));
  }
  assert.deepEqual(fixtures[4].history, [], "unknown direction has no fabricated surrounding context");
  fixtures[0].history[0].content = "consumer mutation";
  assert.notEqual((await getP5QualityFixtures())[0].history[0].content, "consumer mutation");
});

test("original replay13 remains an independent offline boundary check", () => {
  const result = runReplayChecks();
  assert.equal(result.checks.length, 13); assert.equal(result.ok, true);
  assert.equal(result.callsModel, false); assert.equal(result.sendsMessage, false);
});

for (const probe of P5_MODEL_PROBES) test("fixed probe composition, not a semantic judge: " + probe.id, async () => {
  const built = await buildP5ProbePacket(probe);
  const repeat = await buildP5ProbePacket(probe);
  assert.equal(built.fingerprint, repeat.fingerprint);
  assert.ok(built.budget.chars <= built.budget.maxChars);
  assert.ok(built.messages.at(-1).content.includes(probe.input));
  assert.ok(built.messages.at(-1).content.includes("uid=" + F.userId));
  assert.deepEqual(built.messages.map(item => Object.keys(item).sort()), built.messages.map(() => ["content", "role"]));
  assert.equal(built.callsModel, false); assert.equal(built.sendsMessage, false);
  if (probe.quote?.source.state === "unavailable") assert.deepEqual(built.sources, []);
});

test("identity-quote: actual group and interjection composition keep same-name IDs and source identity", async t => {
  const probe = P5_MODEL_PROBES.find(item => item.id === "same-name-quote");
  const evidence = validateQuotedReply({ message_type: "group", group_id: F.groupId, user_id: F.userId,
    message_id: F.currentMessageId, replyData: { id: F.quoteId } }, { text: probe.quote.text, images: [],
    source: { messageType: "group", groupId: F.groupId, userId: F.peerId, messageId: F.quoteId, time: Math.floor(Date.now() / 1000) - 1 } });
  assert.equal(evidence.state, "verified");
  const bodies = captureModels(t, body => ({ content: body.tools ? "synthetic final" : '{"reply":""}' }));
  for (const mode of ["group-at", "interjection"]) {
    const context = packet({ mode, userMsg: probe.input, replyText: probe.quote.text, replyToMessageId: F.quoteId,
      replyUserId: F.peerId, replySpeaker: F.sameName, quoteEvidence: evidence });
    assert.equal(context.metadata.hasQuotedMessage, true);
    assert.ok(context.retrieval.sources.some(item => item.kind === "quote" && item.userId === F.peerId && item.verified));
    await executeChatTask(request(context, { userMsg: probe.input, isAtMe: mode === "group-at",
      options: { currentUserId: F.userId, currentInput: context.currentInput, replyMode: mode === "interjection" ? "interjection" : "chat" } }));
    const wire = bodies.at(-1);
    assert.ok(wire.messages.at(-1).content.includes("uid=" + F.userId));
    const quoted = wire.messages.find(item => item.content?.startsWith("[\u88ab\u56de\u590d\u6d88\u606f]"));
    assert.ok(quoted.content.includes("speaker=" + F.sameName + " uid=" + F.peerId));
    assert.ok(quoted.content.includes(probe.quote.text));
  }
  cover("identity-quote");
});

test("missing-source: group/interjection never rehydrate rejected quote from nearby histories", () => {
  users[F.userId].chats = [{ group: F.groupId, messageId: F.quoteId, text: "NEARBY_NOT_QUOTE", ts: Date.now() }];
  groupChats[F.groupId] = [{ uid: F.peerId, messageId: F.quoteId, text: "NEARBY_NOT_QUOTE", ts: Date.now() }];
  for (const mode of ["group-at", "interjection"]) {
    const context = packet({ mode, userMsg: "\u539f\u8bdd\u5462\uff1f", replyToMessageId: F.quoteId,
      replyText: "REJECTED_QUOTE_BODY", quoteEvidence: { state: "unavailable", reason: "quote_forgotten" } });
    assert.equal(context.metadata.hasQuotedMessage, false);
    assert.deepEqual(context.retrieval.sources, []);
    assert.ok(!JSON.stringify(context.messages).includes("NEARBY_NOT_QUOTE"));
    assert.ok(!JSON.stringify(context.messages).includes("REJECTED_QUOTE_BODY"));
    assert.equal(context.thread, null);
  }
  cover("missing-source");
});

test("current-priority: group/private/file keep compound current input last and recognized topic switch exits old task", async t => {
  const probe = P5_MODEL_PROBES.find(item => item.id === "current-correction-topic");
  const bodies = captureModels(t, () => ({ content: "synthetic answer" }));
  for (const surface of ["group", "private", "file"]) {
    const groupId = surface === "group" ? F.groupId : "private";
    recordConversationTurn({ uid: F.userId, groupId, messageId: "70155", userText: "\u4e0b\u8f7d\u5931\u8d25",
      assistantText: "OBSOLETE_DOWNLOAD_ADVICE", memorySources: [], memoryExpiresAt: null, now: Date.now() }, { save: false });
    const continuing = packet({ groupId, mode: surface === "group" ? "group-at" : "private", userMsg: "\u7ee7\u7eed" });
    assert.ok(JSON.stringify(continuing.messages).includes("OBSOLETE_DOWNLOAD_ADVICE"), "control must retain a live old task before switching");
    const context = packet({ groupId, mode: surface === "file" ? "private-file" : surface === "private" ? "private" : "group-at", userMsg: probe.input });
    assert.equal(context.thread, null);
    await execute(surface, request(context, { userMsg: probe.input }));
    const body = bodies.at(-1);
    assert.equal(body.messages.at(-1).content, context.currentInput);
    assert.ok(body.messages.at(-1).content.includes(probe.input));
    assert.ok(!JSON.stringify(body.messages).includes("OBSOLETE_DOWNLOAD_ADVICE"));
    const switchedInput = "\u5148\u4e0d\u804a\u4e0b\u8f7d\u4e86\uff0c\u6362\u4e2a\u8bdd\u9898\uff0c17 \u52a0 25 \u662f\u591a\u5c11\uff1f";
    const switched = packet({ groupId, mode: surface === "group" ? "group-at" : "private", userMsg: switchedInput });
    assert.equal(switched.thread, null);
    await execute(surface, request(switched, { userMsg: switchedInput }));
    assert.equal(bodies.at(-1).messages.at(-1).content, switched.currentInput);
    assert.ok(!JSON.stringify(bodies.at(-1).messages).includes("OBSOLETE_DOWNLOAD_ADVICE"));
  }
  assert.equal(bodies.length, 6);
  cover("current-priority");
});

test("failed-step: production thread and current failed advice feedback reach actual transport together", async t => {
  const previous = F.failedTurns[0];
  recordConversationTurn({ uid: F.userId, groupId: F.groupId, messageId: "70156", userText: previous.userSummary,
    assistantText: previous.assistantSummary, assistantMessageIds: ["70160"], memorySources: [], memoryExpiresAt: null,
    now: Date.now() }, { save: false });
  const context = packet({ userMsg: F.failedInput, replyText: previous.assistantSummary,
    replyToMessageId: "70160", replyUserId: F.botId, quoteEvidence: { state: "verified", source: "onebot",
      userId: F.botId, messageId: "70160", groupId: F.groupId, at: Date.now() } });
  assert.ok(context.retrieval.sources.some(item => item.kind === "thread"));
  const bodies = captureModels(t, () => ({ content: "synthetic next question" }));
  await executeChatTask(request(context, { userMsg: F.failedInput }));
  assert.equal(bodies.length, 1);
  assert.ok(JSON.stringify(bodies[0].messages).includes(previous.assistantSummary));
  assert.ok(bodies[0].messages.at(-1).content.includes(F.failedInput));
  cover("failed-step");
});

for (const change of ["correction", "expiry", "remove"]) for (const groupId of [F.groupId, "private"])
  test(`memory-${change}: ${groupId === "private" ? "private" : "group"} context, derived thread and live tool session retract old evidence`, async t => {
    const f = memoryFixture(t, groupId);
    assert.ok(JSON.stringify(f.context().messages).includes(F.obsolete));
    assert.ok((await f.session.execute(call("recall_memory", { query: "Project" }), READ_TOOLS)).content.includes(F.obsolete));
    const oldThread = getConversationThread(F.userId, groupId);
    assert.ok(oldThread.expiresAt > f.note.expiresAt);
    if (change === "correction") f.act({ action: "update", id: f.note.id, text: F.corrected }, "70157");
    else if (change === "remove") f.act({ action: "remove", id: f.note.id }, "70158");
    else f.state.now = f.note.expiresAt;
    const context = f.context();
    const read = f.read();
    assert.ok(!JSON.stringify(context.messages).includes(F.obsolete));
    assert.ok(!JSON.stringify(read).includes(F.obsolete));
    assert.ok(JSON.stringify(context.messages).includes(F.independent));
    assert.ok(context.memorySources.every(item => item.noteId !== f.note.id || item.revision === 2));
    if (change === "correction") {
      assert.ok(JSON.stringify(context.messages).includes(F.corrected));
      assert.ok(read.memorySources.some(item => item.noteId === f.note.id && item.revision === 2));
    } else assert.ok(read.memorySources.every(item => item.noteId !== f.note.id));
    await assert.rejects(f.session.execute(call("recall_memory", { query: "Project" }), READ_TOOLS));
    assert.throws(f.session.fallbackContext);
    if (groupId === F.groupId) {
      const evidence = validateQuotedReply({ message_type: "group", group_id: F.groupId, user_id: F.peerId,
        replyData: { id: F.noteSourceId } }, { text: F.obsolete, images: [], source: { messageType: "group",
        groupId: F.groupId, userId: F.userId, messageId: F.noteSourceId, time: f.note.source.at / 1000 } });
      assert.equal(evidence.state, "unavailable");
      const passive = packet({ uid: F.peerId, mode: "interjection", userMsg: "Project?", replyToMessageId: F.noteSourceId,
        replyText: F.obsolete, quoteEvidence: evidence });
      assert.equal(passive.metadata.hasQuotedMessage, false);
      assert.ok(!JSON.stringify(passive.messages).includes(F.obsolete));
    }
    cover(change === "expiry" ? "memory-expiry" : "memory-correction");
  });

test("scope-permission: real readers isolate group/private/peer notes and reject identity injection before reading", async t => {
  const f = memoryFixture(t);
  for (const target of [{ userId: F.peerId, groupId: F.groupId }, { userId: F.userId, groupId: F.otherGroupId },
    { userId: F.userId, groupId: "private" }]) f.service.act({ ...target, revision: f.service.snapshot(target).revision,
    action: "create", title: "Project", text: F.foreign }, { origin: "user_command", messageId: "70159" });
  assert.ok(!JSON.stringify(f.read()).includes(F.foreign));
  assert.ok(!JSON.stringify(f.context()).includes(F.foreign));
  let reads = 0;
  const settings = p5SyntheticConfig();
  const session = createChatToolSession({ scope: scope("group"), cfg: settings, userMessage: "Project",
    recallMemory: () => { reads++; return { status: "ok", text: "SCOPED_READER" }; } });
  const injected = await session.execute(call("recall_memory", { query: "Project", userId: F.peerId, groupId: F.otherGroupId }), READ_TOOLS);
  assert.equal(JSON.parse(injected.content).status, "invalid_arguments");
  assert.equal(reads, 0);
  await session.execute(call("recall_memory", { query: "Project" }), READ_TOOLS);
  settings.groupWhitelist = [];
  await assert.rejects(session.execute(call("recall_memory", { query: "Project" }), READ_TOOLS), /permission_changed/);
  assert.equal(reads, 1);
  for (const denied of [{ surface: "group", userId: F.userId, groupId: F.otherGroupId }, { surface: "private", userId: F.peerId }]) {
    const outcome = await withChatRun(denied, () => assert.fail("denied entrypoint executed"), { cfg: CFG });
    assert.equal(outcome.reason, "permission_changed");
  }
  cover("scope-permission");
});

for (const surface of ["group", "private", "file"]) test("tool-failure and privacy compose through actual " + surface + " fallback", async t => {
  const bodies = captureModels(t, body => {
    if (body.model === "p5-fallback-model") return { content: "synthetic honest fallback" };
    if (!body.messages.some(item => item.role === "tool")) return { content: null, reasoning_content: "P5_PRIVATE_PROTOCOL",
      tool_calls: [call("recall_memory", { query: "Project" }, "read-failure"), call("admin_delete_all", {}, "denied-admin")] };
    return { content: "", reasoning_content: "P5_NO_FINAL_BODY" };
  });
  const toolSession = createChatToolSession({ scope: scope(surface === "group" ? "group" : "private"), cfg: CFG,
    task: surface === "file" ? "file_chat" : surface === "group" ? "group_chat" : "private_chat", userMessage: "Project",
    recallMemory: () => ({ status: "unavailable", text: "FAILED_TOOL_BODY" }) });
  const context = packet({ groupId: surface === "group" ? F.groupId : "private", mode: surface === "group" ? "group-at" : "private" });
  const result = await execute(surface, request(context, { options: { currentUserId: F.userId, currentInput: context.currentInput, toolSession } }));
  assert.equal(result.position, "fallback");
  assert.deepEqual(bodies.map(body => body.model), ["p5-primary-model", "p5-primary-model", "p5-fallback-model"]);
  const toolResults = bodies[1].messages.filter(item => item.role === "tool");
  assert.deepEqual(toolResults.map(item => item.tool_call_id), ["read-failure", "denied-admin"]);
  assert.deepEqual(toolResults.map(item => JSON.parse(item.content).status), ["unavailable", "denied"]);
  const fallback = JSON.stringify(bodies.at(-1).messages);
  for (const value of ["P5_PRIVATE_PROTOCOL", "P5_NO_FINAL_BODY", "FAILED_TOOL_BODY"]) {
    assert.ok(!fallback.includes(value)); assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(toolSession.sources(), []); assert.deepEqual(toolSession.fallbackContext(), []);
  cover("tool-failure", "privacy");
});

test("current-capability: primary/fallback wires carry actual model and no administrator/private configuration", async t => {
  const bodies = captureModels(t, body => body.model === "p5-primary-model"
    ? { content: "", reasoning_content: "P5_HIDDEN_REASONING" } : { content: "synthetic final" });
  const result = await executeChatTask(request(packet()));
  assert.equal(result.position, "fallback"); assert.equal(bodies.length, 2);
  for (const body of bodies) {
    const facts = wireFacts(body);
    assert.equal(facts.requestedModel, body.model);
    assert.ok(facts.capabilities.every(item => !item.name.includes("\u7ba1\u7406\u5458") && !item.name.includes("JM")));
    assert.ok(!JSON.stringify(facts).includes("p5-model.invalid"));
    assert.ok(!JSON.stringify(facts).includes(F.userId));
    assert.ok(!JSON.stringify(facts).includes(F.groupId));
  }
  assert.equal(parseChatOutcome({ content: "", reasoning_content: "P5_HIDDEN_REASONING" }, { interjection: true }).kind, "error");
  cover("current-capability", "privacy");
});

const pixels = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#d33344" } }).jpeg().toBuffer();
const imageUrl = "data:image/jpeg;base64," + Buffer.from(pixels).toString("base64");
for (const native of [true, false]) for (const surface of ["group", "private", "file"])
  test(`vision-path: ${surface} ${native ? "native prepared pixels" : "objective-description"} keeps context separate`, async t => {
    configure(native);
    let prepared = 0; let descriptions = 0;
    const visionSession = createVisionSession(["https://p5-image.invalid/synthetic.jpg"], { scope: scope(surface === "group" ? "group" : "private"), cfg: CFG,
      sources: [{ kind: "current", userId: F.userId }], prepareImages: async () => {
        prepared++; return { requested: 1, failed: 0, omitted: 0, images: [{ index: 1, animated: false,
          content: { type: "image_url", image_url: { url: imageUrl } } }] };
      }, describe: async () => { descriptions++; return { text: "Synthetic red square; no visible text.", cached: false }; } });
    const bodies = captureModels(t, () => ({ content: "synthetic image reply" }));
    const context = packet({ userMsg: "\u8fd9\u662f\u4ec0\u4e48\u989c\u8272\uff1f", groupId: surface === "group" ? F.groupId : "private",
      mode: surface === "group" ? "group-at" : "private", hasImages: true, imageCount: 1 });
    const result = await execute(surface, request(context, { imageUrls: ["https://p5-image.invalid/synthetic.jpg"],
      options: { currentUserId: F.userId, currentInput: context.currentInput, visionSession } }));
    assert.equal(result.kind, "reply"); assert.equal(prepared, 1); assert.equal(descriptions, native ? 0 : 1);
    assert.equal(bodies.length, 1); assert.equal(imageParts(bodies[0]).length, native ? 1 : 0);
    assert.equal(bodies[0].messages.at(-1).content, context.currentInput);
    const wire = JSON.stringify(bodies[0].messages);
    assert.ok(!wire.includes("p5-image.invalid"));
    if (native) assert.equal(imageParts(bodies[0])[0].image_url.url, imageUrl);
    else { assert.ok(wire.includes("Synthetic red square")); assert.ok(!wire.includes(imageUrl)); }
    cover("vision-path");
  });

test("picture-irony: opposite outcomes and literal control remain original evidence, not asserted semantic passes", async () => {
  const positive = P5_MODEL_PROBES.find(item => item.id === "exam-fail-positive");
  const negative = P5_MODEL_PROBES.find(item => item.id === "achievement-negative");
  const control = P5_MODEL_PROBES.find(item => item.id === "exam-pass-positive");
  const packets = [];
  for (const probe of [positive, negative, control]) {
    const built = await buildP5ProbePacket(probe);
    packets.push(built);
    const quoted = built.messages.find(item => item.content.startsWith("[\u88ab\u56de\u590d\u6d88\u606f]"));
    assert.ok(quoted.content.includes(probe.quote.text));
    assert.ok(built.messages.some(item => item.content.includes(P5_BITMAP_LABELS[probe.bitmap])));
    assert.equal(createP5ProbeRecord(probe, built).review.verdict, "not_verified");
  }
  assert.equal(new Set(packets.map(item => item.fingerprint)).size, 3);
  cover("picture-irony");
});

for (const surface of ["group", "private", "file"]) test("ordinary-no-final-cache: two independent " + surface + " requests both reach transport", async t => {
  const bodies = captureModels(t, (_body, calls) => ({ content: "synthetic answer " + calls.length }));
  const context = packet({ groupId: surface === "group" ? F.groupId : "private", mode: surface === "group" ? "group-at" : "private" });
  const input = request(context);
  const first = await execute(surface, input);
  const second = await execute(surface, input);
  assert.equal(bodies.length, 2); assert.equal(first.text, "synthetic answer 1"); assert.equal(second.text, "synthetic answer 2");
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  cover("ordinary-no-final-cache");
});

test("interjection-silence: actual transport empty reply stops at primary and records no-send silence", async t => {
  const bodies = captureModels(t, () => ({ content: '{"reply":""}' }));
  const ledger = createChatDeliveryLedger({ filename: path.join(root, "silence-ledger.json") });
  const eventScope = { ...scope("group"), messageId: "70200" };
  const context = packet({ mode: "interjection", userMsg: "\u55ef\u3002" });
  const result = await withChatRun(eventScope, () => executeChatTask(request(context, { isAtMe: false,
    options: { currentUserId: F.userId, currentInput: context.currentInput, replyMode: "interjection" } })), { cfg: CFG, ledger });
  assert.equal(result.kind, "silence"); assert.equal(bodies.length, 1); assert.equal(bodies[0].tools, undefined);
  const receipt = ledger.find(eventScope);
  assert.equal(receipt.status, "silent"); assert.equal(receipt.attempts, 0); assert.equal(receipt.confirmed, 0);
  cover("interjection-silence");
});

for (const surface of ["group", "private", "file"]) test("memory-forget: erasure during " + surface + " model transport discards late result and fallback", async t => {
  const bodies = captureModels(t, () => {
    forgetUserData(F.userId);
    return { content: "LATE_P5_PRIVATE_REPLY", reasoning_content: "LATE_P5_REASONING" };
  });
  const context = packet({ groupId: surface === "group" ? F.groupId : "private", mode: surface === "group" ? "group-at" : "private" });
  const result = await withChatRun(scope(surface === "group" ? "group" : "private"), () => execute(surface, request(context)), { cfg: CFG });
  assert.equal(result.kind, "cancelled"); assert.equal(bodies.length, 1);
  assert.ok(!JSON.stringify(result).includes("LATE_P5"));
  assert.deepEqual(users[F.userId].chats, []);
  assert.deepEqual(users[F.userId].nicknames, []);
  assert.equal(users[F.userId].profile, "");
  assert.ok(!JSON.stringify(users[F.userId]).includes("LATE_P5"));
  cover("memory-forget", "privacy");
});

const deliveries = [
  { id: "partial-send", receipts: [{ status: "ok", retcode: 0 }, { status: "failed", retcode: 100 }], expected: "partial", confirmed: 1 },
  { id: "unknown-send", receipts: [{ status: "async", retcode: 1 }], expected: "unknown", confirmed: 0 },
  { id: "unknown-send", receipts: [{ status: "ok", retcode: 0 }, { status: "ok", retcode: 100 }], expected: "unknown", confirmed: 1 },
];
for (const surface of ["group", "private"]) for (const [index, fixture] of deliveries.entries())
  test(`${fixture.id}: ${surface} ${fixture.confirmed} confirmed chunks cannot become success or replay after restart`, async t => {
    const filename = path.join(root, `ledger-${surface}-${index}.json`);
    const ledger = createChatDeliveryLedger({ filename });
    const eventScope = { ...scope(surface), messageId: String(70300 + index) };
    const payloads = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(String(url), CFG.napcatApi + (surface === "group" ? "/send_group_msg" : "/send_private_msg"));
      const payload = JSON.parse(options.body); payloads.push(payload);
      assert.equal(String(surface === "group" ? payload.group_id : payload.user_id), surface === "group" ? F.groupId : F.userId);
      assert.ok(payloads.length <= fixture.receipts.length, "unknown result retried or later chunk sent");
      return { ok: true, json: async () => fixture.receipts[payloads.length - 1] };
    });
    const result = await withChatRun(eventScope, async () => {
      noteChatOutcome({ kind: "reply" });
      const common = { text: "synthetic final ".repeat(200), maxAttempts: fixture.id === "unknown-send" ? 3 : 1, retryDelayMs: 0 };
      return surface === "group" ? sendTextToGroup({ ...common, groupId: F.groupId, replyTo: eventScope.messageId })
        : sendTextToPrivate({ ...common, userId: F.userId });
    }, { cfg: CFG, ledger });
    assert.equal(isSuccessfulOutbound(result), false); assert.equal(payloads.length, fixture.receipts.length);
    assert.equal(ledger.find(eventScope).status, fixture.expected); assert.equal(ledger.find(eventScope).confirmed, fixture.confirmed);
    assert.equal(ledger.find(eventScope).attempts, fixture.receipts.length);
    if (surface === "group") {
      assert.deepEqual(payloads[0].message[0], { type: "reply", data: { id: eventScope.messageId } });
      assert.ok(payloads.slice(1).every(payload => payload.message.every(item => item.type !== "reply")));
    }
    const restarted = createChatDeliveryLedger({ filename });
    const duplicate = await withChatRun(eventScope, () => assert.fail("duplicate must not invoke model or send"), { cfg: CFG, ledger: restarted });
    assert.equal(duplicate.reason, "reply_duplicate"); assert.equal(payloads.length, fixture.receipts.length);
    const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
    for (const row of Object.values(stored.records)) for (const hidden of ["userId", "groupId", "messageId", "text", "reasoning_content"])
      assert.equal(Object.hasOwn(row, hidden), false);
    assert.ok(!JSON.stringify(stored).includes("synthetic final"));
    cover(fixture.id);
  });

test("all declared matrix boundaries were actually exercised; this is not semantic acceptance", () => {
  assert.deepEqual([...matrixCoverage].sort(), P5_QUALITY_MATRIX.map(item => item.id).sort());
});
