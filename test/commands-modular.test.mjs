import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCommandReply,
  buildGroupCommandReply,
  commandAliasesForId,
  commandIds,
  isAdminUser,
  normalizeCommand,
  stripBotMention,
} from "../bridge/commands/index.mjs";
import { buildAdminHelpText, buildHelpPage1, buildHelpPage2 } from "../bridge/help.mjs";

describe("modular command entry", () => {
  it("exposes the same parsing and dispatch surface as the compatibility facade", () => {
    assert.equal(stripBotMention("@夜星 help", 0, ["夜星"]), "help");
    assert.equal(normalizeCommand("/HELP！"), "help");
    assert.equal(isAdminUser("42", [42]), true);
    assert.equal(buildCommandReply("测试", { userId: 1 }), "pong");
  });

  it("keeps group dispatch mention-gated through the modular dispatcher", () => {
    assert.equal(buildGroupCommandReply({
      isAtMe: false,
      text: "help",
      user_id: 1,
      group_id: 1,
    }), null);

    const reply = buildGroupCommandReply({
      isAtMe: true,
      text: "@夜星 help",
      user_id: 1,
      group_id: 1,
    }, { botNames: ["夜星"] });
    assert.match(reply, /夜星能力中心/);
  });

  it("exposes a declarative command manifest for help and registry", () => {
    const ids = commandIds();
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("ping"));
    assert.ok(ids.includes("admin-help"));
    assert.ok(ids.includes("memory-status"));
    assert.ok(commandAliasesForId("ping").includes("测试"));

    assert.match(buildHelpPage1(), /聊天与识图/);
    assert.match(buildHelpPage2(), /群聊工具/);
    const adminHelp = buildAdminHelpText();
    assert.match(adminHelp, /查看画像状态：memory status/);
    assert.doesNotMatch(adminHelp, /<qq>|csv\|json/i);
  });
});
