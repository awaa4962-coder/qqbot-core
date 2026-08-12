import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAdminHelpText, buildHelpPage1, buildHelpPage2, buildHelpText } from "../bridge/help.mjs";
import { buildChangelogText, VERSION } from "../bridge/version.mjs";

describe("help text", () => {
  it("builds a compact capability hub and promotes mention format", () => {
    const text = buildHelpText();
    assert.equal(text, buildHelpPage1());
    assert.match(text, /夜星能力中心/);
    assert.match(text, /聊天与识图/);
    assert.match(text, /JM 与资源/);
    assert.match(text, /群聊命令需要 @夜星/);
  });

  it("keeps the legacy page-2 entry mapped to group capabilities", () => {
    const text = buildHelpText(2);
    assert.equal(text, buildHelpPage2());
    assert.match(text, /2\/6 群聊工具/);
    assert.match(text, /群词云/);
    assert.doesNotMatch(text, /说明|reasoning_content|export-relationships/);
  });

  it("builds compact admin help without enabling export", () => {
    const text = buildAdminHelpText();
    assert.match(text, /夜星管理员帮助/);
    assert.match(text, /管理帮助：admin help \/ 管理帮助/);
    assert.match(text, /查看运行状态：runtime \/ 运行状态/);
    assert.match(text, /memory status/);
    assert.match(text, /关系导出：暂未启用/);
    assert.match(text, /不会导出关系表/);
    assert.doesNotMatch(text, /<qq>|csv\|json/i);
  });

  it("builds bilingual version update logs", () => {
    const zh = buildChangelogText("zh");
    assert.match(zh, new RegExp(VERSION));
    assert.match(zh, /memory status/);
    assert.match(zh, /回复风格/);
    assert.match(zh, /export-relationships/);
    assert.doesNotMatch(zh, /key|token|secret/i);

    const en = buildChangelogText("en");
    assert.match(en, new RegExp("Current version: v" + VERSION));
    assert.match(en, /live module health/);
    assert.match(en, /Sticker analysis/);
    assert.match(en, /Vision falls back/);
    assert.match(en, /without blocking/);
    assert.match(en, /Still reserved:/);
  });
});
