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
afterEach(() => { globalThis.fetch = originalFetch; resetCognitionForTest(); });
const response = message => ({ ok: true, status: 200, text: async () => JSON.stringify(message), json: async () => message });
const apiReply = content => response({ choices: [{ message: content }] });

async function groupReply(passive) {
  const trace = createTraceRecorder();
  const before = JSON.stringify(groupChats[88001] || []);
  await withMessageTrace({ message_type: "group", group_id: 88001, user_id: 88002, message_id: 88003 }, async () => {
    traceStage("route", { route: passive ? "interjection" : "group_at", status: "ok" });
    await aiReply(88001, 88002, "synthetic greeting", "synthetic user", [], 88003, "", !passive, [], { messageId: 88003 });
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
