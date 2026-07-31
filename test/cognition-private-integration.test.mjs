import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CFG } from "../bridge/config.mjs";
import { getConversationThread, resetCognitionForTest } from "../bridge/cognition/index.mjs";
import { processEvent } from "../bridge/reply.mjs";
import { users } from "../bridge/storage.mjs";

describe("private cognition integration", () => {
  afterEach(() => resetCognitionForTest());

  it("feeds the previous completed private turn into a continuation reply", async () => {
    const userId = 1234509876;
    const oldFriends = CFG.friendWhitelist.slice();
    const oldFetch = globalThis.fetch;
    const oldUser = users[String(userId)];
    const deepseekBodies = [];
    let modelCall = 0;

    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, userId);
    globalThis.fetch = async function(url, options) {
      if (String(url).includes("deepseek.com")) {
        deepseekBodies.push(JSON.parse(String(options?.body || "{}")));
        modelCall++;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: modelCall === 1 ? "先检查依赖。" : "继续检查运行时。" }, finish_reason: "stop" }],
          }),
        };
      }
      return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
    };

    try {
      await processEvent(privateEvent(userId, 1, "JM 下载失败了"));
      await processEvent(privateEvent(userId, 2, "还是不行"));
    } finally {
      CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, ...oldFriends);
      globalThis.fetch = oldFetch;
      if (oldUser === undefined) delete users[String(userId)];
      else users[String(userId)] = oldUser;
    }

    const secondPrompt = deepseekBodies[1].messages.map(item => item.content).join("\n");
    assert.equal(deepseekBodies.length, 2);
    assert.match(secondPrompt, /短期会话线程/);
    assert.match(secondPrompt, /JM 下载失败了/);
    assert.match(secondPrompt, /先检查依赖/);
    const thread = getConversationThread(userId, "private");
    assert.equal(thread.turnCount, 2);
    assert.equal(users[String(userId)]?.cognition, undefined);
  });
});

function privateEvent(userId, messageId, text) {
  return {
    post_type: "message",
    message_type: "private",
    user_id: userId,
    message_id: messageId,
    raw_message: text,
    message: [{ type: "text", data: { text } }],
    sender: { nickname: "测试用户" },
  };
}
