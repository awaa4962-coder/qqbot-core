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
  executePrivateChatTask,
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

  it("uses the configured interjection fallback before staying silent", async () => {
    let fallbackCalled = false;
    const result = await executeChatTask({
      options: { replyMode: "interjection" },
    }, {
      primaryChat: async () => null,
      fallbackChat: async () => {
        fallbackCalled = true;
        return "fallback reply";
      },
    });
    assert.deepEqual(result, { text: "fallback reply", position: "fallback" });
    assert.equal(fallbackCalled, true);
  });

  it("keeps passive interjection local when both model slots are unavailable", async () => {
    const result = await executeChatTask({
      options: { replyMode: "interjection" },
    }, {
      primaryChat: async () => null,
      interjectionFallback: async () => null,
    });
    assert.deepEqual(result, { text: null, position: "local" });
  });

  it("rejects unknown raw providers before touching model implementations", async () => {
    await assert.rejects(
      () => callRawModelProvider("unknown", {}),
      /unknown model provider/
    );
  });

  it("shares one private vision result across the configured primary and fallback", async () => {
    const calls = [];
    let visionCalls = 0;
    const result = await executePrivateChatTask({
      userMsg: "describe image", imageUrls: ["https://example.com/synthetic.png"],
      history: [{ role: "user", content: "earlier" }], options: { currentUserId: "42" },
    }, {
      resolveVision: async () => { visionCalls++; return "synthetic image description"; },
      callSlot: async request => { calls.push(request); return request.position === "fallback" ? "answer" : null; },
    });
    assert.equal(visionCalls, 1);
    assert.deepEqual(calls.map(item => [item.task, item.position]), [["private_chat", "primary"], ["private_chat", "fallback"]]);
    assert.match(calls[0].history.at(-1).content, /synthetic image description/);
    assert.deepEqual(calls[0].history, calls[1].history);
    assert.deepEqual(result, { text: "answer", position: "fallback" });
  });

  it("keeps file_chat distinct and stops after a successful private primary", async () => {
    const calls = [];
    const result = await executePrivateChatTask({ task: MODEL_TASKS.FILE_CHAT }, {
      callSlot: async request => { calls.push(request); return "file answer"; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, "file_chat");
    assert.deepEqual(result, { text: "file answer", position: "primary" });
  });

  it("keeps private replies absent when both slots fail and preserves failed vision", async () => {
    const result = await executePrivateChatTask({ imageUrls: ["synthetic"], options: { visionContext: null } }, {
      resolveVision: async () => assert.fail("must reuse explicit failed vision"),
      callSlot: async request => {
        assert.match(request.history.at(-1).content, /视觉识别失败/);
        return null;
      },
    });
    assert.deepEqual(result, { text: null, position: "unavailable" });
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
