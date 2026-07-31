import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enforceContextBudget } from "../bridge/context/budget.mjs";

describe("context hard budget", () => {
  it("keeps high-priority layers and strips internal metadata", () => {
    const result = enforceContextBudget([
      { role: "user", content: "low-" + "x".repeat(180), contextPriority: 10 },
      { role: "user", content: "quoted-important", contextPriority: 100 },
      { role: "user", content: "thread-important", contextPriority: 90 },
    ], "current-input", {
      mode: "group-at",
      maxChars: 100,
      maxMessages: 2,
      maxMessageChars: 80,
    });

    const joined = result.messages.map(item => item.content).join("\n");
    assert.match(joined, /quoted-important/);
    assert.match(joined, /thread-important/);
    assert.doesNotMatch(joined, /low-/);
    assert.equal(Object.prototype.hasOwnProperty.call(result.messages[0], "contextPriority"), false);
    assert.ok(result.budget.chars <= result.budget.maxChars);
    assert.equal(result.budget.prunedMessageCount, 1);
  });

  it("truncates oversized context without exceeding the configured budget", () => {
    const result = enforceContextBudget([
      { role: "user", content: "[群聊背景]\n" + "很长的群聊内容".repeat(200), contextPriority: 40 },
    ], "当前输入", {
      mode: "group-at",
      maxChars: 240,
      maxMessageChars: 220,
    });

    assert.ok(result.budget.chars <= 240);
    assert.equal(result.budget.truncatedMessageCount, 1);
    assert.match(result.messages[0].content, /^\[群聊背景\]/);
  });
});
