import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { performance } from "node:perf_hooks";
import { compareRelevance, currentTopicText, messageFeatures, retrievalFeatures } from "../bridge/context/relevance.mjs";
import { selectConversationThread, selectGroupConversation, selectRecentImageMessage } from "../bridge/context/conversation-selection.mjs";
import { retrieveRelevantUserMemories } from "../bridge/context-retriever.mjs";
import { buildReplyContextPacket } from "../bridge/context/assemble.mjs";
import { enforceContextBudget } from "../bridge/context/budget.mjs";
import { recordConversationTurn, resetCognitionForTest } from "../bridge/cognition/index.mjs";
import { users, groupChats } from "../bridge/storage.mjs";
import { forgetUserData, setUserDisplayName } from "../bridge/user-preferences.mjs";
import { resolveReplyContext, pullRecentImages } from "../bridge/reply-handlers.mjs";
import { createTraceRecorder, traceStage, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";
import { processEvent } from "../bridge/reply.mjs";

const now = Date.now();
const row = (messageId, uid, text, rest = {}) => ({ messageId, uid, text, nickname: "user-" + uid, role: "member", ts: now - 1000, ...rest });
const turns = [
  { messageId: "1", userSummary: "解压时提示分卷缺失。", assistantSummary: "先检查文件是否全部下载。" },
  { messageId: "2", userSummary: "还是不行，文件齐了。", assistantSummary: "再确认压缩包有没有损坏。" },
  { messageId: "3", userSummary: "晚饭吃什么？", assistantSummary: "可以吃面。" },
];

beforeEach(() => {
  for (const key of Object.keys(users)) delete users[key];
  for (const key of Object.keys(groupChats)) delete groupChats[key];
  resetCognitionForTest();
});

test("Chinese segmentation and canonical concepts match both sides of a query", () => {
  assert.ok(compareRelevance("这个 archive 打不开", "解压时提示分卷缺失").score > 0);
  assert.equal(compareRelevance("拉文件特别慢", "昨天下载速度很低").reason, "synonyms");
  assert.ok(compareRelevance("显卡驱动更新之后黑屏", "我的显卡驱动需要更新").score > 0);
  assert.equal(compareRelevance("这个怎么办，还是不行", "今天晚饭吃火锅").score, 0);
  assert.equal(compareRelevance("网卡报错", "解压出错").score, 0);
  assert.equal(retrievalFeatures("https://example.com/token=abc 123456789").tokens.size, 0);
});

test("message feature cache notices edited text without retaining a separate history index", () => {
  const message = { text: "下载文件" };
  const first = messageFeatures(message);
  assert.equal(messageFeatures(message), first);
  message.text = "晚饭吃面";
  assert.notEqual(messageFeatures(message), first);
  assert.equal(messageFeatures(message).concepts.has("download"), false);
});

test("personal recall stays with the sender and group, excludes current messages", () => {
  users["11"] = { chats: [
    { group: "22", text: "解压需要完整分卷", messageId: "1", ts: 1000 },
    { group: "33", text: "archive other-group private", messageId: "2", ts: 2000 },
    { group: "22", text: "archive current", messageId: "3", ts: 3000 },
  ] };
  users["12"] = { chats: [{ group: "22", text: "archive other-user private", messageId: "4", ts: 4000 }] };
  const found = retrieveRelevantUserMemories("11", "archive", { groupId: "22", currentMessageId: "3" });
  assert.deepEqual(found.map(item => item.messageId), ["1"]);
  assert.equal(found[0].matchReason, "synonyms");
});

test("explicit topic switch excludes the old subject from lexical matching and threads", () => {
  const text = "先不聊下载了，17加25是多少？";
  assert.equal(currentTopicText(text).switched, true);
  assert.equal(retrievalFeatures(text).concepts.has("download"), false);
  assert.equal(selectConversationThread({ turns }, { userMsg: text }), null);
  assert.equal(selectGroupConversation([row("10", "12", "下载失败")], { userMsg: text, now }).items.length, 0);
});

test("a demonstrative with a different subject does not force old task continuation", () => {
  assert.equal(selectConversationThread({ turns: turns.slice(0, 2) }, { userMsg: "这个新游戏怎么样？" }), null);
});

test("a follow-up can refer to a specific item in the assistant's previous answer", () => {
  const selected = selectConversationThread({ turns: [{ messageId: "1", userSummary: "解压密码是什么？", assistantSummary: "密码是 FS。" }] }, { userMsg: "之前你说的 FS 是大写吗？" });
  assert.equal(selected.turns[0].messageId, "1");
});

test("thread selection keeps follow-up results with the matching earlier topic", () => {
  const selected = selectConversationThread({ turns, topic: "晚饭" }, { userMsg: "压缩包解压怎么办" });
  assert.deepEqual(selected.turns.map(turn => turn.messageId), ["1", "2"]);
  assert.equal(selected.topic, "相关历史对话");
  assert.match(selected.turns[1].assistantSummary, /损坏/);
});

test("quoting someone else does not attach the sender's old conversation", () => {
  assert.equal(selectConversationThread({ turns }, { userMsg: "还是不行", replyText: "解压失败", replyToMessageId: "99", replyUserId: "12", selfUin: "100" }), null);
});

test("quoted other-person context excludes the current sender's matching personal history", () => {
  users["11"] = { chats: [{ group: "22", messageId: "1", text: "压缩包 MY_OLD_HISTORY", ts: now }] };
  const packet = buildReplyContextPacket({ uid: "11", groupId: "22", userMsg: "他的压缩包怎么了", replyText: "压缩包坏了", replyToMessageId: "9", replyUserId: "12" });
  assert.doesNotMatch(JSON.stringify(packet.messages), /MY_OLD_HISTORY/);
  assert.ok(packet.retrieval.sources.some(item => item.kind === "quote" && item.userId === "12"));
});

test("quote chain includes ancestors and responses but not unrelated nearby discussion", () => {
  const messages = [
    row("1", "12", "显卡更新驱动还是黑屏", { ts: now - 4000 }),
    row("2", "13", "换条显示器线试试", { replyToMessageId: "1", ts: now - 3000 }),
    row("3", "14", "今晚吃火锅土豆", { ts: now - 2000 }),
    row("4", "12", "换了线，还是黑屏", { replyToMessageId: "2", ts: now - 1000 }),
  ];
  const selected = selectGroupConversation(messages, { userMsg: "后来好了没？", replyText: "换条显示器线试试", replyToMessageId: "2", now });
  assert.deepEqual(selected.items.map(item => item.message.messageId), ["1", "4"]);
  assert.equal(selected.strategy, "quote");
});

test("explicit mention selects the addressed participant when text alone is ambiguous", () => {
  const selected = selectGroupConversation([row("1", "12", "主板还没修好"), row("2", "13", "今天吃火锅")], {
    userMsg: "你那边怎么样？", mentions: [{ qq: "12", isBot: false }], now,
  });
  assert.deepEqual(selected.items.map(item => item.message.uid), ["12"]);
  assert.equal(selected.items[0].reason, "mention");
});

test("another participant sharing keywords does not replace the explicit mention target", () => {
  const selected = selectGroupConversation([row("1", "12", "电脑没修好"), row("2", "13", "试过了，已经正常")], {
    userMsg: "你试过了没？", mentions: [{ qq: "12", isBot: false }], now,
  });
  assert.deepEqual(selected.items.map(item => item.message.uid), ["12"]);
});

test("a topic switch overrides an old quoted topic during recall", () => {
  const selected = selectGroupConversation([row("1", "12", "压缩包下载失败")], {
    userMsg: "先不聊下载了，17加25是多少？", replyText: "压缩包下载失败", replyToMessageId: "1", now,
  });
  assert.equal(selected.items.length, 0);
});

test("selection excludes old, current, bot and foreign-scope messages", () => {
  const selected = selectGroupConversation([
    row("1", "12", "解压报错", { ts: now - 31 * 60000 }),
    row("2", "11", "解压报错"),
    row("3", "100", "解压报错", { role: "assistant" }),
    row("4", "12", "解压报错", { group: "other" }),
    row("5", "12", "解压报错"),
  ], { userMsg: "解压", currentMessageId: "2", groupId: "22", selfUin: "100", now });
  assert.deepEqual(selected.items.map(item => item.message.messageId), ["5"]);
});

test("cyclic quote chains terminate and selected history stays bounded", () => {
  const messages = [...Array.from({ length: 130 }, (_, index) => row(String(index + 3), "14", "驱动报错 " + index)),
    row("1", "12", "驱动更新", { replyToMessageId: "2" }), row("2", "13", "驱动安装", { replyToMessageId: "1" })];
  const selected = selectGroupConversation(messages, { userMsg: "驱动", replyToMessageId: "1", limit: 8, now });
  assert.ok(selected.items.length <= 8);
  assert.ok(selected.items.some(item => item.message.messageId === "1"));
  assert.ok(selected.items.some(item => item.message.messageId === "2"));
});

test("image follow-up selects one recent message from the relevant author", () => {
  const images = [
    row("1", "11", "[图片]", { imageUrls: ["own-image"], ts: now - 2000 }),
    row("2", "12", "[图片]", { imageUrls: ["other-image"], ts: now - 1000 }),
  ];
  assert.equal(selectRecentImageMessage(images, { uid: "11", userMsg: "看看刚才的图", now }).messageId, "1");
  assert.equal(selectRecentImageMessage(images, { uid: "11", userMsg: "这是谁？", now }).messageId, "1");
  assert.equal(selectRecentImageMessage(images, { uid: "11", userMsg: "看看他的图", mentions: [{ qq: "12" }], now }).messageId, "2");
  assert.equal(selectRecentImageMessage(images, { uid: "11", userMsg: "今天吃什么", now }), null);
  assert.equal(selectRecentImageMessage(images, { uid: "99", userMsg: "看看图", now }), null);
  assert.equal(selectRecentImageMessage(images, { uid: "11", userMsg: "图片", now: now + 6 * 60000 }), null);
  groupChats["22"] = images;
  assert.deepEqual(pullRecentImages("22", { uid: "11", userMsg: "看图", now }), ["own-image"]);
});

test("quoted message identity reaches context without changing its text", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ json: async () => ({ status: "ok", data: { user_id: 12, sender: { card: "小林" }, message: [{ type: "text", data: { text: "分卷没下齐" } }] } }) });
    const ctx = { replyData: { id: 9 }, images: [] };
    assert.equal(await resolveReplyContext(ctx), "分卷没下齐");
    assert.equal(ctx.replySpeaker, "小林");
    assert.equal(ctx.replyUserId, "12");
  } finally { globalThis.fetch = originalFetch; }
});

