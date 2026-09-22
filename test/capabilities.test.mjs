import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CFG } from "../bridge/config.mjs";
import {
  buildCapabilityCatalog,
  buildCapabilityHelpText,
  buildUnknownCommandSuggestion,
  parseCapabilityHelpCommand,
} from "../bridge/capabilities/catalog.mjs";

function testConfig(overrides = {}) {
  return {
    ...CFG,
    mimoKey: "configured",
    dsKey: "configured",
    doubaoKey: "configured",
    jmPython: "python",
    groupWhitelist: [100, 999],
    friendWhitelist: [200],
    summaryGroupWhitelist: [100],
    featureGroupWhitelist: [100],
    resourceGroupWhitelist: [100],
    jmUserWhitelist: [200],
    linkPreviewEnabled: true,
    memeLearningMode: "steady",
    ...overrides,
  };
}

describe("capability center", () => {
  it("builds a six-category chat hub", () => {
    const text = buildCapabilityHelpText("", { cfg: testConfig(), surface: "group", groupId: 100 });
    assert.match(text, /夜星能力中心/);
    assert.match(text, /1\s+聊天与识图/);
    assert.match(text, /6\s+状态与版本/);
    assert.match(text, /@夜星 帮助 3/);
  });

  it("supports numbered and natural-language capability queries", () => {
    assert.deepEqual(parseCapabilityHelpCommand("帮助 3"), { matched: true, query: "3" });
    assert.deepEqual(parseCapabilityHelpCommand("JM怎么用"), { matched: true, query: "jm" });
    assert.deepEqual(parseCapabilityHelpCommand("能识图吗"), { matched: true, query: "识图" });

    const text = buildCapabilityHelpText("JM", { cfg: testConfig(), surface: "group", groupId: 100 });
    assert.match(text, /JM 与资源/);
    assert.match(text, /JM 下载转发 \[本群可用\]/);
  });

  it("reports group and private whitelist availability without exposing ids", () => {
    const cfg = testConfig();
    const blockedGroup = buildCapabilityCatalog({ cfg, surface: "group", groupId: 999 });
    const jmGroup = blockedGroup.capabilities.find(item => item.id === "resources.jm");
    assert.equal(jmGroup.status, "limited");
    assert.equal(jmGroup.statusLabel, "本群未开放");

    const privateCatalog = buildCapabilityCatalog({ cfg, surface: "private", userId: 200 });
    const jmPrivate = privateCatalog.capabilities.find(item => item.id === "resources.jm");
    assert.equal(jmPrivate.status, "available");
    const publicData = JSON.stringify(privateCatalog, (key, value) => ["generatedAt", "checkedAt"].includes(key) ? undefined : value);
    assert.equal(publicData.includes("100"), false);
    assert.equal(publicData.includes("200"), false);
  });

  it("suggests only close command-like typos", () => {
    const options = { cfg: testConfig(), surface: "group", groupId: 100 };
    assert.match(buildUnknownCommandSuggestion("jn 123456", options), /JM 下载转发/);
    assert.equal(buildUnknownCommandSuggestion("今天心情不太好", options), null);
  });

  it("reads model task readiness rather than legacy key flags or fixed provider names", () => {
    const modelHealth = { tasks: { group_chat: { ready: true, primary: { ready: true } }, private_chat: { ready: false } } };
    const cfg = testConfig({ mimoKey: "", dsKey: "", doubaoKey: "" });
    const group = buildCapabilityCatalog({ cfg, modelHealth, surface: "group", groupId: 100 }).capabilities;
    const chat = group.find(item => item.id === "chat.reply");
    assert.equal(chat.status, "available");
    assert.equal(chat.state.health, "configured");
    assert.doesNotMatch(chat.statusDetail, /MiMo|DeepSeek/);
    const direct = buildCapabilityCatalog({ cfg, modelHealth, surface: "private", userId: 200 });
    assert.equal(direct.capabilities.find(item => item.id === "chat.reply").status, "unavailable");
    assert.equal(group.find(item => item.id === "vision.context").status, "unavailable");
    const consoleView = buildCapabilityCatalog({ cfg, modelHealth, surface: "console" }).capabilities;
    assert.equal(consoleView.find(item => item.id === "chat.reply").status, "limited");
    assert.match(consoleView.find(item => item.id === "chat.reply").statusDetail, /私聊模型配置不可用/);
  });

  it("requires the bot group admission and blacklist before exposing permission", () => {
    const cfg = testConfig({ botBlacklist: [300] });
    for (const scope of [{ groupId: 888, userId: 200 }, { groupId: 100, userId: 300 }]) {
      const catalog = buildCapabilityCatalog({ cfg, surface: "group", ...scope });
      assert.ok(catalog.capabilities.every(item => item.state.permitted === false));
    }
  });

  it("keeps admin private command exemption separate from AI chat and JM", () => {
    const cfg = testConfig({ adminUins: [300], jmUserWhitelist: [200] });
    const catalog = buildCapabilityCatalog({ cfg, surface: "private", userId: 300 });
    const item = id => catalog.capabilities.find(entry => entry.id === id);
    assert.equal(item("admin.operations").state.permitted, true);
    assert.equal(item("chat.reply").state.permitted, false);
    assert.equal(item("resources.jm").state.permitted, false);
    assert.equal(item("admin.relationship-export").status, "reserved");
    const ordinary = buildCapabilityCatalog({ cfg, surface: "private", userId: 200 });
    assert.ok(ordinary.capabilities.every(entry => entry.permission !== "admin"));
  });

  it("uses cached JM dependency readiness without conflating private and group access", () => {
    const cfg = testConfig({ jmPython: "", friendWhitelist: [], resourceGroupWhitelist: [] });
    const options = { cfg, surface: "private", userId: 200,
      jmHealth: { dependencyReady: true, sevenZipReady: true, checkedAt: "2026-09-23T00:00:00Z" } };
    const jm = value => buildCapabilityCatalog(value).capabilities.find(item => item.id === "resources.jm");
    assert.equal(jm(options).status, "available");
    assert.equal(jm({ ...options, jmHealth: { dependencyReady: false, sevenZipReady: true } }).state.health, "degraded");
    assert.equal(jm({ ...options, jmHealth: { ...options.jmHealth, stale: true } }).statusLabel, "检查中");
    assert.equal(jm({ ...options, userId: 301 }).state.permitted, false);
  });

  it("distinguishes disabled modules from caller permission and console scope", () => {
    const cfg = testConfig({ linkPreviewEnabled: false });
    const get = options => buildCapabilityCatalog({ cfg, ...options }).capabilities.find(item => item.id === "group.link-preview");
    assert.equal(get({ surface: "group", groupId: 888 }).state.enabled, false);
    assert.equal(get({ surface: "group", groupId: 888 }).state.permitted, false);
    assert.equal(get({ surface: "console" }).state.permitted, null);
    assert.equal(get({ surface: "group" }).state.permitted, null);
  });

  it("allows enabled private stickers without requiring a group sticker whitelist", () => {
    const catalog = buildCapabilityCatalog({ cfg: testConfig({ stickerEnabled: true, stickerGroupWhitelist: [] }),
      surface: "private", userId: 200, stickerSettings: { mode: "steady", privateEnabled: true, allowedGroups: [] } });
    assert.equal(catalog.capabilities.find(item => item.id === "memes.stickers").status, "available");
  });
});
