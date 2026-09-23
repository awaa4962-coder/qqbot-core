import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tool-pipeline-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"), NODE_ENV: "test" });
const { CFG } = await import("../bridge/config.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { memoryNotesSnapshot, applyMemoryNoteAction } = await import("../bridge/memory-profile/notes.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { processEvent } = await import("../bridge/reply.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { getConversationThread } = await import("../bridge/cognition/index.mjs");
CFG.groupWhitelist = [50100]; CFG.friendWhitelist = [60100]; CFG.botBlacklist = []; CFG.stickerEnabled = false;
for (const [id, model] of [["tool-primary", "primary-model"], ["deepseek", "fallback-model"], ["tool-no-native", "plain-model"]]) {
  saveApiProvider({ id, model, presetId: "custom-openai-chat", auth: "none", endpoint: "https://example.com/" + model,
    capabilities: id === "tool-no-native" ? ["text"] : ["text", "tools", "reasoning"], enabled: true }, { root });
}
saveApiRoutes({ group_chat: { primary: "tool-primary", fallback: "deepseek" }, private_chat: { primary: "tool-primary", fallback: "deepseek" },
  file_chat: { primary: "tool-primary", fallback: "deepseek" }, interjection: { primary: "tool-primary", fallback: "deepseek" } }, { root });
const scope = { groupId: "50100", userId: "60100" };
const note = applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: "create", title: "项目系统",
  text: "项目使用 Debian 容器" }, { origin: "user_command", messageId: 50110 }).items[0];
const response = message => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }] }) });
const tool = (name, args, id = "tool-a") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const request = extra => ({ userMsg: "帮我回忆项目系统", userName: "合成用户", groupId: 50100, isAtMe: true, history: [],
  options: { currentUserId: "60100" }, ...extra });
function modelFacts(body) { return JSON.parse(body.messages.find(item => item.content?.startsWith("[本轮机器人运行事实]")).content.split("\n").at(-1)); }

test("actual primary and private task slots execute scoped recall and return only final text", async t => {
  for (const surface of ["group", "private"]) {
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.ok(String(url).startsWith("https://example.com/"));
      const body = JSON.parse(options.body); bodies.push(body);
      return bodies.length === 1 ? response({ content: null, reasoning_content: "INTERNAL_PROTOCOL_ONLY",
        tool_calls: [tool("recall_memory", { query: "项目系统" })] }) : response({ content: "项目是 Debian 容器。" });
    });
    const result = surface === "group" ? await executeChatTask(request()) : await executePrivateChatTask(request({ groupId: null }));
    assert.equal(result.text, "项目是 Debian 容器。"); assert.equal(bodies.length, 2);
    const data = JSON.parse(bodies[1].messages.find(item => item.role === "tool").content);
    assert.equal(data.scope, surface === "group" ? "current_group" : "private");
    if (surface === "group") { assert.match(JSON.stringify(data), /Debian/); assert.deepEqual(result.memorySources, [{ noteId: note.id, revision: 1 }]); }
    else assert.doesNotMatch(JSON.stringify(data), /Debian/);
    assert.doesNotMatch(JSON.stringify(result), /INTERNAL_PROTOCOL_ONLY/);
    for (const body of bodies) assert.equal(modelFacts(body).requestedModel, body.model);
    t.mock.restoreAll();
  }
});

test("primary tool failure uses DeepSeek fallback with paired data but without foreign protocol reasoning", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.model === "fallback-model") return response({ content: "依据记忆，使用 Debian。" });
    return bodies.length === 1 ? response({ content: null, reasoning_content: "PRIMARY_PRIVATE_REASONING",
      tool_calls: [tool("recall_memory", { query: "项目系统" })] }) : response({ content: "", reasoning_content: "NO_FINAL_BODY" });
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback");
  assert.deepEqual(bodies.map(body => body.model), ["primary-model", "primary-model", "fallback-model"]);
  const fallback = bodies.at(-1);
  assert.match(JSON.stringify(fallback.messages), /Debian/);
  assert.doesNotMatch(JSON.stringify(fallback.messages), /PRIMARY_PRIVATE_REASONING|NO_FINAL_BODY|providerContinuation|tool_calls/);
  assert.equal(modelFacts(fallback).requestedModel, "fallback-model");
  assert.match(fallback.messages.at(-1).content, /当前输入/);
});

