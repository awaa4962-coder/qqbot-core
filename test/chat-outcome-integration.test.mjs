import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-outcomes-"));
process.env.QQBOT_CONFIG_ROOT = root;
process.env.QQBOT_DATA_DIR = path.join(root, "data");
process.env.QQBOT_LOG_DIR = path.join(root, "logs");
const { CFG } = await import("../bridge/config.mjs");
const { aiReply } = await import("../bridge/reply-ai.mjs");
const { privateReply } = await import("../bridge/reply-private.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { groupChats } = await import("../bridge/storage.mjs");
const { getConversationThread, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");
const { MODEL_FAILURE_NOTICE } = await import("../bridge/chat-outcome.mjs");
const { forgetUserData, setUserDisplayName, setUserStylePreference, resetUserStylePreference } = await import("../bridge/user-preferences.mjs");
const { clearGroupMemoryProfile } = await import("../bridge/memory-profile.mjs");
const { getUserCacheUsage } = await import("../bridge/api-providers/usage-metrics.mjs");
const { createTraceRecorder, traceStage, withMessageTrace } = await import("../bridge/diagnostics/message-trace.mjs");
const originalFetch = globalThis.fetch;
CFG.groupWhitelist = [88001];
CFG.friendWhitelist = [88002];
CFG.legacyProfileRefreshEnabled = true;
CFG.stickerEnabled = true;
for (const id of ["outcome-primary", "outcome-backup", "deepseek"]) {
  saveApiProvider({ id, presetId: "custom-openai-chat", model: id, auth: "none", endpoint: "https://example.com/" + id,
    capabilities: ["text"], enabled: true }, { root });
}
saveApiRoutes(Object.fromEntries(["group_chat", "interjection", "private_chat"].map(task => [task,
  { primary: "outcome-primary", fallback: task === "group_chat" ? "deepseek" : "outcome-backup" }])), { root });
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCognitionForTest();
  CFG.groupWhitelist = [88001];
  CFG.friendWhitelist = [88002];
  CFG.botBlacklist = [];
});
const response = message => ({ ok: true, status: 200, text: async () => JSON.stringify(message), json: async () => message });
const apiReply = content => response({ choices: [{ message: content }] });
let nextMessageId = 88003;

async function groupReply(passive) {
  const messageId = nextMessageId++;
  const trace = createTraceRecorder();
  const before = JSON.stringify(groupChats[88001] || []);
  await withMessageTrace({ message_type: "group", group_id: 88001, user_id: 88002, message_id: messageId }, async () => {
    traceStage("route", { route: passive ? "interjection" : "group_at", status: "ok" });
    await aiReply(88001, 88002, "synthetic greeting", "synthetic user", [], messageId, "", !passive, [], { messageId });
  }, trace);
  assert.equal(JSON.stringify(groupChats[88001] || []), before);
  assert.equal(getConversationThread(88002, 88001), null);
  return trace.list().items[0];
}

test("actual passive entrypoint stops after primary silence without send, sticker or memory", async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    const facts = JSON.parse(body.messages.find(item => item.content?.startsWith("[本轮机器人运行事实]")).content.split("\n").at(-1));
    assert.deepEqual(facts.callableTools, []);
    return apiReply({ content: '{"reply":""}', reasoning_content: "hidden synthetic reasoning" });
  };
  const trace = await groupReply(true);
  assert.equal(calls, 1);
  assert.equal(trace.status, "silent");
  assert.equal(trace.sends, 0);
  assert.doesNotMatch(JSON.stringify(trace), /hidden synthetic/);
});

test("passive failures use both slots but never add a random local reply", async () => {
  const models = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith("https://example.com/"), "no external send or sticker/profile side effect");
    models.push(JSON.parse(options.body).model);
    return apiReply({ reasoning_content: "hidden synthetic reasoning" });
  };
  const trace = await groupReply(true);
  assert.deepEqual(models, ["outcome-primary", "outcome-backup"]);
  assert.equal(trace.status, "failed");
  assert.equal(trace.sends, 0);
});

test("direct group failures send exactly one static notice without creating completed turns", async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://example.com/")) return apiReply({ reasoning_content: "hidden synthetic reasoning" });
    assert.ok(String(url).endsWith("/send_group_msg"));
    sent.push(JSON.parse(options.body));
    return response({ status: "ok", retcode: 0, data: { message_id: 88004 } });
  };
  const trace = await groupReply(false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].group_id, 88001);
  assert.equal(sent[0].message.filter(item => item.type === "text").map(item => item.data.text).join(""), MODEL_FAILURE_NOTICE);
  assert.equal(trace.status, "failed");
});

test("private failure notices do not become remembered assistant turns", async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://example.com/")) return apiReply({ reasoning_content: "hidden synthetic reasoning" });
    assert.ok(String(url).endsWith("/send_private_msg"));
    sent.push(JSON.parse(options.body));
    return response({ status: "ok", retcode: 0, data: { message_id: 88005 } });
  };
  await privateReply(88002, "synthetic greeting");
  assert.equal(sent.length, 1);
  assert.ok(JSON.stringify(sent[0].message).includes(MODEL_FAILURE_NOTICE));
  assert.equal(getConversationThread(88002, "private"), null);
  assert.doesNotMatch(JSON.stringify(sent), /hidden synthetic/);
});

