import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import sharp from "sharp";
import { resolveImagePolicy, IMAGE_POLICY_STABLE, IMAGE_POLICY_EVIDENCE } from "../bridge/system-prompts/image-policy.mjs";

const temporaryParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, "qqfriend-image-rollout-"));
const env = { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_IMAGE_CONTEXT_ROLLOUT: "" };
const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const { CFG } = await import("../bridge/config.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { buildModelPrompt } = await import("../bridge/system-prompts/compose.mjs");
const { buildImageInterpretationRules } = await import("../bridge/system-prompts/image-context.mjs");
const { clearVisionDescriptionCache } = await import("../bridge/vision/description-cache.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
CFG.groupWhitelist = [50100, 50101]; CFG.friendWhitelist = [60100]; CFG.botBlacklist = [];
for (const id of ["pixel", "text", "objective", "deepseek"]) saveApiProvider({ id, model: id,
  presetId: "custom-openai-chat", auth: "none", endpoint: "https://example.com/" + id,
  capabilities: id === "text" || id === "deepseek" ? ["text"] : ["text", "vision"], enabled: true }, { root });
saveApiRoutes({ group_chat: { primary: "pixel", fallback: "deepseek" },
  private_chat: { primary: "pixel", fallback: "text" }, file_chat: { primary: "pixel", fallback: "text" },
  interjection: { primary: "pixel", fallback: "deepseek" }, vision: { primary: "objective", fallback: null } }, { root });
const asset = "https://example.com/fixture.png";
const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#a02d4c" } }).png().toBuffer();
after(() => {
  cleanupLogger();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(fs.realpathSync(root)), temporaryParent);
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => { process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = ""; clearVisionDescriptionCache(); });

test("image rollout defaults closed and rejects malformed or unbounded group declarations", () => {
  for (const raw of [undefined, "", "*", "ALL", "0", "050100", "50100,not-a-group", "1,".repeat(400),
    Array.from({ length: 33 }, (_, index) => String(index + 1)).join(",")]) {
    assert.equal(resolveImagePolicy({ surface: "group", groupId: "50100" }, raw), IMAGE_POLICY_STABLE);
  }
});
test("gray group selection does not expand to another group or private chat", () => {
  assert.equal(resolveImagePolicy({ surface: "group", groupId: 50100 }, "50100;50102"), IMAGE_POLICY_EVIDENCE);
  assert.equal(resolveImagePolicy({ surface: "group", groupId: 50100 }, "50100,,50101"), IMAGE_POLICY_EVIDENCE);
  assert.equal(resolveImagePolicy({ surface: "group", groupId: 50101 }, "50100;50102"), IMAGE_POLICY_STABLE);
  assert.equal(resolveImagePolicy({ surface: "private", groupId: 50100 }, "50100"), IMAGE_POLICY_STABLE);
  assert.equal(resolveImagePolicy({ surface: "private" }, "all"), IMAGE_POLICY_EVIDENCE);
});
test("candidate instructions separate factual context, literal relation, and attributed intent", () => {
  const rules = buildImageInterpretationRules({ imagePolicy: IMAGE_POLICY_EVIDENCE });
  assert.match(rules, /心理意图是未知/);
  assert.match(rules, /说话人明确说明的意图可以复述为其自述/);
  assert.match(rules, /反差证明不了/);
  assert.match(rules, /没有足够情境时只解释字面/);
  assert.match(rules, /示例不是本轮事实/);
  assert.doesNotMatch(rules, /GOOD JOB|TERRIBLE JOB|考试/);
});

test("image-only brevity never limits unrelated text answers or requires a fixed motive disclaimer", () => {
  const rules = buildImageInterpretationRules({ imagePolicy: IMAGE_POLICY_EVIDENCE });
  assert.match(rules, /本轮需要解读图片或图中文字时/);
  assert.match(rules, /不限制不依赖图片的正常回答长度/);
  assert.match(rules, /不固定追加动机免责声明/);
  assert.match(rules, /反话不是把字面取反就得到真实态度或目的/);
  assert.match(rules, /说话人明确说明的意图可以复述为其自述/);
  assert.doesNotMatch(rules, /无法知道他为何这样说/);
});
test("stable templates stay byte-identical outside gray group and candidate metadata is distinct", () => {
  const before = buildModelPrompt({ groupId: 50101 });
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  assert.deepEqual(buildModelPrompt({ groupId: 50101 }), before);
  const candidate = buildModelPrompt({ groupId: 50100 });
  assert.match(candidate.metadata.promptVersion, /image-evidence-v4$/);
  assert.notEqual(candidate.metadata.promptFingerprint, before.metadata.promptFingerprint);
  const changedStyle = buildModelPrompt({ groupId: 50100, mood: "different", personaCue: "hiss" });
  assert.equal(candidate.system, changedStyle.system);
  assert.equal(candidate.metadata.promptFingerprint, changedStyle.metadata.promptFingerprint);
  assert.equal(candidate.system.split("图片解读任务：").length, 2);
});

function request(groupId = 50100, extra = {}) {
  return { groupId, userName: "synthetic-speaker", userMsg: "这张图是什么意思？", imageUrls: [asset], isAtMe: true,
    history: [{ role: "user", content: "[已选近期原话] 我没完成这次项目。" }],
    options: { currentUserId: "60100", currentInput: "[当前输入]\nspeaker=synthetic-speaker uid=60100\nmessage=这张图是什么意思？", allowTools: false }, ...extra };
}
function capture(t, reply) {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === asset) return new globalThis.Response(png, { headers: { "content-type": "image/png" } });
    assert.ok(String(url).startsWith("https://example.com/"));
    const body = JSON.parse(options.body); bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: await reply(body) }] }) };
  });
  return bodies;
}
test("actual pixel gateway receives one evidence policy only for selected group", async t => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  const bodies = capture(t, () => ({ content: "字面与前文形成反差。" }));
  await executeChatTask(request());
  await executeChatTask(request(50101));
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].messages[0].content, /图片解读任务：/);
  assert.doesNotMatch(bodies[1].messages[0].content, /图片解读任务：/);
  assert.equal(JSON.stringify(bodies[0].messages).split("图片解读任务：").length, 2);
  assert.ok(bodies[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")));
  assert.equal(bodies[0].messages.at(-1).content, request().options.currentInput);
});
test("primary failure and objective description retain captured policy even if rollout environment changes", async t => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  const bodies = capture(t, body => {
    if (body.model === "pixel") { process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = ""; return { content: "", reasoning_content: "PRIVATE_SYNTHETIC" }; }
    return { content: body.model === "objective" ? "图1：深红色矩形，没有可见文字。" : "只依据字面及当前情境。" };
  });
  const result = await executeChatTask(request());
  assert.equal(result.position, "fallback");
  assert.deepEqual(bodies.map(body => body.model), ["pixel", "objective", "deepseek"]);
  assert.match(bodies[2].messages[0].content, /图片解读任务：/);
  assert.match(JSON.stringify(bodies[2].messages), /深红色矩形|我没完成这次项目/);
  assert.doesNotMatch(JSON.stringify(bodies[2].messages), /PRIVATE_SYNTHETIC|data:image/);
  assert.doesNotMatch(JSON.stringify(bodies[1].messages), /图片解读任务|没完成这次项目/);
});
test("private and file routes remain stable during group-only gray release", async t => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  const bodies = capture(t, () => ({ content: "只描述已读取画面。" }));
  for (const task of ["private_chat", "file_chat"]) await executePrivateChatTask(request(null, { task }));
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.doesNotMatch(body.messages[0].content, /图片解读任务：/);
});
test("verified live scope determines rollout instead of a mismatched request scope", async () => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  let captured;
  await withChatRun({ surface: "group", groupId: 50101, userId: 60100 }, () => executeChatTask(request(), {
    primaryChat: async input => { captured = input.options.imagePolicy; return "bounded synthetic answer"; },
  }));
  assert.equal(captured, IMAGE_POLICY_STABLE);
});