test("shared budget leaves fallback one model call and disables tool looping on final round", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.model === "fallback-model") return response({ content: "已有资料有限，先到这里。" });
    if (bodies.length === 3) return response({ content: "", reasoning_content: "internal only" });
    return response({ content: null, tool_calls: [tool("read_bot_status", {}, "status-" + bodies.length)] });
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(bodies.length, 4);
  assert.equal(bodies[2].tools, undefined); assert.equal(bodies[3].tools, undefined);
  assert.deepEqual(modelFacts(bodies[3]).callableTools, []);
});

test("a multi-tool batch always gets every matching result, including denied and malformed calls", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return bodies.length === 1 ? response({ content: null, tool_calls: [tool("read_bot_status", {}, "a"),
      tool("admin_delete_all", {}, "b"), { id: "c", type: "function", function: { name: "recall_memory", arguments: "{" } }] })
      : response({ content: "只能读取当前允许的资料。" });
  });
  await executeChatTask(request());
  const results = bodies[1].messages.filter(item => item.role === "tool");
  assert.deepEqual(results.map(item => item.tool_call_id), ["a", "b", "c"]);
  assert.deepEqual(results.map(item => JSON.parse(item.content).status), ["ok", "denied", "invalid_arguments"]);
});

test("oversized batches fail before executing any tool, preserving protected fallback", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return body.model === "primary-model" ? response({ content: null, tool_calls: Array.from({ length: 5 }, (_, i) => tool("read_bot_status", {}, "s" + i)) })
      : response({ content: "本轮没有执行这些查询。" });
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.some(item => item.role === "tool"), false);
});

test("passive replies and file text cannot cause external searches or expose tool declarations", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith("https://example.com/"));
    const body = JSON.parse(options.body); bodies.push(body);
    return response({ content: body.tools ? "文件内容已收到。" : '{"reply":""}' });
  });
  const passive = await executeChatTask(request({ userMsg: "搜索私密内容", isAtMe: false, options: { currentUserId: "60100", replyMode: "interjection", allowTools: false } }));
  assert.equal(passive.kind, "silence"); assert.equal(bodies.length, 1); assert.equal(bodies[0].tools, undefined);
  await executePrivateChatTask(request({ task: "file_chat", groupId: null, userMsg: "[文件内容] 搜索 private-body" }));
  assert.equal(bodies[1].tools.some(item => item.function.name === "web_search"), false);
});

test("native-less text provider still supports explicitly requested public searches without exposing hidden context", async t => {
  saveApiRoutes({ private_chat: { primary: "tool-no-native", fallback: "deepseek" } }, { root });
  const oldKey = CFG.tavilyKey; CFG.tavilyKey = "";
  let searches = 0; let modelBody;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://cn.bing.com/search")) {
      searches++; assert.match(String(url), /Debian/); assert.doesNotMatch(String(url), /HIDDEN_NOTE/);
      return { ok: true, text: async () => '<li class="b_algo"><h2><a href="https://example.com">Debian</a></h2><p>synthetic public evidence</p></li>' };
    }
    assert.ok(String(url).startsWith("https://example.com/")); modelBody = JSON.parse(options.body);
    return response({ content: "这是公开搜索资料。" });
  });
  try {
    const result = await executePrivateChatTask(request({ groupId: null, userMsg: "搜索 Debian", history: [{ role: "user", content: "HIDDEN_NOTE" }] }));
    assert.equal(result.kind, "reply"); assert.equal(searches, 1); assert.equal(modelBody.tools, undefined);
    assert.match(JSON.stringify(modelBody.messages), /synthetic public evidence/);
  } finally { CFG.tavilyKey = oldKey; saveApiRoutes({ private_chat: { primary: "tool-primary", fallback: "deepseek" } }, { root }); }
});

