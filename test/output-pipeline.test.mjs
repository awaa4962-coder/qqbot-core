import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOutputPacket,
  detectOutputRisk,
  extractAssistantContent,
  normalizeFinalReply,
  sanitizeAssistantReply,
} from "../bridge/output-pipeline.mjs";

describe("output pipeline", () => {
  it("uses content and ignores reasoning_content", () => {
    const raw = {
      choices: [{
        finish_reason: "stop",
        message: { content: "喵～这是正文", reasoning_content: "不能外发" },
      }],
    };
    const packet = buildOutputPacket(raw, { provider: "mimo" });
    assert.equal(packet.ok, true);
    assert.equal(packet.text, "喵～这是正文");
    assert.equal(packet.provider, "mimo");
  });

  it("rejects reasoning_content-only responses", () => {
    const raw = { choices: [{ message: { reasoning_content: "喵～不能从这里取" } }] };
    const packet = buildOutputPacket(raw, { provider: "mimo" });
    assert.equal(packet.ok, false);
    assert.equal(packet.text, null);
    assert.equal(packet.reason, "empty_content_with_reasoning");
  });

  it("ignores alternate private reasoning fields and sends only content", () => {
    const packet = buildOutputPacket({
      choices: [{ message: { content: "最终答案", analysis: "内部分析", thinking: { text: "内部思考" } } }],
    });
    assert.equal(packet.ok, true);
    assert.equal(packet.text, "最终答案");
    assert.equal(packet.text.includes("内部"), false);
  });

  it("rejects analysis-only responses instead of exposing them", () => {
    const packet = buildOutputPacket({ choices: [{ message: { analysis: "内部分析不能外发" } }] });
    assert.equal(packet.ok, false);
    assert.equal(packet.text, null);
    assert.equal(packet.reason, "empty_content_with_reasoning");
  });

  it("rejects content that still looks like reasoning", () => {
    const raw = {
      choices: [{
        message: {
          content: "用户问了天气怎么样。看起来用户在关心出行。我应该用可爱的语气回复。首先确认用户所在城市。",
          reasoning_content: "不能外发",
        },
      }],
    };
    const packet = buildOutputPacket(raw);
    assert.equal(packet.ok, false);
    assert.equal(packet.text, null);
    assert.ok(packet.risks.includes("reasoning_leak"));
  });

  it("cleans think tags", () => {
    assert.equal(sanitizeAssistantReply("<think>分析</think>这是回复"), "这是回复");
  });

  it("rejects every unclosed or mismatched reasoning block without rescuing a paragraph", () => {
    const samples = [
      "<think>private first paragraph\n\nCandidate B is preferable.",
      "visible prefix<thinking>private tail",
      "<reasoning mode='deep'>private\n\ncontinued private text",
      "<thought>private</think>not a confirmed final answer",
      "<think>outer<thought>inner</thought>still private",
      "<think>private</think>visible<thinking",
    ];
    for (const content of samples) {
      assert.equal(sanitizeAssistantReply(content), null, content);
      assert.equal(buildOutputPacket({ choices: [{ message: { content } }] }).ok, false, content);
    }
  });

  it("removes nested balanced reasoning blocks and preserves only outside text", () => {
    assert.equal(sanitizeAssistantReply("<think>outer<thought>inner</thought></think>final"), "final");
    assert.equal(sanitizeAssistantReply("<reasoning mode='deep'>private</reasoning>final"), "final");
  });

  it("keeps normal technical steps", () => {
    const text = "步骤一：检查 npm run lint\n步骤二：运行 npm test\n步骤三：查看日志";
    assert.equal(sanitizeAssistantReply(text), text);
  });

  it("allows ordinary clarification about context without confusing it with private planning", () => {
    for (const text of [
      "这个梗我没有可靠出处，能贴一下上下文吗？有原话才好判断。",
      "我不确定，能给一点上下文帮助我理解吗？",
      "没有原文我不好理解它的上下文，你可以发一下截图吗？",
      "单看这句话不能判断是在开玩笑还是引用，需要结合上下文。",
    ]) assert.equal(sanitizeAssistantReply(text), text);
  });

  it("still rejects context analysis that plans how the assistant should respond", () => {
    for (const text of [
      "根据上下文我需要理解用户到底在说什么，之后再回复。",
      "上下文里用户在抱怨，我应该分析语气并组织回复。",
      "分析上下文之后，接下来需要判断用户意图再组织答案。",
      "我先理解这个对话上下文，然后应该注意措辞。",
    ]) assert.equal(sanitizeAssistantReply(text), null);
  });

  it("adds continuation hint when model finish_reason is length", () => {
    const text = normalizeFinalReply("这是一段回复", { finishReason: "length" });
    assert.ok(text.includes("发“继续”"));
  });

  it("detects obvious outbound secret leaks", () => {
    assert.ok(detectOutputRisk("Authorization: Bearer sk-realrealrealrealrealreal").includes("secret_leak"));
    assert.ok(detectOutputRisk("api_key=abcdefghijklmnop").includes("secret_leak"));
  });

  it("does not block ordinary token or secret terminology", () => {
    assert.equal(detectOutputRisk("Token pricing is based on input and output.").includes("secret_leak"), false);
    assert.equal(detectOutputRisk("What does the word secret mean?").includes("secret_leak"), false);
    assert.equal(detectOutputRisk("API key 是什么？").includes("secret_leak"), false);
  });

  it("extractAssistantContent reports finish reason and lengths", () => {
    const info = extractAssistantContent({
      choices: [{ finish_reason: "length", message: { content: "abc" } }],
      usage: { total_tokens: 3 },
    }, { provider: "mimo" });
    assert.equal(info.finishReason, "length");
    assert.equal(info.rawLength, 3);
    assert.equal(info.usage.total_tokens, 3);
  });
});
