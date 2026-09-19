import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCommandReply, normalizeCommand } from "../bridge/admin-commands.mjs";
import { buildVersionQueryText, buildVersionText, VERSION } from "../bridge/version.mjs";

describe("command normalization and version status", () => {
  it("normalizes English command case and slash prefix", () => {
    assert.equal(normalizeCommand("/HELP"), "help");
    assert.equal(normalizeCommand("CHANGELOG!"), "changelog");
  });

  it("group commands accept uppercase English after bot mention stripping", () => {
    const reply = buildCommandReply("@QQFriend CHANGELOG", {
      requireMention: true,
      selfUin: "123",
      botNames: ["QQFriend"],
    });
    assert.ok(reply);
    assert.ok(reply.includes("Current version"));
  });

  it("version text does not contain stale hard-coded counts", () => {
    const text = buildVersionText("en");
    assert.match(text, new RegExp(VERSION));
    assert.equal(text.includes("150/150"), false);
    assert.equal(text.includes("1 complexity warning"), false);
  });

  it("reads both level-two and legacy level-three changelog headings", () => {
    const text = buildVersionQueryText("更新列表", "zh");
    assert.match(text, /v1\.2\.6-context-aware/);
    assert.match(text, /v1\.2\.5-cognition-core/);
    assert.match(text, /v1\.2\.4-meme-knowledge/);
  });

  it("matches a complete release number without matching later patch prefixes", () => {
    const text = buildVersionQueryText("更新 v1.4.1", "zh");
    assert.match(text, /^v1\.4\.1-runtime-resilience(?:\s|$)/);
    assert.doesNotMatch(text, /^v1\.4\.10/);
    assert.match(buildVersionQueryText("更新 v1.4.10", "zh"), /^v1\.4\.10-summary-evidence(?:\s|$)/);
    assert.match(buildVersionQueryText("更新 v1.4.1-runtime-resilience", "zh"), /^v1\.4\.1-runtime-resilience(?:\s|$)/);
    assert.match(buildVersionQueryText("更新 v1.4.1-runtime", "zh"), /没有找到这个版本/);
    assert.match(buildVersionQueryText("更新 v1.4.100", "zh"), /没有找到这个版本/);
  });
});