test("real event storage preserves the incoming reply link", async () => {
  await processEvent({ post_type: "message", message_type: "group", user_id: 11, group_id: 2000000001, message_id: 61001,
    sender: { nickname: "synthetic user" }, message: [{ type: "reply", data: { id: "61000" } }, { type: "text", data: { text: "好" } }] });
  assert.equal(groupChats["2000000001"].at(-1).replyToMessageId, "61000");
  assert.equal(users["11"].chats.at(-1).replyToMessageId, "61000");
});

test("context source metadata is removed from model messages and pruned with its layer", () => {
  users["11"] = { chats: [{ group: "22", text: "压缩包分卷缺失", messageId: "1", ts: now }] };
  const packet = buildReplyContextPacket({ uid: "11", groupId: "22", userMsg: "archive", userName: "A" });
  assert.ok(packet.retrieval.sources.some(item => item.kind === "memory" && item.messageId === "1"));
  for (const message of packet.messages) assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
  const bounded = enforceContextBudget([
    { role: "user", content: "one", contextPriority: 100, contextSources: [{ kind: "quote", messageId: "1" }] },
    { role: "user", content: "two", contextPriority: 10, contextSources: [{ kind: "memory", messageId: "2" }] },
  ], "current", { maxMessages: 1 });
  assert.deepEqual(bounded.sources.map(item => item.messageId), ["1"]);
});

