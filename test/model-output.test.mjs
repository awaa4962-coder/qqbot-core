import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryMiMo } from "../bridge/model-mimo.mjs";
import { tryDeepSeek } from "../bridge/model-ds.mjs";
import { LONG_GROUPS } from "../bridge/config.mjs";

const LONG_GROUP_ID = Number(LONG_GROUPS[0] || 2000000005);
const NORMAL_GROUP_ID = 909090909;

async function captureMiMoBody(fn) {
  const oldFetch = globalThis.fetch;
  let body = null;
  let fetchCount = 0;
  globalThis.fetch = async function(_url, options) {
    fetchCount++;
    body = JSON.parse(options.body);
    return { json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }) };
  };
  try {
    const result = await fn();
    return { body, result, fetchCount };
  } finally {
    globalThis.fetch = oldFetch;
  }
}

describe("MiMo output sizing", () => {
  it("keeps random interjection bounded and disables thinking", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], 123, false, "", { replyMode: "interjection" })
    );
    assert.equal(body.model, "mimo-v2.5");
    assert.equal(body.max_completion_tokens, 192);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "tools"), false);
    assert.match(body.messages[0].content, /明确回应点/);
    assert.match(body.messages.at(-1).content, /插话判断/);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "max_tokens"), false);
  });

  it("uses 1024 max tokens for long group mentions", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], LONG_GROUP_ID, true, "")
    );
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "thinking"), false);
  });

  it("uses 1536 max tokens for normal group mentions", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], NORMAL_GROUP_ID, true, "")
    );
    assert.equal(body.max_completion_tokens, 1536);
  });

  it("passes a selected hiss cue into the MiMo system prompt", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("你这只笨猫", "user", [], [], NORMAL_GROUP_ID, true, "", {
        personaCue: "hiss",
      })
    );
    assert.match(body.messages[0].content, /哈气一次/);
    assert.match(body.messages[0].content, /回应具体内容/);
  });

  it("reuses prepared vision context in chat instead of downloading the image again", async () => {
    const { body, fetchCount } = await captureMiMoBody(() =>
      tryMiMo("[图片]", "user", [], ["https://example.com/cat.jpg"], 123, false, "", {
        replyMode: "interjection",
        currentUserId: "42",
        visionContext: "主体是猫；表情严肃；可见文字是哈基米。",
      })
    );
    assert.equal(fetchCount, 1);
    const joined = body.messages.map(item => typeof item.content === "string" ? item.content : "").join("\n");
    assert.match(joined, /当前图片客观描述/);
    assert.match(joined, /表情严肃/);
    assert.match(joined, /vision_available=true/);
  });
});

async function captureDeepSeekBody(fn) {
  const oldFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async function(_url, options) {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    };
  };
  try {
    const result = await fn();
    return { body, result };
  } finally {
    globalThis.fetch = oldFetch;
  }
}

describe("DeepSeek output sizing", () => {
  it("keeps passive replies small", async () => {
    const { body } = await captureDeepSeekBody(() =>
      tryDeepSeek("hello", "user", [], 123, false, "")
    );
    assert.equal(body.max_tokens, 150);
  });

  it("uses 1024 max tokens for long group mentions", async () => {
    const { body } = await captureDeepSeekBody(() =>
      tryDeepSeek("hello", "user", [], LONG_GROUP_ID, true, "")
    );
    assert.equal(body.max_tokens, 1024);
  });

  it("uses 1536 max tokens for normal group mentions", async () => {
    const { body } = await captureDeepSeekBody(() =>
      tryDeepSeek("hello", "user", [], NORMAL_GROUP_ID, true, "")
    );
    assert.equal(body.max_tokens, 1536);
  });

  it("passes a selected hiss cue into the DeepSeek fallback prompt", async () => {
    const { body } = await captureDeepSeekBody(() =>
      tryDeepSeek("你这只笨猫", "user", [], NORMAL_GROUP_ID, true, "", {
        personaCue: "hiss",
      })
    );
    assert.match(body.messages[0].content, /哈气一次/);
    assert.match(body.messages[0].content, /不要连续哈气/);
  });
});
