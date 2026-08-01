import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MODEL_PROVIDERS,
  MODEL_TASKS,
  callRawModelProvider,
  executeChatTask,
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

  it("runs primary and fallback chat through one orchestration path", async () => {
    let fallbackRequest = null;
    const result = await executeChatTask({
      userMsg: "这张图是什么",
      userName: "测试用户",
      history: [{ role: "user", content: "前文" }],
      imageUrls: ["https://example.com/image.jpg"],
      groupId: 1,
      isAtMe: true,
      options: {
        currentUserId: "42",
        personaCue: "soft",
        visionContext: "一只猫",
      },
    }, {
      primaryChat: async () => null,
      fallbackChat: async request => {
        fallbackRequest = request;
        return "fallback reply";
      },
    });

    assert.deepEqual(result, { text: "fallback reply", position: "fallback" });
    assert.match(fallbackRequest.history.at(-1).content, /一只猫/);
    assert.equal(fallbackRequest.options.currentUserId, "42");
  });

  it("keeps passive interjection fallback local", async () => {
    let fallbackCalled = false;
    const result = await executeChatTask({
      options: { replyMode: "interjection" },
    }, {
      primaryChat: async () => null,
      fallbackChat: async () => {
        fallbackCalled = true;
        return "unexpected";
      },
    });
    assert.deepEqual(result, { text: null, position: "local" });
    assert.equal(fallbackCalled, false);
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
