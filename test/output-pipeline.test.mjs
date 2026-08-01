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

  it("keeps normal technical steps", () => {
    const text = "步骤一：检查 npm run lint\n步骤二：运行 npm test\n步骤三：查看日志";
    assert.equal(sanitizeAssistantReply(text), text);
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
