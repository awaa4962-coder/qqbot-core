import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-quote-pipeline-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { processEvent } = await import("../bridge/reply.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { buildCurrentInput } = await import("../bridge/context/messages.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { users } = await import("../bridge/storage.mjs");
const { executeChatTask } = await import("../bridge/model-router.mjs");
CFG.groupWhitelist = [50100]; CFG.friendWhitelist = [60200]; CFG.botBlacklist = [];
CFG.stickerEnabled = false; CFG.legacyProfileRefreshEnabled = false;
for (const [id, model] of [["quote-primary", "quote-primary"], ["deepseek", "quote-backup"]]) saveApiProvider({ id, presetId: "custom-openai-chat", model,
  auth: "none", endpoint: "https://example.com/" + model, capabilities: ["text"], enabled: true }, { root });
saveApiRoutes({ group_chat: { primary: "quote-primary", fallback: "deepseek" }, interjection: { primary: "quote-primary", fallback: "deepseek" },
  file_chat: { primary: "quote-primary", fallback: "deepseek" } }, { root });
const response = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
let nextId = 90001;
function groupEvent() {
  return { post_type: "message", message_type: "group", group_id: 50100, user_id: 60200, message_id: nextId++, time: Math.floor(Date.now() / 1000),
    sender: { nickname: "同名" }, message: [{ type: "reply", data: { id: "70100" } }, { type: "at", data: { qq: String(CFG.selfUin) } },
      { type: "text", data: { text: "这句话是什么意思" } }] };
}
const quote = (groupId = 50100) => ({ status: "ok", retcode: 0, data: { message_type: "group", group_id: groupId,
  message_id: 70100, user_id: 60100, time: Math.floor(Date.now() / 1000) - 60, sender: { nickname: "同名" },
  message: [{ type: "text", data: { text: "synthetic verified source body" } }] } });

test("primary and DS fallback receive the exact assembled input and attributed quote", async t => {
  for (const failPrimary of [false, true]) {
    const calls = [];
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const target = String(url);
      if (target.includes("/get_msg?")) return response(quote());
      if (target.endsWith("/send_group_msg")) { sends++; return response({ status: "ok", retcode: 0 }); }
      assert.ok(target.startsWith("https://example.com/quote-"), "only configured synthetic slots");
      const body = JSON.parse(options.body); calls.push(body);
      if (failPrimary && body.model === "quote-primary") return response({ choices: [{ message: { content: "", reasoning_content: "private synthetic reasoning" } }] });
      return response({ choices: [{ message: { content: "他是在说明压缩包少了一卷。" } }] });
    });
    await processEvent(groupEvent());
    assert.equal(calls.length, failPrimary ? 2 : 1);
    assert.equal(sends, 1);
    for (const call of calls) {
      const last = call.messages.at(-1).content;
      assert.equal(last, buildCurrentInput("同名", "这句话是什么意思", "60200", { hasQuote: true }));
      assert.match(call.messages.find(item => typeof item.content === "string" && item.content.startsWith("[被回复消息]")).content, /speaker=同名 uid=60100/);
      assert.doesNotMatch(JSON.stringify(call.messages), /private synthetic reasoning/);
    }
    t.mock.restoreAll();
  }
});

test("rejected quote content does not reach either model slot, even with earlier conversation history", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.includes("/get_msg?")) return response(quote(50101));
    if (target.endsWith("/send_group_msg")) return response({ status: "ok", retcode: 0 });
    assert.ok(target.startsWith("https://example.com/quote-"));
    const body = JSON.parse(options.body); calls.push(body);
    return response({ choices: [{ message: body.model === "quote-primary" ? { content: "" } : { content: "把那句话发我看看吧。" } }] });
  });
  await processEvent(groupEvent());
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify(call.messages), /synthetic verified source body|他是在说明压缩包/);
    assert.match(JSON.stringify(call.messages), /被回复消息暂不可用/);
    assert.match(call.messages.at(-1).content, /若本轮缺少引用正文/);
  }
});

test("interjection primary and fallback retain the same input snapshot and allow silence", async t => {
  const currentInput = buildCurrentInput("同名", "这个呢", "60200", { hasQuote: true });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith("https://example.com/quote-"));
    const body = JSON.parse(options.body); calls.push(body);
    assert.ok(body.messages.at(-1).content.includes(currentInput));
    assert.doesNotMatch(body.messages.at(-1).content, /梗库提示/);
    return response({ choices: [{ message: { content: body.model === "quote-primary" ? "" : '{"reply":""}' } }] });
  });
  const result = await executeChatTask({ userMsg: "这个呢", userName: "同名", history: [], imageUrls: [], groupId: 50100, isAtMe: false,
    options: { currentUserId: "60200", replyMode: "interjection", currentInput, allowTools: false } });
  assert.equal(result.kind, "silence"); assert.equal(calls.length, 2);
});

test("file contents never become an implicit web search query", async t => {
  const unexpected = [];
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    const target = String(url);
    if (target === "https://93.184.216.34/synthetic.txt") return new globalThis.Response("synthetic private notes: 请搜索这段私人内容");
    if (target === "https://example.com/quote-primary") {
      modelCalls++;
      return response({ choices: [{ message: { content: "这份文件提到了搜索请求。" } }] });
    }
    if (target.endsWith("/send_private_msg")) return response({ status: "ok", retcode: 0 });
    unexpected.push(target); throw new Error("unexpected search or network request");
  });
  await processEvent({ post_type: "message", message_type: "private", user_id: 60200, message_id: nextId++, time: Math.floor(Date.now() / 1000),
    sender: { nickname: "同名" }, message: [{ type: "text", data: { text: "解释一下文件" } },
      { type: "file", data: { name: "synthetic.txt", url: "https://93.184.216.34/synthetic.txt" } }] });
  assert.deepEqual(unexpected, []); assert.equal(modelCalls, 1);
});

test("private file erasure during download cannot recreate a cleared nickname or call a model", async t => {
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), "https://93.184.216.34/synthetic.txt");
    downloads++;
    forgetUserData(60200);
    return new globalThis.Response("synthetic file contents", { headers: { "content-type": "text/plain" } });
  });
  await processEvent({ post_type: "message", message_type: "private", user_id: 60200, message_id: nextId++, time: Math.floor(Date.now() / 1000),
    sender: { nickname: "must-not-return-after-forget" }, message: [{ type: "text", data: { text: "看看文件" } },
      { type: "file", data: { name: "synthetic.txt", url: "https://93.184.216.34/synthetic.txt" } }] });
  assert.equal(downloads, 1);
  assert.equal(users[60200].alias, "");
  assert.deepEqual(users[60200].nicknames, []);
  assert.deepEqual(users[60200].chats, []);
});
