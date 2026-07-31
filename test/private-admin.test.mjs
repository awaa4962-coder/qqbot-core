import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CFG } from "../bridge/config.mjs";
import { processEvent } from "../bridge/reply.mjs";
import { users } from "../bridge/storage.mjs";

describe("private admin command whitelist bypass", () => {
  it("lets admins run private runtime without friend whitelist", async () => {
    const oldAdmins = CFG.adminUins.slice();
    const oldFriends = CFG.friendWhitelist.slice();
    const oldFetch = globalThis.fetch;
    const calls = [];

    CFG.adminUins.splice(0, CFG.adminUins.length, "12345");
    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length);
    globalThis.fetch = async function(url, options) {
      calls.push({ url, options });
      return { json: async function() { return { status: "ok" }; } };
    };

    try {
      await processEvent({
        post_type: "message",
        message_type: "private",
        user_id: 12345,
        message_id: 1,
        raw_message: "runtime",
        message: [{ type: "text", data: { text: "runtime" } }],
        sender: { nickname: "admin" },
      });
    } finally {
      CFG.adminUins.splice(0, CFG.adminUins.length, ...oldAdmins);
      CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, ...oldFriends);
      globalThis.fetch = oldFetch;
    }

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /send_private_msg/);
    assert.match(String(calls[0].options?.body || ""), /状态：正常/);
  });

  it("passes user preferences into normal private AI replies", async () => {
    const oldFriends = CFG.friendWhitelist.slice();
    const oldDsKey = CFG.dsKey;
    const oldFetch = globalThis.fetch;
    const oldUser = users["12345"];
    const calls = [];
    let deepseekBody = null;

    CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, 12345);
    CFG.dsKey = "test-ds-key";
    users["12345"] = {
      uid: "12345",
      nicknames: ["原昵称"],
      chats: [],
      preferences: {
        displayName: "阿明",
        style: { length: "short", tone: "technical", humor: "light", updatedAt: 1 },
      },
    };
    globalThis.fetch = async function(url, options) {
      calls.push({ url, options });
      if (String(url).includes("deepseek.com")) {
        deepseekBody = JSON.parse(String(options?.body || "{}"));
        return {
          ok: true,
          json: async function() {
            return { choices: [{ message: { content: "收到" }, finish_reason: "stop" }] };
          },
        };
      }
      return { ok: true, json: async function() { return { status: "ok" }; } };
    };

    try {
      await processEvent({
        post_type: "message",
        message_type: "private",
        user_id: 12345,
        message_id: 2,
        raw_message: "普通聊天",
        message: [{ type: "text", data: { text: "普通聊天" } }],
        sender: { nickname: "原昵称" },
      });
    } finally {
      CFG.friendWhitelist.splice(0, CFG.friendWhitelist.length, ...oldFriends);
      CFG.dsKey = oldDsKey;
      globalThis.fetch = oldFetch;
      if (oldUser === undefined) delete users["12345"];
      else users["12345"] = oldUser;
    }

    const joined = deepseekBody.messages.map(item => item.content).join("\n");
    assert.ok(calls.some(call => String(call.url).includes("send_private_msg")));
    assert.match(joined, /用户主动设置/);
    assert.match(joined, /阿明/);
    assert.match(joined, /简短/);
    assert.match(joined, /speaker=阿明/);
  });
});
