import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCommandReply,
  buildCommandReplyAsync,
  buildGroupCommandReply,
  buildPrivateCommandReply,
  isAdminUser,
  normalizeCommand,
  stripBotMention,
} from "../bridge/admin-commands.mjs";
import { CFG } from "../bridge/config.mjs";
import { VERSION } from "../bridge/version.mjs";

describe("admin command parsing", () => {
  it("strips CQ at and visible bot mention", () => {
    assert.equal(stripBotMention("[CQ:at,qq=1000000001] help", 1000000001), "help");
    assert.equal(stripBotMention("@夜星 状态", 1000000001), "状态");
    assert.ok(CFG.botNames.length > 0);
    assert.equal(stripBotMention("@CustomBot help", 1000000001, ["CustomBot"]), "help");
    assert.equal(stripBotMention("@Yexing version", 1000000001, ["Yexing"]), "version");
    assert.equal(normalizeCommand(" admin   help "), "admin help");
  });

  it("does not trigger group commands without mention", () => {
    const reply = buildGroupCommandReply({
      isAtMe: false,
      text: "help",
      rawText: "help",
      user_id: 1,
    });
    assert.equal(reply, null);
  });

  it("triggers group commands when mentioned", () => {
    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: "help",
      rawText: "[CQ:at,qq=1000000001] help",
      user_id: 1,
    }, { selfUin: 1000000001 });
    assert.match(reply, /夜星能力中心/);
  });

  it("triggers group commands through configured bot names", () => {
    const configuredName = CFG.botNames[0];
    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: `@${configuredName} help`,
      rawText: `@${configuredName} help`,
      user_id: 1,
    }, { botNames: CFG.botNames });
    assert.match(reply, /夜星能力中心/);
  });

  it("supports split help pages", () => {
    assert.match(buildCommandReply("help1", { userId: 1 }), /1\/6 聊天与识图/);
    assert.match(buildCommandReply("help 2", { userId: 1 }), /2\/6 群聊工具/);
    assert.match(buildCommandReply("帮助1", { userId: 1 }), /1\/6 聊天与识图/);
    assert.match(buildCommandReply("帮助2", { userId: 1 }), /2\/6 群聊工具/);
  });

  it("allows private commands without mention", () => {
    const reply = buildPrivateCommandReply({ text: "测试", user_id: 1 });
    assert.equal(reply, "pong");
  });

  it("requires admin permission for admin help and runtime", () => {
    assert.equal(isAdminUser(42, ["42"]), true);
    assert.equal(isAdminUser(7, ["42"]), false);
    assert.match(buildCommandReply("admin help", { userId: 7, admins: ["42"] }), /管理员权限/);
    assert.match(buildCommandReply("runtime", { userId: 7, admins: ["42"] }), /管理员权限/);
    assert.match(buildCommandReply("admin help", { userId: 42, admins: ["42"] }), /管理员帮助/);
    assert.match(buildCommandReply("runtime", {
      userId: 42,
      admins: ["42"],
      runtime: { uptime: 12, memory: 1024 * 1024 },
    }), /状态：正常/);
  });

  it("covers all admin commands across permissions and chat types", () => {
    const admin = 42;
    const normal = 7;
    const admins = ["42"];
    const runtime = { uptime: 12, memory: 1024 * 1024 };
    const commands = [
      ["admin help", /管理员帮助/],
      ["管理帮助", /管理员帮助/],
      ["runtime", /状态：正常/],
      ["运行状态", /状态：正常/],
      ["memory status", /记忆画像状态/],
      ["memory summary 999998", /暂无可用画像/],
      ["memory clear user 999998", /999998/],
      ["memory clear group", /当前群画像/],
      ["export-relationships", /reserved|不会导出关系表/],
      ["export-relationships json", /reserved|不会导出关系表/],
      ["/export-relationships", /reserved|不会导出关系表/],
    ];

    for (const [command, expected] of commands) {
      assert.match(buildCommandReply(command, {
        userId: admin,
        admins,
        groupId: 999998,
        runtime,
      }), expected, command);
      assert.match(buildCommandReply(command, {
        userId: normal,
        admins,
        groupId: 999998,
        runtime,
      }), /管理员权限/, command);
    }

    assert.equal(buildGroupCommandReply({
      isAtMe: false,
      text: "runtime",
      rawText: "runtime",
      user_id: admin,
      group_id: 999998,
    }, { admins, runtime }), null);

    assert.match(buildGroupCommandReply({
      isAtMe: true,
      text: "@夜星 运行状态",
      rawText: "[CQ:at,qq=1000000001] 运行状态",
      user_id: admin,
      group_id: 999998,
    }, { admins, runtime }), /状态：正常/);

    assert.match(buildPrivateCommandReply({
      text: "管理帮助",
      user_id: admin,
    }, { admins, runtime }), /管理员帮助/);
  });

  it("returns low-data relationship text without scores or storage behavior", () => {
    const reply = buildCommandReply("好感度", { userId: 1 });
    assert.equal(reply, "互动记录还不够，暂时算不出关系状态。这里的‘好感度’指互动熟悉度，不是恋爱含义。");
    assert.doesNotMatch(reply, /下一版本启用/);
    assert.doesNotMatch(reply, /\d+\/100|affinity|familiarity/);
  });

  it("returns real relationship summary when user data exists", () => {
    const now = Date.now();
    const day = 86400000;
    const users = {
      "42": {
        nicknames: ["测试君"],
        firstSeen: new Date(now - 30 * day).toISOString(),
        chats: (() => {
          const a = [];
          for (let i = 0; i < 86; i++) a.push({ group: "1", text: "msg" + i, ts: now - i * day });
          return a;
        })(),
      },
    };
    const reply = buildCommandReply("好感度", { userId: 42, users, groupId: 1, groupChats: [] });
    assert.ok(reply.includes("你和我的互动状态"));
    assert.ok(reply.match(/熟悉度：[\d.]+\/100/), "contains familiarity score");
    assert.ok(reply.includes("这里的‘好感度’"));
    assert.ok(reply.includes("测试君"));
    assert.ok(!reply.includes("预留"));
  });

  it("group relationship command can target a mentioned user", () => {
    const now = Date.now();
    const users = {
      "42": {
        nicknames: ["发令者"],
        firstSeen: new Date(now - 5 * 86400000).toISOString(),
        chats: [{ group: "1", text: "sender", ts: now }],
      },
      "1000000002": {
        nicknames: ["目标用户"],
        firstSeen: new Date(now - 30 * 86400000).toISOString(),
        chats: Array.from({ length: 40 }, (_, i) => ({
          group: "1",
          text: "target msg " + i,
          ts: now - i * 3600000,
        })),
      },
    };
    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: "好感度",
      rawText: "[CQ:at,qq=1000000001][CQ:at,qq=1000000002] 好感度",
      user_id: 42,
      group_id: 1,
      mentions: [
        { qq: "1000000001", isBot: true, isAll: false },
        { qq: "1000000002", isBot: false, isAll: false, displayName: "群名片目标" },
      ],
      mentionedUsers: [
        { qq: "1000000002", isBot: false, isAll: false, displayName: "群名片目标" },
      ],
    }, { users, groupChats: [] });

    assert.match(reply, /我和 群名片目标 的互动状态/);
    assert.match(reply, /目标用户/);
    assert.doesNotMatch(reply, /发令者/);
  });

  it("private command returns real relationship summary", () => {
    const now = Date.now();
    const users = {
      "99": {
        nicknames: ["私聊用户"],
        firstSeen: now - 5000,
        chats: [{ group: "0", text: "你好", ts: now - 1000 }],
      },
    };
    const reply = buildCommandReply("好感度", { userId: 99, users, groupId: 0, groupChats: [] });
    assert.ok(reply.includes("你和我的互动状态"));
    assert.ok(reply.includes("私聊用户"));
  });

  it("async relationship command includes generated short comment", async () => {
    const now = Date.now();
    const users = {
      "88": {
        nicknames: ["异步用户"],
        firstSeen: now - 10 * 86400000,
        chats: [
          { group: "1", text: "上下文系统继续改", ts: now - 1000 },
          { group: "1", text: "自动回复日志看看", ts: now - 2000 },
        ],
      },
    };
    const reply = await buildCommandReplyAsync("好感度", {
      userId: 88,
      groupId: 1,
      users,
      callMiMo: async () => "你更像会追着问题往下挖的技术搭子，回复你时直接给结论会更顺手。",
    });
    assert.match(reply, /夜星短评/);
    assert.match(reply, /技术搭子/);
    assert.equal(users["88"].relationshipComments["1"].messageCount, 2);
  });

  it("export-relationships still reserved", () => {
    const reply = buildCommandReply("/export-relationships", { userId: 1, admins: ["1"] });
    assert.ok(reply.includes("reserved") || reply.includes("不会导出关系表"));
    const noSlashReply = buildGroupCommandReply({
      isAtMe: true,
      text: "export-relationships",
      rawText: "[CQ:at,qq=1000000001] export-relationships",
      user_id: 1,
    }, { selfUin: 1000000001, admins: ["1"] });
    assert.ok(noSlashReply.includes("reserved") || noSlashReply.includes("不会导出关系表"));
  });

  it("returns version update log for group update aliases", () => {
    for (const command of ["更新", "更新日志"]) {
      const reply = buildGroupCommandReply({
        isAtMe: true,
        text: command,
        rawText: "[CQ:at,qq=1000000001] " + command,
        user_id: 1,
      }, { selfUin: 1000000001 });
      assert.match(reply, new RegExp(VERSION));
      assert.match(reply, /memory status/);
      assert.match(reply, /回复风格/);
      assert.match(reply, /export-relationships/);
      assert.doesNotMatch(reply, /key|token|secret/i);
    }
  });

  it("returns English changelog for group changelog command", () => {
    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: "changelog",
      rawText: "[CQ:at,qq=1000000001] changelog",
      user_id: 1,
    }, { selfUin: 1000000001 });
    assert.match(reply, new RegExp("Current version: v" + VERSION));
    assert.match(reply, /Still reserved:/);
    assert.match(reply, /export-relationships/);
    assert.match(reply, /dedicated cards/);
    assert.match(reply, /official REST API/);
    assert.match(reply, /Bilibili parsing/);
    assert.doesNotMatch(reply, /key|token|secret/i);
  });

  it("allows private update log command without mention", () => {
    const reply = buildPrivateCommandReply({ text: "更新", user_id: 1 });
    assert.match(reply, new RegExp(VERSION));
    assert.doesNotMatch(reply, /npm test 150\/150 pass/);
    assert.match(reply, /lint 0 errors \/ 0 warnings/);
  });

  it("supports personalized profile and style commands", () => {
    const users = {};
    const setName = buildCommandReply("设置称呼 Codex君", { userId: 42, users, skipSave: true });
    assert.match(setName, /Codex君/);

    const setStyle = buildCommandReply("回复风格 简短 技术 少吐槽 给步骤", { userId: 42, users, skipSave: true });
    assert.match(setStyle, /技术/);
    assert.match(setStyle, /少吐槽/);

    const profile = buildCommandReply("我的档案", {
      userId: 42,
      users,
      memoryContext: {
        userProfile: { commonTopics: ["机器人"], confidence: 0.5 },
        userGroupProfile: { recentTopics: ["运维"], interactionStyle: "technical", confidence: 0.4 },
      },
    });
    assert.match(profile, /我的档案/);
    assert.match(profile, /Codex君/);
    assert.match(profile, /不展示聊天原文/);

    assert.match(buildCommandReply("回复风格 帮助", { userId: 42, users }), /回复风格帮助/);
    assert.match(buildCommandReply("隐私", { userId: 42, users }), /隐私说明/);
  });

  it("supports changelog list, version and keyword queries", () => {
    assert.match(buildCommandReply("更新列表", { userId: 1 }), new RegExp("v" + VERSION));
    assert.match(buildCommandReply("更新 v1.2.3", { userId: 1 }), /v1\.2\.3-context-memory/);
    assert.match(buildCommandReply("更新 最近3版", { userId: 1 }), new RegExp("v" + VERSION));
    assert.match(buildCommandReply("更新 jm", { userId: 1 }), /JM/);
  });

  it("requires admin permission for memory profile commands", () => {
    assert.match(buildCommandReply("memory status", { userId: 7, admins: ["42"] }), /权限/);
    const reply = buildCommandReply("memory status", { userId: 42, admins: ["42"] });
    assert.match(reply, /记忆画像状态/);
    assert.match(reply, /用户画像：/);
  });

  it("supports memory profile admin summaries and clears", () => {
    const noSummary = buildCommandReply("memory summary 12345", { userId: 42, admins: ["42"], groupId: 1 });
    assert.ok(noSummary);
    assert.match(noSummary, /暂无可用画像/);

    const clearUser = buildCommandReply("memory clear user 12345", { userId: 42, admins: ["42"] });
    assert.match(clearUser, /12345/);

    const clearPrivateGroup = buildCommandReply("memory clear group", { userId: 42, admins: ["42"] });
    assert.match(clearPrivateGroup, /memory clear group/);

    const clearGroup = buildCommandReply("memory clear group", { userId: 42, admins: ["42"], groupId: 1 });
    assert.ok(clearGroup);
  });

  it("keeps admin command replies human-readable instead of code-like", () => {
    const help = buildCommandReply("admin help", { userId: 42, admins: ["42"] });
    assert.doesNotMatch(help, /<qq>|csv\|json|memory summary <|memory clear user </i);

    const runtime = buildCommandReply("runtime", {
      userId: 42,
      admins: ["42"],
      runtime: { uptime: 3661, memory: 64 * 1024 * 1024 },
    });
    assert.doesNotMatch(runtime, /status:\s*ok|uptime:|memory:/i);

    const status = buildCommandReply("memory status", { userId: 42, admins: ["42"] });
    assert.doesNotMatch(status, /users:|groups:|userGroups:/);
  });
});
