import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLocalSummaryFallback,
  buildGroupSummaryPrompt,
  buildSummaryStats,
  buildSummaryDigest,
  dateLabel,
  dateRange,
  formatSummaryLines,
  generateGroupSummary,
  resolveSummaryDate,
} from "../bridge/group-summary.mjs";

describe("group summary", () => {
  it("builds Beijing date range and label", () => {
    const range = dateRange("2026-06-23");
    assert.equal(new Date(range.start).toISOString(), "2026-06-22T16:00:00.000Z");
    assert.equal(dateLabel("2026-06-23"), "6月23日");
  });

  it("defaults to yesterday shortly after midnight", () => {
    assert.equal(resolveSummaryDate(new Date("2026-06-22T16:30:00.000Z")), "2026-06-22");
    assert.equal(resolveSummaryDate(new Date("2026-06-22T15:55:00.000Z")), "2026-06-22");
    assert.equal(resolveSummaryDate(new Date("2026-06-23T04:00:00.000Z")), "2026-06-23");
  });

  it("counts speakers and formats sanitized lines", () => {
    const messages = [
      { uid: "1", nickname: "[alice]", text: "hello\nworld", ts: Date.parse("2026-06-23T01:00:00+08:00") },
      { uid: "1", nickname: "[alice]", text: "again", ts: Date.parse("2026-06-23T01:01:00+08:00") },
      { uid: "2", nickname: "bob", text: "", ts: Date.parse("2026-06-23T01:02:00+08:00") },
    ];
    const stats = buildSummaryStats(messages);
    assert.equal(stats.messageCount, 3);
    assert.equal(stats.speakerCount, 2);
    assert.match(stats.top3, /alice/);
    assert.doesNotMatch(formatSummaryLines(messages), /\[alice\]/);
  });

  it("builds prompt with output safety requirements", () => {
    const prompt = buildGroupSummaryPrompt([
      { uid: "1", nickname: "alice", text: "今天聊 bot 修复", ts: Date.parse("2026-06-23T01:00:00+08:00") },
    ], { dateText: "2026-06-23", groupName: "测试群" });
    assert.match(prompt, /群聊小报/);
    assert.match(prompt, /不要输出思考过程/);
    assert.match(prompt, /1 条消息，1 位群友发言/);
    assert.match(prompt, /结构化摘要/);
    assert.match(prompt, /机器人\/模型/);
  });

  it("builds digest with topic hints and safe quote candidates", () => {
    const digest = buildSummaryDigest([
      { uid: "1", nickname: "[alice]", text: "夜星 bot 自动回复又修好了！", ts: Date.parse("2026-06-23T09:00:00+08:00") },
      { uid: "2", nickname: "bob", text: "jm 下载压缩包密码 FS", imageUrls: ["https://example.com/a.jpg"], ts: Date.parse("2026-06-23T21:00:00+08:00") },
      { uid: "3", nickname: "cat", text: "我的 token 是 sk-abcdefghijklmnop", ts: Date.parse("2026-06-23T22:00:00+08:00") },
    ]);
    assert.equal(digest.messageCount, 3);
    assert.ok(digest.topicHints.some(item => item.name === "机器人/模型"));
    assert.ok(digest.topicHints.some(item => item.name === "JM/资源"));
    assert.equal(digest.imageCount, 1);
    assert.equal(digest.botMentionCount, 1);
    assert.notDeepStrictEqual(digest.quoteCandidates.map(item => item.text), ["我的 token 是 sk-abcdefghijklmnop"]);
  });

  it("uses local fallback for low-message summaries", async () => {
    const summary = await generateGroupSummary([
      { uid: "1", nickname: "alice", text: "今天群里比较安静", ts: Date.parse("2026-06-23T09:00:00+08:00") },
    ], { dateText: "2026-06-23", groupName: "测试群" });
    assert.match(summary, /群聊小报/);
    assert.match(summary, /比较安静/);
    assert.match(summary, /1 条消息/);
  });

  it("falls back to a local summary when model providers fail", async () => {
    const messages = [
      { uid: "1", nickname: "alice", text: "今天聊 bot 修复", ts: Date.parse("2026-06-23T09:00:00+08:00") },
      { uid: "2", nickname: "bob", text: "jm 下载又试了一下", ts: Date.parse("2026-06-23T10:00:00+08:00") },
      { uid: "3", nickname: "cat", text: "日志里有报错需要看", ts: Date.parse("2026-06-23T11:00:00+08:00") },
      { uid: "4", nickname: "dog", text: "自动回复概率调高", ts: Date.parse("2026-06-23T12:00:00+08:00") },
      { uid: "5", nickname: "eel", text: "晚上再测试一遍", ts: Date.parse("2026-06-23T18:00:00+08:00") },
      { uid: "6", nickname: "fox", text: "白名单也确认了", ts: Date.parse("2026-06-23T19:00:00+08:00") },
      { uid: "7", nickname: "gnu", text: "模块化挺清楚", ts: Date.parse("2026-06-23T20:00:00+08:00") },
      { uid: "8", nickname: "hen", text: "最后跑 npm test", ts: Date.parse("2026-06-23T21:00:00+08:00") },
    ];
    const summary = await generateGroupSummary(messages, {
      dateText: "2026-06-23",
      groupName: "测试群",
      callMiMoSummary: async () => ({ choices: [{ message: { content: "" } }] }),
      callDeepSeekSummary: async () => null,
    });
    assert.match(summary, /群聊小报/);
    assert.match(summary, /8 条消息/);
    assert.match(summary, /活跃之星/);
  });

  it("builds a local fallback directly", () => {
    const summary = buildLocalSummaryFallback([
      { uid: "1", nickname: "alice", text: "今天聊 bot 修复", ts: Date.parse("2026-06-23T09:00:00+08:00") },
    ], { dateText: "2026-06-23", groupName: "测试群" });
    assert.match(summary, /测试群/);
    assert.match(summary, /群聊小报/);
  });
});
