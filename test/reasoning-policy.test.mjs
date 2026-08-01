import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyReasoningPolicy,
  defaultReasoningMode,
  getProviderReasoningControl,
  normalizeReasoningMode,
  resolveAutomaticMode,
} from "../bridge/api-providers/reasoning-policy.mjs";

describe("reasoning policy", () => {
  it("uses task-aware defaults", () => {
    assert.equal(defaultReasoningMode("group_chat"), "auto");
    assert.equal(defaultReasoningMode("interjection"), "economy");
    assert.equal(defaultReasoningMode("group_summary"), "deep");
    assert.equal(normalizeReasoningMode("invalid", "sticker_select"), "economy");
  });

  it("resolves auto without another model request", () => {
    assert.equal(resolveAutomaticMode("group_chat", request("你好")), "economy");
    assert.equal(resolveAutomaticMode("group_chat", request("请详细分析这个报错为什么发生，并给出修复方案")), "deep");
    assert.equal(resolveAutomaticMode("group_summary", request("短文本")), "deep");
    assert.equal(resolveAutomaticMode("interjection", request("请详细分析")), "economy");
    assert.equal(resolveAutomaticMode("group_chat", {
      ...request("[图片]"),
      reasoningSignals: { hasImages: true },
    }), "deep");
  });

  it("maps MiMo economy and deep modes to native thinking toggles", () => {
    const provider = mimoProvider();
    const low = applyReasoningPolicy(provider, request("你好"), { task: "group_chat", mode: "economy" });
    const high = applyReasoningPolicy(provider, request("你好"), { task: "group_chat", mode: "deep" });
    assert.deepEqual(low.request.thinking, { type: "disabled" });
    assert.deepEqual(high.request.thinking, { type: "enabled" });
    assert.equal(high.meta.applied, true);
  });

  it("maps auto to a real MiMo on/off decision", () => {
    const provider = mimoProvider();
    const short = applyReasoningPolicy(provider, request("在吗"), { task: "group_chat", mode: "auto" });
    const complex = applyReasoningPolicy(provider, request("请比较两个实现的风险并给出详细方案"), { task: "group_chat", mode: "auto" });
    assert.deepEqual(short.request.thinking, { type: "disabled" });
    assert.deepEqual(complex.request.thinking, { type: "enabled" });
  });

  it("maps Responses providers to effort and leaves DeepSeek untouched", () => {
    const responses = provider({ protocol: "openai-responses", presetId: "openai-responses" });
    const high = applyReasoningPolicy(responses, request("分析"), { task: "group_chat", mode: "deep" });
    assert.deepEqual(high.request.reasoning, { effort: "high" });

    const deepseek = provider({
      id: "deepseek",
      presetId: "deepseek-official",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
    });
    const untouched = applyReasoningPolicy(deepseek, request("分析"), { task: "group_chat", mode: "deep" });
    assert.equal(Object.prototype.hasOwnProperty.call(untouched.request, "thinking"), false);
    assert.equal(untouched.meta.applied, false);
    assert.equal(getProviderReasoningControl(deepseek).configurable, false);

    const genericChat = applyReasoningPolicy(provider(), request("分析"), {
      task: "group_chat",
      mode: "deep",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(genericChat.request, "thinking"), false);
  });
});

function request(text) {
  return { messages: [{ role: "user", content: text }], maxTokens: 64 };
}

function mimoProvider() {
  return provider({
    id: "mimo",
    presetId: "mimo-official",
    endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.5",
  });
}

function provider(overrides = {}) {
  return {
    id: "test",
    presetId: "custom-openai-chat",
    protocol: "openai-chat",
    endpoint: "https://example.com/v1/chat/completions",
    model: "test-model",
    capabilities: ["text", "reasoning"],
    ...overrides,
  };
}
