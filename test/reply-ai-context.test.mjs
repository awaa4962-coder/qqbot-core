import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildModelFallbackHistory } from "../bridge/reply-ai.mjs";

describe("reply AI image fallback context", () => {
  it("passes an objective image description to the text fallback model", () => {
    const history = [{ role: "user", content: "[最近对话]\nA：刚才还在说哈基米" }];
    const result = buildModelFallbackHistory(
      history,
      ["https://example.com/meme.jpg"],
      "主体是猫；表情严肃；可见文字为哈基米。"
    );
    assert.equal(result.length, 2);
    assert.match(result[1].content, /当前图片客观描述/);
    assert.match(result[1].content, /表情严肃/);
  });

  it("marks missing vision so DeepSeek cannot invent image details", () => {
    const result = buildModelFallbackHistory(
      [],
      ["https://example.com/meme.jpg"],
      null
    );
    assert.equal(result.length, 1);
    assert.match(result[0].content, /视觉识别失败/);
    assert.match(result[0].content, /不能声称看到了/);
  });
});
