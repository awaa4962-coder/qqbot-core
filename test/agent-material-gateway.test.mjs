import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-material-gateway-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
after(() => fs.rmSync(root, { recursive: true, force: true }));
Object.assign(CFG, { groupWhitelist: [50160], friendWhitelist: [60160], botBlacklist: [], agentGroupWhitelist: [50160],
  agentMaterialGroupWhitelist: [50160], agentDraftGroupWhitelist: [50160], summaryGroupWhitelist: [50160], conversationSummaryGroupWhitelist: [50160] });
const request = options => ({ userMsg: "读取附件第一行，先生成总结草稿", userName: "合成用户", history: [], groupId: 50160, isAtMe: true,
  options: { currentUserId: "60160", currentMessageId: "80160", attachments: [{ name: "notes.txt", url: "https://synthetic.invalid/notes.txt", size: 50 }],
    mentionTargets: [{ qq: "60161", isBot: false, isAll: false }], ...options } });

test("formal group gateway forwards the current message and attachments into the single tool session", async () => {
  let executed = false;
  const result = await withChatRun({ surface: "group", groupId: 50160, userId: 60160, messageId: 80160 }, () => executeChatTask(request(), {
    primaryChat: async prepared => {
      executed = true;
      const session = prepared.options.toolSession;
      const names = session.definitions().map(tool => tool.function.name);
      for (const name of ["read_current_attachment", "draft_chat_summary", "read_draft_task"]) assert.ok(names.includes(name));
      const frame = session.sourceContext().find(row => row.content.includes("附件引用"));
      assert.ok(frame); assert.doesNotMatch(frame.content, /https:|50160|60160|80160/);
      const value = JSON.parse(frame.content.split("\n")[1]);
      assert.equal(value.attachments[0].name, "notes.txt"); assert.equal(value.attachments[0].status, "not_read");
      return { kind: "reply", text: "这是合成最终回复。" };
    },
  }));
  assert.equal(executed, true); assert.equal(result.kind, "reply");
});

test("formal private and passive gateways still do not enable material or draft tools", async () => {
  const closed = prepared => {
    const names = prepared.options.toolSession.definitions().map(tool => tool.function.name);
    for (const name of ["read_current_attachment", "draft_chat_summary", "read_draft_task"]) assert.equal(names.includes(name), false);
    assert.equal(prepared.options.toolSession.sourceContext().some(row => row.content.includes("附件引用")), false);
    return { kind: "reply", text: "仅普通聊天。" };
  };
  assert.equal((await executePrivateChatTask({ ...request(), groupId: null }, { callSlot: closed })).kind, "reply");
  assert.equal((await executeChatTask({ ...request({ replyMode: "interjection" }), isAtMe: false }, { primaryChat: closed })).kind, "reply");
});

test("real provider serialization includes scoped declarations and metadata without eagerly downloading the attachment", async t => {
  saveApiProvider({ id: "material-wire", model: "synthetic-wire-model", presetId: "custom-openai-chat", auth: "none",
    endpoint: "https://example.com/material-wire", capabilities: ["text", "tools"], enabled: true }, { root });
  saveApiRoutes({ group_chat: { primary: "material-wire", fallback: "deepseek" } }, { root });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(String(url).startsWith("https://example.com/material-wire"), "the attachment must not be eagerly fetched");
    const body = JSON.parse(init.body); bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "仅收到附件引用，尚未读取正文。" } }] }) };
  });
  let executed = false;
  const result = await withChatRun({ surface: "group", groupId: 50160, userId: 60160, messageId: 80161 }, async () => {
    executed = true;
    return await executeChatTask(request({ currentMessageId: "80161" }));
  });
  assert.equal(executed, true); assert.equal(result.kind, "reply"); assert.equal(bodies.length, 1);
  const names = bodies[0].tools.map(tool => tool.function.name);
  for (const name of ["read_current_attachment", "draft_chat_summary", "read_draft_task"]) assert.ok(names.includes(name));
  const frame = bodies[0].messages.find(row => typeof row.content === "string" && row.content.includes("后端绑定的本轮附件引用"));
  assert.ok(frame); assert.match(frame.content, /"status":"not_read"/);
  assert.doesNotMatch(frame.content, /https:|50160|60160|80161/);
});
