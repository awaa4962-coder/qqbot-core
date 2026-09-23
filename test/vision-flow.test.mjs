import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import sharp from "sharp";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-vision-flow-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { clearVisionDescriptionCache, getVisionDescriptionCacheStatus } = await import("../bridge/vision/description-cache.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { withMessageTrace, createTraceRecorder } = await import("../bridge/diagnostics/message-trace.mjs");
const { measureVisionRequest } = await import("../bridge/vision/request-budget.mjs");
CFG.groupWhitelist = [50100, 50101]; CFG.friendWhitelist = [60100, 60101]; CFG.botBlacklist = [];
const pixel = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#d33344" } }).png().toBuffer();
const asset = "https://example.com/asset.png";
for (const id of ["pixel-primary", "pixel-backup", "text-primary", "text-backup", "objective"]) {
  saveApiProvider({ id, model: id, presetId: "custom-openai-chat", auth: "none", endpoint: "https://example.com/" + id,
    capabilities: id.startsWith("text") ? ["text", "tools"] : ["text", "vision", "tools"], enabled: true }, { root });
}
function routes(primary, fallback) {
  saveApiProvider({ id: "deepseek", model: fallback, presetId: "custom-openai-chat", auth: "none", endpoint: "https://example.com/" + fallback,
    capabilities: fallback.startsWith("text") ? ["text", "tools"] : ["text", "vision", "tools"], enabled: true }, { root });
  saveApiRoutes({ group_chat: { primary, fallback: "deepseek" }, private_chat: { primary, fallback }, file_chat: { primary, fallback },
    interjection: { primary, fallback }, vision: { primary: "objective", fallback: null } }, { root });
}
const request = extra => ({ userMsg: "这张图在这里是什么意思？", userName: "合成用户", groupId: 50100, imageUrls: [asset], isAtMe: true,
  history: [{ role: "user", content: "[已选近期原话] 甲：我这次考试终于过了。" }],
  options: { currentUserId: "60100", currentInput: "[当前输入]\nmessage=这张图是什么意思？" }, ...extra });
const response = message => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }] }) });
function capture(t, modelReply) {
  const bodies = []; let downloads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === asset) { downloads++; return new globalThis.Response(pixel, { headers: { "content-type": "image/png" } }); }
    assert.ok(String(url).startsWith("https://example.com/"), "unexpected external request");
    const body = JSON.parse(options.body); bodies.push(body);
    return modelReply(body, bodies);
  });
  return { bodies, downloads: () => downloads };
}
const images = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url") : []);
test.beforeEach(() => { clearVisionDescriptionCache(); routes("pixel-primary", "text-backup"); });

