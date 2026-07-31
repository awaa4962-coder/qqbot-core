import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MODEL_COST_TIERS,
  MODEL_PROVIDERS,
  MODEL_TASKS,
  callChatProvider,
  callRawModelProvider,
  getModelTaskPolicy,
} from "../bridge/model-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("model router boundaries", () => {
  it("declares stable providers and task names", () => {
    assert.equal(MODEL_PROVIDERS.PRIMARY, "mimo");
    assert.equal(MODEL_PROVIDERS.FALLBACK, "deepseek");
    assert.equal(MODEL_TASKS.GROUP_CHAT, "group_chat");
    assert.equal(MODEL_TASKS.INTERJECTION, "interjection");
    assert.equal(MODEL_TASKS.PRIVATE_CHAT, "private_chat");
    assert.equal(MODEL_TASKS.GROUP_SUMMARY, "group_summary");
    assert.equal(MODEL_TASKS.RELATIONSHIP_COMMENT, "relationship_comment");
  });

  it("declares task policies for cost-aware routing", () => {
    const interjection = getModelTaskPolicy(MODEL_TASKS.INTERJECTION);
    assert.equal(interjection.tier, MODEL_COST_TIERS.SMALL);
    assert.equal(interjection.fallback, "local");

    const summary = getModelTaskPolicy(MODEL_TASKS.GROUP_SUMMARY);
    assert.equal(summary.primary, MODEL_PROVIDERS.PRIMARY);
    assert.equal(summary.fallback, MODEL_PROVIDERS.FALLBACK);
    assert.equal(summary.localFirst, true);

    const comment = getModelTaskPolicy(MODEL_TASKS.RELATIONSHIP_COMMENT);
    assert.equal(comment.tier, MODEL_COST_TIERS.SMALL);
    assert.equal(comment.cachePreferred, true);
  });

  it("rejects unknown providers before touching model implementations", async () => {
    await assert.rejects(
      () => callChatProvider("unknown", {}),
      /unknown model provider/
    );
  });

  it("rejects unknown raw providers before touching model implementations", async () => {
    await assert.rejects(
      () => callRawModelProvider("unknown", {}),
      /unknown model provider/
    );
  });

  it("keeps reply modules behind model-router", () => {
    const files = ["reply-ai.mjs", "reply-private.mjs"];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, "bridge", file), "utf8");
      assert.match(source, /model-router\.mjs/, file);
      assert.doesNotMatch(source, /model-mimo\.mjs|model-ds\.mjs/, file);
    }
  });

  it("keeps summary and relationship comments behind model-router", () => {
    const files = [
      "relationship-comment.mjs",
      path.join("group-summary", "providers.mjs"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, "bridge", file), "utf8");
      assert.match(source, /model-router\.mjs/, file);
      assert.doesNotMatch(source, /clients\/providers\/deepseek|api\.xiaomimimo\.com|model-mimo\.mjs/, file);
    }
  });
});
