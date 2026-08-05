import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCommandReply,
  buildCommandReplyAsync,
  buildGroupCommandReplyAsync,
} from "../bridge/admin-commands.mjs";
import {
  buildGroupSummaryCommandReply,
  parseGroupSummaryCommand,
} from "../bridge/group-summary/commands.mjs";
import {
  generateGroupSummaryResult,
  normalizeSummaryStyle,
  previewGroupSummary,
  sendGroupSummaryForDate,
} from "../bridge/group-summary.mjs";

function sampleMessages(count = 8) {
  const base = Date.parse("2026-06-26T09:00:00+08:00");
  return Array.from({ length: count }, (_, index) => ({
    uid: String(index + 1),
    nickname: "user" + (index + 1),
    text: index % 2 ? `讨论 jm 下载和资源测试 ${index}` : `夜星 bot 自动回复修复 ${index}`,
    ts: base + index * 60000,
  }));
}

describe("group summary commands", () => {
  it("parses date, group and style arguments", () => {
    const parsed = parseGroupSummaryCommand("日报预览 2000000002 昨天 short", {
      now: new Date("2026-06-27T01:00:00+08:00"),
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "preview");
    assert.equal(parsed.groupId, 2000000002);
    assert.equal(parsed.dateText, "2026-06-26");
    assert.equal(parsed.style, "short");
    assert.equal(normalizeSummaryStyle("技术"), "technical");
  });

  it("requires admin permission through command facade", async () => {
    const reply = await buildCommandReplyAsync("日报预览 昨天", {
      userId: 7,
      admins: ["42"],
    });
    assert.match(reply, /管理员权限/);
    assert.match(buildCommandReply("日报预览 昨天", {
      userId: 42,
      admins: ["42"],
    }), /异步处理/);
  });

  it("previews summary without sending to group", async () => {
    let sent = false;
    const reply = await buildGroupSummaryCommandReply("日报预览 2000000002 2026-06-26 short", {
      userId: 42,
      admins: ["42"],
      groupWhitelist: [2000000002],
      summaryMessages: sampleMessages(2),
      sendGroupMessage: async () => { sent = true; },
    });
    assert.equal(sent, false);
    assert.match(reply, /日报预览完成/);
    assert.match(reply, /local-low-data/);
    assert.match(reply, /2000000002/);
    assert.match(reply, /群聊日报/);
  });

  it("sends summary to whitelisted target group", async () => {
    const sends = [];
    const reply = await buildGroupSummaryCommandReply("日报发送 2000000002 2026-06-26 technical", {
      userId: 42,
      admins: ["42"],
      groupWhitelist: [2000000002],
      summaryMessages: sampleMessages(8),
      callPrimarySummary: async () => ({ provider: "deepseek", choices: [{ message: { content: "模型日报正文" }, finish_reason: "stop" }] }),
      sendGroupMessage: async (groupId, text) => {
        sends.push({ groupId, text });
        return { status: "ok" };
      },
    });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].groupId, 2000000002);
    assert.equal(sends[0].text, "模型日报正文");
    assert.match(reply, /日报已发送/);
    assert.match(reply, /deepseek/);
  });

  it("does not report or mark a failed outbound summary as sent", async () => {
    const result = await sendGroupSummaryForDate({
      groupId: 2000000002,
      dateText: "2026-06-26",
      groupWhitelist: [2000000002],
      messages: sampleMessages(8),
      callPrimarySummary: async () => ({ provider: "deepseek", choices: [{ message: { content: "模型日报正文" } }] }),
      sendGroupMessage: async () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.sent, false);
    assert.equal(result.error, "send_failed");
    assert.match(result.message, /可以稍后重试/);
  });

  it("rejects non-whitelisted groups and reports no messages", async () => {
    const blocked = await buildGroupSummaryCommandReply("日报预览 123456 2026-06-26", {
      userId: 42,
      admins: ["42"],
      groupWhitelist: [2000000002],
    });
    assert.match(blocked, /白名单/);

    const noMessages = await buildGroupSummaryCommandReply("日报预览 2000000002 2026-06-26", {
      userId: 42,
      admins: ["42"],
      groupWhitelist: [2000000002],
      summaryMessages: [],
    });
    assert.match(noMessages, /没有可生成日报/);
  });

  it("keeps excluded groups out of the default summary whitelist", async () => {
    for (const groupId of [2000000004, 2000000005]) {
      const result = await previewGroupSummary({
        groupId,
        dateText: "2026-06-26",
        messages: sampleMessages(8),
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "group_not_allowed");
    }
  });

  it("works through mentioned group async command entry", async () => {
    const reply = await buildGroupCommandReplyAsync({
      isAtMe: true,
      text: "@夜星 日报预览 2000000002 2026-06-26 short",
      rawText: "[CQ:at,qq=1000000001] 日报预览 2000000002 2026-06-26 short",
      user_id: 42,
      group_id: 2000000002,
    }, {
      admins: ["42"],
      groupWhitelist: [2000000002],
      summaryMessages: sampleMessages(1),
    });
    assert.match(reply, /日报预览完成/);
  });

  it("exposes provider metadata from summary generation", async () => {
    const result = await generateGroupSummaryResult(sampleMessages(8), {
      dateText: "2026-06-26",
      callPrimarySummary: async () => ({ choices: [{ message: { content: "" } }] }),
      callFallbackSummary: async () => null,
    });
    assert.equal(result.provider, "local-fallback");
    assert.match(result.text, /群聊日报/);
    assert.ok(result.digest);
  });

  it("reports the real provider when the fallback slot generates the summary", async () => {
    const result = await generateGroupSummaryResult(sampleMessages(8), {
      dateText: "2026-06-26",
      callPrimarySummary: async () => null,
      callFallbackSummary: async () => ({
        provider: "mimo-25-pro",
        choices: [{ message: { content: "备用模型日报" } }],
      }),
    });
    assert.equal(result.provider, "mimo-25-pro");
    assert.equal(result.text, "备用模型日报");
  });
});
