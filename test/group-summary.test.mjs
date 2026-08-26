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
  prepareSummaryEvidence,
  redactSummaryText,
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
    assert.match(prompt, /群聊分析日报/);
    assert.match(prompt, /只输出最终日报正文/);
    assert.match(prompt, /原始消息 1 条；有效分析证据 1 条；人类发言者 1 位/);
    assert.match(prompt, /系统统计事实/);
    assert.match(prompt, /机器人\/模型/);
    assert.match(prompt, /经过、结果、状态/);
    assert.match(prompt, /参与概况：1 条消息，1 位群友发言；参与较多者：/);
    assert.doesNotMatch(prompt, /活跃之星必须写/);
    assert.doesNotMatch(prompt, /\n- 复读事件：|\n- 已从分析证据中过滤：/);
  });

  it("builds digest with topic hints and safe quote candidates", () => {
    const digest = buildSummaryDigest([
      { uid: "1", nickname: "[alice]", text: "夜星 bot 自动回复又修好了！", ts: Date.parse("2026-06-23T09:00:00+08:00") },
      { uid: "2", nickname: "bob", text: "今天讨论 jm 下载压缩包密码 FS", imageUrls: ["https://example.com/a.jpg"], ts: Date.parse("2026-06-23T21:00:00+08:00") },
      { uid: "3", nickname: "cat", text: "我的 token 是 sk-abcdefghijklmnop", ts: Date.parse("2026-06-23T22:00:00+08:00") },
    ]);
    assert.equal(digest.messageCount, 3);
    assert.ok(digest.topicHints.some(item => item.name === "机器人/模型"));
    assert.ok(digest.topicHints.some(item => item.name === "JM/资源"));
    assert.equal(digest.imageCount, 1);
    assert.equal(digest.botMentionCount, 1);
    assert.notDeepStrictEqual(digest.quoteCandidates.map(item => item.text), ["我的 token 是 sk-abcdefghijklmnop"]);
  });

  it("filters bot messages, commands, noise and short-window repeats from evidence", () => {
    const base = Date.parse("2026-06-23T09:00:00+08:00");
    const evidence = prepareSummaryEvidence([
      { uid: "1", nickname: "alice", text: "修复已经完成!!!", ts: base },
      { uid: "2", nickname: "bob", text: "修复已经完成！", ts: base + 60_000 },
      { uid: "3", nickname: "cat", text: "[CQ:at,qq=999] 日报预览 昨天", ts: base + 120_000 },
      { uid: "999", nickname: "夜星", text: "机器人回复", ts: base + 180_000 },
      { uid: "4", nickname: "dog", text: "？？？", ts: base + 240_000 },
      { uid: "5", nickname: "eel", text: "晚上继续验证连接", ts: base + 300_000 },
    ], { selfUin: 999 });

    assert.deepEqual(evidence.messages.map(item => item.text), ["修复已经完成!!!", "晚上继续验证连接"]);
    assert.equal(evidence.metrics.repeatMessageCount, 1);
    assert.equal(evidence.metrics.commandMessageCount, 1);
    assert.equal(evidence.metrics.botMessageCount, 1);
    assert.equal(evidence.metrics.noiseMessageCount, 1);
    assert.deepEqual(evidence.repeatEvents.map(item => item.count), [2]);
  });

  it("redacts credentials, network addresses, links and long identifiers before prompting", () => {
    const raw = "sk-abcdefghijklmnop https://example.com 192.168.1.2:8080 2408:8360:a012::1 123456789";
    const redacted = redactSummaryText(raw);
    assert.doesNotMatch(redacted, /abcdefghijklmnop|example\.com|192\.168|2408:8360|123456789/);
    assert.match(redacted, /已隐藏/);
  });

  it("uses local fallback for low-message summaries", async () => {
    const summary = await generateGroupSummary([
      { uid: "1", nickname: "alice", text: "今天群里比较安静", ts: Date.parse("2026-06-23T09:00:00+08:00") },
    ], { dateText: "2026-06-23", groupName: "测试群" });
    assert.match(summary, /群聊日报/);
    assert.match(summary, /有效记录较少/);
    assert.match(summary, /1 条消息/);
  });

  it("falls back to a local summary when model providers fail", async () => {
    const messages = [
      { uid: "1", nickname: "alice", text: "今天聊 bot 修复", ts: Date.parse("2026-06-23T09:00:00+08:00") },
      { uid: "2", nickname: "bob", text: "有人把 jm 下载又试了一下", ts: Date.parse("2026-06-23T10:00:00+08:00") },
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
      callPrimarySummary: async () => ({ choices: [{ message: { content: "" } }] }),
      callFallbackSummary: async () => null,
    });
    assert.match(summary, /群聊日报/);
    assert.match(summary, /8 条消息/);
    assert.match(summary, /关键线索/);
    assert.match(summary, /机器人\/模型|JM\/资源|运维\/代码/);
    assert.match(summary, /结果未确认/);
    assert.doesNotMatch(summary, /模型暂未生成|正文为空|API/);
  });

  it("removes internal filtering notes from model output", async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      uid: String(index + 1),
      nickname: "群友" + (index + 1),
      text: "第" + (index + 1) + "条独立讨论记录",
      ts: Date.parse("2026-06-23T09:00:00+08:00") + index * 60_000,
    }));
    const summary = await generateGroupSummary(messages, {
      callPrimarySummary: async () => ({
        choices: [{ message: { content: "【群聊日报】\n关键讨论正常。\n结果：双方互骂死妈，结案。\n值得注意：两次复读未进入有效讨论。\n参与概况：8 条消息。" } }],
      }),
    });
    assert.match(summary, /关键讨论正常/);
    assert.doesNotMatch(summary, /复读|未进入有效讨论/);
    assert.doesNotMatch(summary, /死妈|双方互骂/);
    assert.match(summary, /没有足够信息确认现实处理结果/);
  });

  it("builds a local fallback directly", () => {
    const summary = buildLocalSummaryFallback([
      { uid: "1", nickname: "alice", text: "今天聊 bot 修复", ts: Date.parse("2026-06-23T09:00:00+08:00") },
    ], { dateText: "2026-06-23", groupName: "测试群" });
    assert.match(summary, /群聊日报/);
    assert.match(summary, /不推测讨论结果/);
  });
});