test("vision-enabled chat receives selected conversation and pixels with no separate description request", async t => {
  const { bodies, downloads } = capture(t, () => response({ content: "是在替你庆祝。" }));
  const result = await executeChatTask(request());
  assert.equal(result.kind, "reply"); assert.equal(downloads(), 1); assert.equal(bodies.length, 1);
  assert.equal(images(bodies[0]).length, 1); assert.match(images(bodies[0])[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(JSON.stringify(bodies[0].messages), /考试终于过了|本轮图片证据/);
  assert.equal(bodies[0].messages.at(-1).content, request().options.currentInput);
  assert.doesNotMatch(JSON.stringify(bodies), /asset\.png|trustedImageUrls|PRIVATE/);
});

test("vision failure uses lazy objective route then DeepSeek-style text fallback without redownloading", async t => {
  const { bodies, downloads } = capture(t, body => response(body.model === "pixel-primary" ? { content: "", reasoning_content: "PRIMARY_PRIVATE" }
    : { content: body.model === "objective" ? "图1：红色矩形，没有可见文字。" : "它可能是在呼应庆祝的语境。" }));
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(downloads(), 1);
  assert.deepEqual(bodies.map(body => body.model), ["pixel-primary", "objective", "text-backup"]);
  assert.equal(images(bodies[2]).length, 0); assert.match(JSON.stringify(bodies[2]), /红色矩形|考试终于过了/);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /考试|当前输入|合成用户/);
  assert.doesNotMatch(JSON.stringify(bodies[2]), /PRIMARY_PRIVATE|providerContinuation|data:image/);
});

test("text primary and pixel fallback share assets but never share private assistant transcripts", async t => {
  routes("text-primary", "pixel-backup");
  const { bodies, downloads } = capture(t, body => response(body.model === "text-primary" ? { content: "", reasoning_content: "TEXT_PRIVATE" }
    : { content: body.model === "objective" ? "图1：红色矩形。" : "图里是红色矩形。" }));
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(downloads(), 1);
  assert.deepEqual(bodies.map(body => body.model), ["objective", "text-primary", "pixel-backup"]);
  assert.equal(images(bodies[1]).length, 0); assert.equal(images(bodies[2]).length, 1);
  assert.doesNotMatch(JSON.stringify(bodies[2]), /TEXT_PRIVATE/);
});

test("same-protocol pixel fallback starts its own transcript and skips objective generation", async t => {
  routes("pixel-primary", "pixel-backup");
  const { bodies, downloads } = capture(t, body => response(body.model === "pixel-primary" ? { reasoning_content: "SAME_PROTOCOL_PRIVATE" } : { content: "只依据本轮图片回答。" }));
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(downloads(), 1); assert.equal(bodies.length, 2);
  assert.equal(images(bodies[1]).length, 1); assert.doesNotMatch(JSON.stringify(bodies[1]), /SAME_PROTOCOL_PRIVATE/);
});

test("objective cache is exact and scoped while interpretations always get the new conversation", async t => {
  routes("text-primary", "text-backup");
  const { bodies } = capture(t, body => response({ content: body.model === "objective" ? "图1：红色矩形。" : "根据本轮语境理解。" }));
  await executeChatTask(request());
  await executeChatTask(request({ history: [{ role: "user", content: "[已选近期原话] 我这次考试没过。" }] }));
  assert.equal(bodies.filter(body => body.model === "objective").length, 1);
  const second = bodies.at(-1);
  assert.match(JSON.stringify(second), /考试没过/); assert.doesNotMatch(JSON.stringify(second), /考试终于过了/);
  assert.equal(getVisionDescriptionCacheStatus().hits, 1);
  await executeChatTask(request({ groupId: 50101 }));
  assert.equal(bodies.filter(body => body.model === "objective").length, 2);
  invalidateMemoryPrivacyGeneration();
  assert.equal(getVisionDescriptionCacheStatus().entries, 0);
  await executeChatTask(request());
  assert.equal(bodies.filter(body => body.model === "objective").length, 3);
});

test("private and file chat use their existing routes with direct pixels and no new long-term storage", async t => {
  const { bodies } = capture(t, () => response({ content: "图片收到。" }));
  for (const task of ["private_chat", "file_chat"]) {
    await executePrivateChatTask(request({ task, groupId: null, history: [] }));
    assert.equal(images(bodies.at(-1)).length, 1);
    assert.equal(bodies.at(-1).messages.at(-1).content, request().options.currentInput);
    if (task === "file_chat") assert.equal(bodies.at(-1).tools.some(tool => tool.function.name === "web_search"), false);
  }
  assert.equal(bodies.length, 2);
});

test("download failure reaches chat with an honest no-image marker and no objective API call", async t => {
  const { bodies, downloads } = capture(t, () => response({ content: "这张图没读到，能再发一次吗？" }));
  await executeChatTask(request({ imageUrls: ["http://127.0.0.1/private"] }));
  assert.equal(downloads(), 0); assert.equal(bodies.length, 1); assert.equal(images(bodies[0]).length, 0);
  assert.match(JSON.stringify(bodies[0]), /视觉识别失败|未能读取=1/);
});

test("forget during asset download cancels both model slots and creates no cache", async t => {
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), asset); downloads++; invalidateMemoryPrivacyGeneration();
    return new globalThis.Response(pixel, { headers: { "content-type": "image/png" } });
  });
  const result = await withChatRun({ surface: "group", groupId: 50100, userId: 60100 }, () => executeChatTask(request()));
  assert.equal(result.kind, "cancelled"); assert.equal(downloads, 1); assert.equal(getVisionDescriptionCacheStatus().entries, 0);
});

