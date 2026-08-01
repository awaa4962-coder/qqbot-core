import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWordcloudReply,
  collectWordcloudTokens,
  filterMessagesByRange,
  handleWordcloudCommand,
  isFeatureGroupAllowed,
  parseWordcloudCommand,
  tokenizeText,
} from "../bridge/features/wordcloud/index.mjs";

const now = new Date("2026-07-05T12:00:00+08:00");

test("parses wordcloud commands after bot mention", () => {
  assert.deepEqual(parseWordcloudCommand("@夜星 词云", { botNames: ["夜星"] }), { range: "today", days: 1 });
  assert.deepEqual(parseWordcloudCommand("@QQFriend 昨日词云", { botNames: ["QQFriend"] }), { range: "yesterday", days: 1 });
  assert.deepEqual(parseWordcloudCommand("@夜星 wordcloud 7d", { botNames: ["夜星"] }), { range: "days", days: 7 });
  assert.equal(parseWordcloudCommand("@夜星 help", { botNames: ["夜星"] }), null);
});

test("tokenizes Chinese and English while ignoring links", () => {
  const tokens = tokenizeText("今天测试词云很好玩，wordcloud test test https://example.com/path");
  assert.ok(tokens.includes("测试"));
  assert.ok(tokens.includes("词云"));
  assert.ok(tokens.includes("wordcloud"));
  assert.ok(tokens.includes("test"));
  assert.equal(tokens.includes("https"), false);
});

test("collects aggregated wordcloud tokens without assistant messages", () => {
  const messages = [
    { role: "member", text: "词云 词云 wordcloud wordcloud", ts: now.getTime() },
    { role: "member", text: "词云 好玩 wordcloud", ts: now.getTime() },
    { role: "assistant", text: "词云 词云 wordcloud", ts: now.getTime() },
  ];
  const tokens = collectWordcloudTokens(messages, { stopwords: ["好玩"], topN: 5 });
  const wordcloud = tokens.find(item => item.word === "wordcloud");
  assert.equal(wordcloud.count, 3);
  assert.equal(tokens.some(item => item.word === "好玩"), false);
});

test("collects wordcloud tokens without placeholders or blocked words", () => {
  const messages = [
    { role: "member", text: "[非文本消息] [非文本消息]", ts: now.getTime() },
    { role: "member", text: "傻逼 傻逼 正常词 正常词", ts: now.getTime() },
    { role: "member", text: "正常词 wordcloud wordcloud", ts: now.getTime() },
  ];
  const tokens = collectWordcloudTokens(messages, {
    stopwords: ["傻逼", "非文本消息", "消息", "文本", "非文本"],
    topN: 8,
  });
  assert.equal(tokens.some(item => item.word.includes("文本")), false);
  assert.equal(tokens.some(item => item.word === "傻逼"), false);
  assert.ok(tokens.some(item => item.word === "wordcloud"));
});

test("filters yesterday messages by local day", () => {
  const chats = [
    { text: "old", ts: new Date("2026-07-03T23:59:59+08:00").getTime() },
    { text: "yesterday", ts: new Date("2026-07-04T09:00:00+08:00").getTime() },
    { text: "today", ts: new Date("2026-07-05T00:10:00+08:00").getTime() },
  ];
  const result = filterMessagesByRange(chats, { range: "yesterday", days: 1 }, now);
  assert.deepEqual(result.map(item => item.text), ["yesterday"]);
});

test("wordcloud command sends fallback text when renderer is unavailable", async () => {
  const sent = [];
  const handled = await handleWordcloudCommand({
    isAtMe: true,
    text: "@夜星 词云",
    group_id: 2000000001,
  }, {
    botNames: ["夜星"],
    featureGroupWhitelist: [2000000001],
    replyToId: 99,
    now,
    chats: [
      { role: "member", text: "词云 词云 wordcloud wordcloud", ts: now.getTime() },
      { role: "member", text: "词云 wordcloud", ts: now.getTime() },
    ],
    renderer: async () => null,
    sender: async (groupId, text, replyToId) => sent.push({ groupId, text, replyToId }),
  });

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].groupId, 2000000001);
  assert.equal(sent[0].replyToId, 99);
  assert.match(sent[0].text, /词云生成好了/);
  assert.match(sent[0].text, /wordcloud/);
});

test("wordcloud command respects feature group whitelist", async () => {
  const sent = [];
  const handled = await handleWordcloudCommand({
    isAtMe: true,
    text: "@夜星 词云",
    group_id: 42,
  }, {
    botNames: ["夜星"],
    featureGroupWhitelist: [2000000001],
    sender: async (groupId, text) => sent.push({ groupId, text }),
  });

  assert.equal(handled, true);
  assert.equal(isFeatureGroupAllowed(42, [2000000001]), false);
  assert.match(sent[0].text, /还没开启词云功能/);
});

test("buildWordcloudReply can use injected renderer", async () => {
  const reply = await buildWordcloudReply(2000000001, { range: "days", days: 7 }, {
    now,
    chats: [
      { role: "member", text: "模块 模块 词云 词云", ts: now.getTime() },
      { role: "member", text: "模块 词云", ts: now.getTime() },
    ],
    renderer: async () => "C:/tmp/wordcloud.png",
  });

  assert.equal(reply.imagePath, "C:/tmp/wordcloud.png");
  assert.match(reply.text, /最近 7 天/);
});