test("diagnostic source references never include raw text or private source fields", async () => {
  const recorder = createTraceRecorder();
  await withMessageTrace({ message_type: "group", user_id: 11, group_id: 22 }, () => traceStage("context", { sources: [
    { kind: "memory", reason: "synonyms", messageId: "1", userId: "11", text: "private source body", nickname: "private name", score: 2 },
  ] }), recorder);
  const source = recorder.list().items[0].stages.find(stage => stage.stage === "context").sources[0];
  assert.equal(source.reason, "synonyms");
  assert.doesNotMatch(JSON.stringify(source), /private source body|private name/);
});

test("explicit name correction wins over old history and forgetting removes recall", () => {
  users["11"] = { alias: "小林", chats: [{ group: "22", text: "以前我叫小林，压缩包坏了", messageId: "1", ts: now }] };
  recordConversationTurn({ uid: "11", groupId: "22", userText: "解压失败", assistantText: "小林，检查分卷。", now }, { save: false });
  setUserDisplayName("11", "小夏", { skipSave: true });
  const packet = buildReplyContextPacket({ uid: "11", groupId: "22", userMsg: "解压还是失败", userName: "小林" });
  assert.match(packet.currentInput, /speaker=小夏/);
  assert.match(JSON.stringify(packet.messages), /称呼=小夏/);
  const oldRow = users["11"].chats[0];
  const cached = messageFeatures(oldRow);
  forgetUserData("11", { skipSave: true });
  assert.notEqual(messageFeatures(oldRow), cached);
  assert.equal(retrieveRelevantUserMemories("11", "解压", { groupId: "22" }).length, 0);
});

test("warm lexical matching stays bounded for a full retained user history", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ group: "22", messageId: String(index), text: "下载压缩包时发生网络异常，稍后重新连接。", ts: index }));
  const store = { "11": { chats: rows } };
  retrieveRelevantUserMemories("11", "拉文件失败", { users: store, groupId: "22" });
  const started = performance.now();
  for (let index = 0; index < 20; index++) assert.ok(retrieveRelevantUserMemories("11", "拉文件失败", { users: store, groupId: "22" }).length <= 5);
  assert.ok(performance.now() - started < 3000, "warm retrieval should not perform slow remote or unbounded work");
});