for (const [name, change, reason] of [
  ["owner forget", () => forgetUserData(88002, { skipSave: true }), "privacy_changed"],
  ["other participant forget", () => forgetUserData(88009, { skipSave: true }), "privacy_changed"],
  ["group memory clear", () => clearGroupMemoryProfile(88001), "privacy_changed"],
  ["group access revoked", () => { CFG.groupWhitelist = []; }, "permission_changed"],
  ["blacklist updated", () => { CFG.botBlacklist = [88002]; }, "permission_changed"],
  ["preferred name updated", () => setUserDisplayName(88002, "new-name", { skipSave: true }), "preferences_changed"],
  ["preferred style updated", () => setUserStylePreference(88002, "简短", { skipSave: true }), "preferences_changed"],
  ["preferred style reset", () => resetUserStylePreference(88002, { skipSave: true }), "preferences_changed"],
]) {
  test(name + " during primary output prevents fallback, send and remembered turn", async () => {
    let calls = 0;
    globalThis.fetch = async url => {
      assert.equal(String(url), "https://example.com/outcome-primary");
      calls++;
      change();
      return apiReply({ content: "stale answer", reasoning_content: "hidden" });
    };
    const trace = await groupReply(false);
    assert.equal(calls, 1);
    assert.equal(trace.status, "cancelled");
    assert.equal(trace.reason, reason);
  });
}

test("private whitelist revocation after model generation prevents even the failure notice", async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    calls++;
    CFG.friendWhitelist = [];
    return apiReply({ reasoning_content: "hidden" });
  };
  const result = await privateReply(88002, "synthetic greeting");
  assert.equal(calls, 1);
  assert.equal(result.kind, "cancelled");
  assert.equal(getConversationThread(88002, "private"), null);
});

test("provider retries stop after a privacy clear without trying fallback", async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    calls++;
    forgetUserData(88009, { skipSave: true });
    return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: "synthetic unavailable" } }) };
  };
  const trace = await groupReply(false);
  assert.equal(calls, 1);
  assert.equal(trace.status, "cancelled");
});

test("long group replies stop after the acknowledged first chunk when privacy changes", async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://example.com/")) return apiReply({ content: "这是一段合成测试内容。".repeat(120) });
    assert.ok(String(url).endsWith("/send_group_msg"));
    sent.push(JSON.parse(options.body));
    forgetUserData(88009, { skipSave: true });
    return response({ status: "ok", retcode: 0, data: { message_id: 99001 } });
  };
  const trace = await groupReply(false);
  assert.equal(sent.length, 1);
  assert.equal(trace.status, "partial");
  assert.equal(trace.reason, "privacy_changed");
});

test("long private replies cannot continue or remember a full answer after revocation", async () => {
  let sends = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith("https://example.com/")) return apiReply({ content: "这是一段合成测试内容。".repeat(120) });
    assert.ok(String(url).endsWith("/send_private_msg"));
    sends++;
    CFG.friendWhitelist = [];
    return response({ status: "ok", retcode: 0, data: { message_id: 99002 } });
  };
  const result = await privateReply(88002, "synthetic greeting");
  assert.equal(result.kind, "cancelled");
  assert.equal(sends, 1);
  assert.equal(getConversationThread(88002, "private"), null);
});

test("late model usage stays anonymous instead of repopulating forgotten user statistics", async () => {
  const before = getUserCacheUsage(88002).calls;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    forgetUserData(88002, { skipSave: true });
    return response({ choices: [{ message: { content: "stale answer" } }], usage: { prompt_tokens: 15, completion_tokens: 5 } });
  };
  await groupReply(false);
  assert.equal(getUserCacheUsage(88002).calls, before);
});

test("a stale tool request cannot launch search or a second model round", async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    calls++;
    forgetUserData(88009, { skipSave: true });
    return apiReply({ content: null, tool_calls: [{ id: "synthetic-tool", type: "function",
      function: { name: "web_search", arguments: JSON.stringify({ query: "synthetic topic" }) } }] });
  };
  const trace = await groupReply(false);
  assert.equal(calls, 1);
  assert.equal(trace.status, "cancelled");
});

test("a send with an unknown receipt is never retried when a chat is invalidated", async () => {
  let sends = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith("https://example.com/")) return apiReply({ content: "synthetic answer" });
    assert.ok(String(url).endsWith("/send_group_msg"));
    sends++;
    forgetUserData(88009, { skipSave: true });
    throw new Error("synthetic delivery timeout");
  };
  const trace = await groupReply(false);
  assert.equal(sends, 1);
  assert.equal(trace.sendFailures, 1);
  assert.equal(trace.status, "unknown");
  assert.equal(trace.unknownSends, 1);
  assert.equal(trace.reason, "privacy_changed");
});

test("a new concurrent entrypoint aborts the old model wait without retry or send", async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://example.com/outcome-primary");
    calls++;
    if (calls === 1) {
      started();
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted synthetic wait")), { once: true });
      });
    }
    return apiReply({ content: '{"reply":""}' });
  };
  const old = groupReply(true);
  await pending;
  const latest = await groupReply(true);
  const previous = await old;
  assert.equal(calls, 2);
  assert.equal(latest.status, "silent");
  assert.equal(previous.status, "cancelled");
  assert.equal(previous.reason, "reply_superseded");
});
