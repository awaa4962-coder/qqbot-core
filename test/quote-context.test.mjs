import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-quotes-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { resolveReplyContext } = await import("../bridge/reply-handlers.mjs");
const { forgetSummaryUser } = await import("../bridge/group-summary/journal.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { validateQuotedReply } = await import("../bridge/context/quoted-reply.mjs");
const { clearUserMemoryProfile } = await import("../bridge/memory-profile.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/index.mjs");
const { safeContextExcerpt, buildCurrentInput } = await import("../bridge/context/messages.mjs");
const { sanitizeAssistantReply } = await import("../bridge/thinking.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { aiReply, processEvent } = await import("../bridge/reply.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { createTraceRecorder, withMessageTrace } = await import("../bridge/diagnostics/message-trace.mjs");
CFG.groupWhitelist = [501]; CFG.friendWhitelist = [602]; CFG.botBlacklist = [];
const ctx = () => ({ message_type: "group", group_id: 501, user_id: 602, message_id: 702, replyData: { id: "701" }, images: [] });
const message = extra => ({ message_type: "group", group_id: 501, user_id: 601, message_id: 701,
  time: Math.floor(Date.now() / 1000) - 60, sender: { nickname: "同名" },
  message: [{ type: "text", data: { text: "synthetic quoted statement" } }, { type: "image", data: { url: "https://example.com/synthetic.png" } }], ...extra });
const response = data => ({ ok: true, json: async () => ({ status: "ok", retcode: 0, data }) });

test("foreign-group and private get_msg data cannot enter group quote text or images", async t => {
  for (const extra of [{ group_id: 502 }, { message_type: "private" }, { message_id: 999 }, { group_id: undefined }]) {
    t.mock.method(globalThis, "fetch", async () => response(message(extra)));
    const context = ctx();
    assert.equal(await resolveReplyContext(context), "");
    assert.deepEqual(context.images, []);
    assert.equal(context.replyUserId || "", "");
    t.mock.restoreAll();
  }
});

test("forgotten authors' old quoted messages cannot return through OneBot lookup", async t => {
  const cutoff = Date.now();
  forgetSummaryUser(603, { now: cutoff });
  t.mock.method(globalThis, "fetch", async () => response(message({ user_id: 603, time: Math.floor(cutoff / 1000) - 10 })));
  const context = ctx();
  assert.equal(await resolveReplyContext(context), "");
  assert.deepEqual(context.images, []);
});

test("privacy changes during get_msg discard the late quoted response", async t => {
  t.mock.method(globalThis, "fetch", async () => {
    invalidateMemoryPrivacyGeneration();
    return response(message({}));
  });
  const context = ctx();
  assert.equal(await resolveReplyContext(context), "");
  assert.deepEqual(context.images, []);
});

test("conflicting author fields cannot bypass a quoted author's erasure cutoff", async t => {
  forgetSummaryUser(603, { now: Date.now() });
  t.mock.method(globalThis, "fetch", async () => response(message({ sender: { user_id: 603, nickname: "同名" } })));
  const context = ctx();
  assert.equal(await resolveReplyContext(context), "");
  assert.equal(context.quoteEvidence.reason, "quote_source_unknown");
  assert.equal(context.replyUserId || "", "");
  assert.deepEqual(context.images, []);
});

test("matching string/number author fields and sender-only author remain compatible", async t => {
  for (const extra of [{ sender: { user_id: "601" } }, { user_id: undefined, sender: { user_id: 601 } }]) {
    t.mock.method(globalThis, "fetch", async () => response(message(extra)));
    const context = ctx();
    assert.ok(await resolveReplyContext(context));
    assert.equal(context.quoteEvidence.userId, "601");
    t.mock.restoreAll();
  }
});

test("valid same-group quotes carry stable author, message and time provenance", async t => {
  const data = message({});
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return response(data); });
  const context = ctx();
  const text = await resolveReplyContext(context);
  assert.equal(text, "synthetic quoted statement [图片1张]");
  assert.equal(context.replyUserId, "601");
  assert.equal(context.replySpeaker, "同名");
  assert.deepEqual(context.images, ["https://example.com/synthetic.png"]);
  assert.deepEqual(context.quoteEvidence, { state: "verified", source: "onebot", messageId: "701", groupId: "501", userId: "601", at: data.time * 1000 });
  assert.equal(requests, 1);
});