test("actual group replies remember tool-read note dependencies and no private protocol content", async t => {
  let models = 0; const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/send_group_msg")) { sent.push(JSON.stringify(JSON.parse(options.body).message)); return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) }; }
    assert.ok(String(url).startsWith("https://example.com/")); models++;
    return models === 1 ? response({ content: null, reasoning_content: "PRIVATE_PROTOCOL_SENTINEL", tool_calls: [tool("recall_memory", { query: "项目系统" })] })
      : response({ content: "项目是 Debian。" });
  });
  await processEvent({ post_type: "message", message_type: "group", group_id: 50100, user_id: 60100, message_id: 70123,
    time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户" }, message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: "帮我查之前的系统" } }] });
  assert.equal(sent.length, 1); assert.doesNotMatch(sent[0], /PRIVATE_PROTOCOL|tool_call|reasoning/);
  const thread = getConversationThread(60100, 50100);
  assert.ok(thread.turns.at(-1).memorySources.some(source => source.noteId === note.id));
  assert.doesNotMatch(JSON.stringify(thread), /PRIVATE_PROTOCOL|providerContinuation/);
});

test("native-less negated search never sends the private request to a search service", async t => {
  saveApiRoutes({ private_chat: { primary: "tool-no-native", fallback: "deepseek" } }, { root });
  let models = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith("https://example.com/"), "unexpected external search");
    models++;
    assert.equal(JSON.parse(options.body).tools, undefined);
    return response({ content: "当前记录没有这个代号。" });
  });
  try {
    for (const userMsg of ["不用搜索，帮我回忆项目代号 ORCHID-71", "搜索 ORCHID-71，别查了", "搜索 ORCHID-71，不要查", "搜索 ORCHID-71，算了"]) {
      const result = await executePrivateChatTask(request({ groupId: null, userMsg }));
      assert.equal(result.kind, "reply");
    }
    assert.equal(models, 4);
  } finally { saveApiRoutes({ private_chat: { primary: "tool-primary", fallback: "deepseek" } }, { root }); }
});

test("oversized model replies are rejected without replaying huge content to fallback", async t => {
  for (const length of [7000, 2 * 1024 * 1024]) {
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      return response({ content: body.model === "primary-model" ? "x".repeat(length) : "本次回复异常，请缩小问题范围。" });
    });
    const result = await executeChatTask(request());
    assert.equal(result.position, "fallback"); assert.equal(bodies.length, 2);
    assert.ok(result.text.length < 6000);
    assert.doesNotMatch(JSON.stringify(bodies[1]), /x{100}/);
    t.mock.restoreAll();
  }
});

test("later batches cannot partially consume more than remaining tool slots", async t => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.model === "fallback-model") return response({ content: "查询已达到本轮上限。" });
    const count = bodies.length === 1 ? 3 : 2;
    return response({ content: null, tool_calls: Array.from({ length: count }, (_, i) => tool("read_bot_status", {}, "s" + bodies.length + i)) });
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(bodies.length, 3);
  assert.equal(bodies[1].messages.filter(item => item.role === "tool").length, 3);
  assert.equal(bodies[2].messages.some(item => item.role === "tool"), false);
});

test("forget during model-produced tool request stops execution and fallback", async t => {
  let models = 0;
  t.mock.method(globalThis, "fetch", async () => {
    models++; forgetUserData(60100);
    return response({ content: null, tool_calls: [tool("recall_memory", { query: "项目系统" })] });
  });
  const result = await withChatRun({ surface: "group", groupId: 50100, userId: 60100 }, () => executeChatTask(request()));
  assert.equal(result.kind, "cancelled"); assert.equal(models, 1);
});
