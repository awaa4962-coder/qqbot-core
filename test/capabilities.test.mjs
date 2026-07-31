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
    assert.equal(JSON.stringify(privateCatalog).includes("100"), false);
    assert.equal(JSON.stringify(privateCatalog).includes("200"), false);
  });

  it("suggests only close command-like typos", () => {
    const options = { cfg: testConfig(), surface: "group", groupId: 100 };
    assert.match(buildUnknownCommandSuggestion("jn 123456", options), /JM 下载转发/);
    assert.equal(buildUnknownCommandSuggestion("今天心情不太好", options), null);
  });
});