test("missing, malformed, future or empty quote evidence is not promoted to context", async t => {
  for (const extra of [{ time: undefined }, { time: 0 }, { time: true }, { time: Math.floor(Date.now() / 1000) + 601 },
    { user_id: undefined }, { user_id: [601] }, { group_id: {} }, { message: [] }]) {
    t.mock.method(globalThis, "fetch", async () => response(message(extra)));
    const context = ctx();
    assert.equal(await resolveReplyContext(context), "");
    assert.equal(context.quoteEvidence.state, "unavailable");
    assert.deepEqual(context.images, []);
    t.mock.restoreAll();
  }
});

test("new statements after forgetting and profile-only clearing remain quotable", async t => {
  forgetSummaryUser(604, { now: Date.now() - 120000 });
  for (const uid of [601, 604]) {
    clearUserMemoryProfile(uid);
    t.mock.method(globalThis, "fetch", async () => response(message({ user_id: uid })));
    const context = ctx();
    assert.ok(await resolveReplyContext(context));
    assert.equal(context.quoteEvidence.state, "verified");
    t.mock.restoreAll();
  }
});

test("unreadable erasure state cannot expose raw errors or quoted content", () => {
  const reply = { text: "synthetic", images: [], source: { messageType: "group", groupId: 501, userId: 601, messageId: 701, time: Math.floor(Date.now() / 1000) } };
  for (const readPrivacy of [() => { throw new Error("private path and secret should remain hidden"); }, () => ({ users: { 601: "corrupt" } }), () => ({})]) {
    const result = validateQuotedReply(ctx(), reply, { readPrivacy });
    assert.deepEqual(result, { state: "unavailable", reason: "quote_privacy_unavailable" });
  }
});

test("same-named participants stay distinct and quote metadata stays out of model message fields", async t => {
  t.mock.method(globalThis, "fetch", async () => response(message({})));
  const context = ctx();
  const replyText = await resolveReplyContext(context);
  const recorder = createTraceRecorder();
  let packet;
  await withMessageTrace(context, () => {
    packet = buildReplyContextPacket({ uid: "602", groupId: "501", userName: "同名", userMsg: "他说的是什么意思？", replyText,
      replyToMessageId: "701", replyUserId: context.replyUserId, replySpeaker: context.replySpeaker, quoteEvidence: context.quoteEvidence });
  }, recorder);
  assert.match(packet.currentInput, /speaker=同名 uid=602/);
  const quote = packet.messages.find(item => item.content.startsWith("[被回复消息]"));
  assert.match(quote.content, /speaker=同名 uid=601/);
  assert.match(quote.content, /OneBot已核验同群引用 message_id=701/);
  assert.equal(packet.metadata.hasQuotedMessage, true);
  for (const item of packet.messages) assert.deepEqual(Object.keys(item).sort(), ["content", "role"]);
  const source = recorder.list().items[0].stages.find(item => item.sources?.length).sources[0];
  assert.equal(source.userId, "601"); assert.equal(source.verified, true); assert.ok(source.at > 0);
  assert.doesNotMatch(JSON.stringify(recorder.list()), /synthetic quoted statement|synthetic.png|同名/);
});

test("quoting one's own older statement preserves identity without inventing another person", async t => {
  t.mock.method(globalThis, "fetch", async () => response(message({ user_id: 602 })));
  const context = ctx();
  const replyText = await resolveReplyContext(context);
  const packet = buildReplyContextPacket({ uid: "602", groupId: "501", userName: "同名", userMsg: "这是我刚才说的", replyText,
    replyToMessageId: "701", replyUserId: context.replyUserId, replySpeaker: context.replySpeaker, quoteEvidence: context.quoteEvidence });
  const quote = packet.messages.find(item => item.content.startsWith("[被回复消息]"));
  assert.match(quote.content, /speaker=同名 uid=602/);
  assert.doesNotMatch(quote.content, /这不是当前发言人的原话|两人的经历/);
});

