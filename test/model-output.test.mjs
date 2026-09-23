import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryMiMo } from "../bridge/model-mimo.mjs";
import { tryDeepSeek } from "../bridge/model-ds.mjs";
import { CFG, LONG_GROUPS } from "../bridge/config.mjs";

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
  it("keeps one dynamic layer and the same fixed prefix across search tool rounds", async () => {
    const oldFetch = globalThis.fetch;
    const oldSearchKey = CFG.tavilyKey;
    const bodies = [];
    CFG.tavilyKey = "";
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://cn.bing.com/search")) {
        return { ok: true, text: async () => '<li class="b_algo"><h2><a href="https://example.com">synthetic source</a></h2><p>synthetic evidence</p></li>' };
      }
      bodies.push(JSON.parse(options.body));
      const message = bodies.length === 1 ? { content: null, reasoning_content: "synthetic internal tool protocol",
        tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "web_search", arguments: '{"query":"synthetic subject"}' } }] }
        : { content: "synthetic final answer" };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
    };
    try {
      const result = await tryMiMo("synthetic question", "user", [], [], NORMAL_GROUP_ID, true, "正常", { currentUserId: "42", personaCue: "hiss" });
      assert.equal(result, "synthetic final answer");
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
      for (const body of bodies) {
        assert.equal(body.messages.filter(item => item.content?.startsWith("[本轮表达设置]")).length, 1);
        assert.equal(body.messages.filter(item => item.content?.startsWith("[本轮机器人运行事实]")).length, 1);
        assert.equal(Object.hasOwn(body, "promptMetadata"), false);
      }
      assert.equal(bodies[1].messages.find(item => item.tool_calls)?.reasoning_content, "synthetic internal tool protocol");
    } finally { globalThis.fetch = oldFetch; CFG.tavilyKey = oldSearchKey; }
  });

  it("keeps random interjection bounded and disables thinking", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], 123, false, "", { replyMode: "interjection" })
    );
    assert.equal(body.model, "mimo-v2.6-flash");
    assert.equal(body.max_completion_tokens, 192);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "tools"), false);
    assert.match(body.messages[0].content, /明确回应点/);
    assert.match(body.messages.at(-1).content, /插话判断/);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "max_tokens"), false);
  });

  it("uses 1024 max tokens and economy thinking for a short long-group mention", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], LONG_GROUP_ID, true, "")
    );
    assert.equal(body.max_completion_tokens, 1024);
    assert.deepEqual(body.thinking, { type: "disabled" });
  });

  it("uses 1536 max tokens for normal group mentions", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("hello", "user", [], [], NORMAL_GROUP_ID, true, "")
    );
    assert.equal(body.max_completion_tokens, 1536);
  });

  it("enables deep thinking for a complex group question in auto mode", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("请详细分析这个错误为什么发生，并给出完整修复方案", "user", [], [], NORMAL_GROUP_ID, true, "")
    );
    assert.deepEqual(body.thinking, { type: "enabled" });
  });

  it("passes a selected hiss cue after the stable MiMo system prefix", async () => {
    const { body } = await captureMiMoBody(() =>
      tryMiMo("你这只笨猫", "user", [], [], NORMAL_GROUP_ID, true, "", {
        personaCue: "hiss",
      })
    );
    assert.doesNotMatch(body.messages[0].content, /哈气一次/);
    const style = body.messages.find(message => message.content?.startsWith("[本轮表达设置]"));
    assert.match(style.content, /哈气一次/);
    assert.match(style.content, /回应具体内容/);
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

  it("passes a selected hiss cue after the stable DeepSeek fallback prefix", async () => {
    const { body } = await captureDeepSeekBody(() =>
      tryDeepSeek("你这只笨猫", "user", [], NORMAL_GROUP_ID, true, "", {
        personaCue: "hiss",
      })
    );
    assert.doesNotMatch(body.messages[0].content, /哈气一次/);
    const style = body.messages.find(message => message.content?.startsWith("[本轮表达设置]"));
    assert.match(style.content, /哈气一次/);
    assert.match(style.content, /不要连续哈气/);
  });
});