test("vision traces contain counts and paths, never image bytes or URLs", async t => {
  const recorder = createTraceRecorder();
  capture(t, () => response({ content: "已看到图片。" }));
  await withMessageTrace({ message_type: "group", user_id: 60100, group_id: 50100 }, () => executeChatTask(request()), recorder);
  const trace = JSON.stringify(recorder.list());
  assert.match(trace, /image_direct/); assert.doesNotMatch(trace, /data:image|asset\.png|\/9j\//);
});

test("noncanonical image-bearing parts and extra payload overrides cannot bypass admission", () => {
  const url = "data:image/jpeg;base64,YWJj";
  for (const type of ["text", "input_image", "image", undefined]) {
    assert.throws(() => measureVisionRequest({ trustedImageUrls: [url], messages: [{ role: "user", content: [{ type, text: "x", image_url: { url } }] }] }), /image_input_budget/);
  }
  for (const key of ["messages", "input", "contents", "tools", "tool_choice"]) assert.throws(() => measureVisionRequest({ messages: [], extra: { [key]: [] } }), /image_input_budget/);
});

test("same image at a different original index does not reuse a misnumbered objective caption", async t => {
  routes("text-primary", "text-backup");
  const { bodies } = capture(t, body => response({ content: body.model === "objective" ? "图2：红色矩形。" : "有一张可读图片。" }));
  await executeChatTask(request({ imageUrls: ["http://localhost/blocked", asset] }));
  await executeChatTask(request());
  assert.equal(bodies.filter(body => body.model === "objective").length, 2);
});

test("an individual image timeout remains a readable text conversation, not a dead primary and fallback", async t => {
  let downloads = 0; const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === asset) { downloads++; throw Object.assign(new Error("asset deadline"), { name: "AbortError", code: "ABORT_ERR" }); }
    const body = JSON.parse(options.body); bodies.push(body);
    return response(body.model === "pixel-primary" ? { content: "", reasoning_content: "private" } : { content: "图没读到，你可以再发一下。" });
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback"); assert.equal(downloads, 1);
  assert.deepEqual(bodies.map(body => body.model), ["pixel-primary", "text-backup"]);
  for (const body of bodies) { assert.equal(images(body).length, 0); assert.match(JSON.stringify(body), /视觉识别失败/); }
});

test("image data URIs and submitted native base64 fragments cannot become final replies", async t => {
  for (const kind of ["uri", "native", "fragment"]) {
    const { bodies } = capture(t, body => {
      const url = images(body)[0]?.image_url.url;
      const payload = url?.split(",")[1];
      if (body.model === "pixel-primary") return response({ content: kind === "uri" ? url : kind === "native" ? payload : payload.slice(100, 172) });
      return response({ content: body.model === "objective" ? "图1：红色矩形。" : "不直接返回图片编码。" });
    });
    const result = await executeChatTask(request());
    assert.equal(result.position, "fallback"); assert.equal(result.text, "不直接返回图片编码。");
    assert.doesNotMatch(JSON.stringify(bodies.at(-1).messages), /data:image|\/9j\//);
    t.mock.restoreAll(); clearVisionDescriptionCache();
  }
});

test("objective model image echoes are neither cached nor forwarded to the text model", async t => {
  routes("text-primary", "text-backup");
  const { bodies } = capture(t, body => response({ content: body.model === "objective" ? images(body)[0].image_url.url : "图片识别没成功。" }));
  const result = await executeChatTask(request());
  assert.equal(result.kind, "reply"); assert.equal(getVisionDescriptionCacheStatus().entries, 0);
  assert.doesNotMatch(JSON.stringify(bodies.at(-1).messages), /data:image|\/9j\//);
  assert.match(JSON.stringify(bodies.at(-1).messages), /视觉识别失败/);
});