test("unavailable quotes are not replaced with nearby people, history or hidden raw text", () => {
  users[602] = { chats: [{ group: "501", text: "unrelated secret-topic context", messageId: "701", ts: Date.now() }] };
  groupChats[501] = [{ uid: "601", nickname: "nearby", text: "unrelated secret-topic context", messageId: "701", ts: Date.now() }];
  for (const mode of ["group-at", "interjection"]) {
    const packet = buildReplyContextPacket({ uid: "602", groupId: "501", userName: "同名", userMsg: "这个呢？", replyToMessageId: "701",
      replyText: "rejected private quote", quoteEvidence: { state: "unavailable", reason: "quote_forgotten" }, mode });
    assert.match(JSON.stringify(packet.messages), /被回复消息暂不可用/);
    assert.doesNotMatch(JSON.stringify(packet.messages), /unrelated secret-topic|rejected private quote/);
    assert.match(packet.currentInput, /若本轮缺少引用正文/);
    assert.equal(packet.metadata.hasQuotedMessage, false);
    assert.equal(packet.thread, null);
  }
});

test("quote excerpts keep final corrections and atomic identity blocks do not become orphans", () => {
  const long = "先说原来的判断" + "过程记录".repeat(500) + "最后更正：问题还没有修好";
  const excerpt = safeContextExcerpt(long, 120);
  assert.equal(excerpt.length, 120);
  assert.ok(excerpt.startsWith("先说原来的判断")); assert.ok(excerpt.endsWith("最后更正：问题还没有修好"));
  assert.equal(safeContextExcerpt(long, -1), "");
  const packet = buildReplyContextPacket({ uid: "602", groupId: "501", userName: "A", userMsg: "怎么回事", replyText: long, replyUserId: "602", replyToMessageId: "701",
    quoteEvidence: { state: "verified", source: "onebot", userId: "602", messageId: "701", groupId: "501", at: Date.now() },
    contextBudget: { maxChars: 240, maxMessageChars: 120, maxMessages: 1 } });
  assert.equal(packet.metadata.hasQuotedMessage, false);
  assert.ok(!packet.messages.some(item => item.content.includes("[被回复消息]")));
  assert.match(packet.currentInput, /存在引用/);
  const current = buildCurrentInput("同名", long + "当前最后要求：只看 Linux", "602");
  assert.match(current, /当前最后要求：只看 Linux\nreply_target=当前发言人$/);
});

test("ordinary uncertainty and quote interpretation are not internal reasoning", () => {
  for (const text of ["看起来像一张同人图，我不确定具体角色。", "他是在说文件没下全，不是在说你操作错了。"]) assert.equal(sanitizeAssistantReply(text), text);
  assert.equal(sanitizeAssistantReply("我需要先分析用户的意图，再决定应该如何回复。"), null);
});

test("a context revision captured before chat-run creation prevents model and vision work", async t => {
  t.mock.method(globalThis, "fetch", async () => response(message({})));
  const context = ctx();
  const replyText = await resolveReplyContext(context);
  invalidateMemoryPrivacyGeneration();
  const result = await aiReply(501, 602, "看看这个", "同名", context.images, 702, replyText, true, [], {
    messageId: 702, contextPrivacyGeneration: context.contextPrivacyGeneration, quoteEvidence: context.quoteEvidence,
    resolveVision: () => assert.fail("no stale vision"), executeChatTask: () => assert.fail("no stale model"),
  });
  assert.equal(result.reason, "privacy_changed");
});

test("forgetting while member hydration waits cannot repopulate the old input", async t => {
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("get_group_member_info"), "no model or QQ send after erasure");
    lookups++;
    forgetUserData(602);
    return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { card: "synthetic target" } }) };
  });
  await processEvent({ message_type: "group", group_id: 501, user_id: 602, message_id: 901, time: Math.floor(Date.now() / 1000),
    sender: { nickname: "synthetic" }, message: [{ type: "at", data: { qq: "60500" } }, { type: "text", data: { text: "old incoming text must stay cleared" } }] });
  assert.equal(lookups, 1);
  assert.ok(!users[602]?.chats?.some(item => item.text.includes("old incoming text")));
  assert.ok(!groupChats[501]?.some(item => item.text.includes("old incoming text")));
});
