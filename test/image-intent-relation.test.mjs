import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, mock, test } from "node:test";
import sharp from "sharp";

const temporaryParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, "qqfriend-intent-relation-"));
// Only these named environment values are saved, replaced and restored.
const env = { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_IMAGE_CONTEXT_ROLLOUT: "52100",
  QQBOT_GROUPS: "52100,52101", QQBOT_FRIENDS: "62100", QQBOT_BLACKLIST: "", QQBOT_ADMINS: "",
  QQBOT_AGENT_GROUPS: "", QQBOT_AGENT_MATERIAL_GROUPS: "", QQBOT_AGENT_DRAFT_GROUPS: "",
  QQBOT_AGENT_WRITE_GROUPS: "", QQBOT_AGENT_REMINDER_GROUPS: "", QQBOT_NAPCAT_TOKEN: "",
  QQBOT_NAPCAT_API: "https://example.invalid/unused", QQBOT_NAPCAT_WS_API: "",
  QQBOT_JM_PYTHON: path.join(root, "unused-python.exe"), QQBOT_JMCOMIC_SRC: path.join(root, "unused-jm"),
  QQBOT_JM_ZIP_PASSWORD: "", QQBOT_MEME_AUTO_UPDATE: "false", QQBOT_LINK_PREVIEW_ENABLED: "false",
  QQBOT_STICKERS_ENABLED: "false", QQBOT_LEGACY_PROFILE_REFRESH: "0" };
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const guards = [];
const forbidden = () => { throw new Error("real network forbidden in intent-relation tests"); };
for (const [target, names] of [[globalThis, ["fetch"]], [http, ["request", "get"]], [https, ["request", "get"]],
  [net.Socket.prototype, ["connect"]], [tls, ["connect"]], [dgram.Socket.prototype, ["connect", "send"]],
  [dns, ["lookup", "lookupService"]], [dnsPromises, ["lookup", "lookupService"]]]) {
  for (const name of names) guards.push(mock.method(target, name, forbidden));
}
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
  "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
  for (const target of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
    guards.push(mock.method(target, name, forbidden));
  }
}
syncBuiltinESMExports();

const { CFG } = await import("../bridge/config.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask, executePrivateChatTask } = await import("../bridge/model-router.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { buildCurrentInput, buildQuotedMessageBlock } = await import("../bridge/context/messages.mjs");
const { registerContextGroups, registeredQuoteReading } = await import("../bridge/context/pruning.mjs");
const { buildImageInterpretationRules } = await import("../bridge/system-prompts/image-context.mjs");
const { buildModelPrompt } = await import("../bridge/system-prompts/compose.mjs");
const { IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE } = await import("../bridge/system-prompts/image-policy.mjs");
const { clearVisionDescriptionCache } = await import("../bridge/vision/description-cache.mjs");
const evidence = { imagePolicy: IMAGE_POLICY_EVIDENCE };
const plain = buildImageInterpretationRules(evidence);
const focused = buildImageInterpretationRules({ ...evidence, imageTask: true });
const system = buildModelPrompt({ ...evidence, imageTask: true }).system;
const scope = { surface: "group", groupId: "52100", userId: "62100" };
const placeholder = "Synthetic transport placeholder, not a semantic answer.";
const reasoning = "INTENT_RELATION_PRIVATE_REASONING_SENTINEL";
const objective = "Synthetic objective-description transport fixture; not an interpretation.";
const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#35805f" } }).png().toBuffer();
const hash = value => createHash("sha256").update(value).digest("hex");
const textOf = content => typeof content === "string" ? content
  : content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
let refusedFetches = 0;

after(() => {
  cleanupLogger();
  clearVisionDescriptionCache();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    assert.equal(refusedFetches, 0, "undeclared fetch attempts must not be swallowed");
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0, "no real network entry point may be used");
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryParent);
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    for (const guard of guards.toReversed()) guard.mock.restore();
    syncBuiltinESMExports();
  }
});

test.beforeEach(() => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "52100";
  Object.assign(CFG, { groupWhitelist: [52100, 52101], friendWhitelist: [62100], botBlacklist: [], agentGroupWhitelist: [] });
});

function request(question, asset = "fixture") {
  return { groupId: 52100, userName: "synthetic-speaker", userMsg: question, history: [], isAtMe: true,
    imageUrls: ["https://example.com/intent-" + asset + ".png"],
    options: { currentUserId: "62100", currentInput: buildCurrentInput("synthetic-speaker", question, "62100"),
      allowTools: false, personaCue: "intent-cue", imageSources: [{ kind: "current", userId: "62100" }] } };
}

// Real router, vision session, constructors and gateway; only fetch supplies synthetic bytes/replies.
async function execute(t, input, { entry = "native", fallback = true, liveScope = scope } = {}) {
  clearVisionDescriptionCache();
  for (const [id, model] of [["intent-primary", "intent-primary"], ["deepseek", "intent-fallback"], ["intent-vision", "intent-vision"]]) {
    saveApiProvider({ id, model, presetId: "custom-openai-chat", auth: "none", enabled: true,
      endpoint: "https://example.com/" + model,
      capabilities: entry === "description" && id !== "intent-vision" ? ["text", "tools"] : ["text", "vision", "tools"] }, { root });
  }
  saveApiRoutes({ group_chat: { primary: "intent-primary", fallback: "deepseek" },
    private_chat: { primary: "deepseek", fallback: "deepseek" },
    interjection: { primary: "intent-primary", fallback: "intent-primary" },
    vision: { primary: "intent-vision", fallback: null } }, { root });
  const original = globalThis.structuredClone(input), bodies = [], downloads = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (input.imageUrls.includes(String(url))) {
      downloads.push(String(url));
      return new globalThis.Response(png, { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(init?.body || "null");
    if (!body || !["intent-primary", "intent-fallback", "intent-vision"].includes(body.model) ||
      String(url) !== "https://example.com/" + body.model || init?.method !== "POST") {
      refusedFetches++;
      throw new Error("undeclared fetch refused");
    }
    assert.equal(new globalThis.Headers(init.headers).has("authorization"), false);
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: {
      content: body.model === "intent-vision" ? objective : fallback && body.model === "intent-primary" ? "" : placeholder,
      reasoning_content: reasoning,
    } }] }) };
  });
  const result = await withChatRun(liveScope, () => liveScope.surface === "private"
    ? executePrivateChatTask(input) : executeChatTask(input));
  assert.equal(result.kind, "reply");
  assert.equal(result.text, placeholder, "transport sentinel is not semantic-quality evidence");
  assert.doesNotMatch(JSON.stringify(result), /INTENT_RELATION_PRIVATE_REASONING_SENTINEL/);
  assert.deepEqual(input, original);
  const chat = bodies.filter(body => body.model !== "intent-vision");
  assert.deepEqual(chat.map(body => body.model), liveScope.surface === "private" ? ["intent-fallback"]
    : fallback ? ["intent-primary", "intent-fallback"] : ["intent-primary"]);
  for (const body of bodies) {
    assert.doesNotMatch(JSON.stringify(body), /INTENT_RELATION_PRIVATE_REASONING_SENTINEL/);
    assert.ok(!body.tools?.length);
  }
  assert.deepEqual(downloads, Object.hasOwn(input.options, "visionContext") ? [] : input.imageUrls);
  return { bodies, chat, result };
}

function assertFocused(body, input) {
  assert.equal(body.messages[0].content, system);
  const all = body.messages.map(message => textOf(message.content)).join("\n");
  assert.equal(all.split(focused).length, 2, "focused policy occurs once across the entire wire request");
  for (const line of focused.split("\n")) assert.equal(all.split(line).length, 2);
  assert.ok(textOf(body.messages.at(-1).content).endsWith(input.options.currentInput));
  assert.equal(all.split(input.options.currentInput).length, 2);
}

test("focused policy separates literal/context relations from attributed acts and preserves source rules", () => {
  assert.match(focused, /吻合或反差.*不能推出.*行为、态度或目的/);
  assert.match(focused, /褒贬含义不证明作者的赞扬或贬低行为/);
  assert.match(focused, /归因须有作者直接说明的原话/);
  assert.match(focused, /必须归属于提供该原话的说话人或已标注的引用来源/);
  assert.match(focused, /身份不明，不推断调侃对象/);
  assert.match(focused, /不用‘可能’或‘像是在’绕过归因证据/);
  assert.match(focused, /明确意图原话按来源保留，不因意图未验证就否认或遗漏自述/);
  assert.equal(hash(plain), "984ea1557a70449f934ee9a252d0f0fe19946478d9ed887d42234f1d264d8418");
  for (const index of [2, 3, 4]) assert.equal(focused.split("\n")[index], plain.split("\n")[index]);
});

test("native and actual description gateways share one focused declaration on primary and fallback", async t => {
  for (const entry of ["native", "description"]) {
    const input = request("解释图中文字与本轮事情的关系。", "entry-" + entry);
    const { bodies, chat } = await execute(t, input, { entry });
    for (const body of chat) {
      assertFocused(body, input);
      const text = textOf(body.messages.at(-1).content);
      assert.match(text, /消息发送人 uid=62100.*verificationScope=message_origin_only/);
      assert.match(text, /image_authorship\/intent=not_verified_by_message_origin/);
      assert.match(text, /原话未说明的动机不从反差补出来/);
      assert.equal(Array.isArray(body.messages.at(-1).content), entry === "native");
    }
    const vision = bodies.filter(body => body.model === "intent-vision");
    assert.equal(vision.length, entry === "description" ? 1 : 0);
    if (vision.length) {
      assert.match(vision[0].messages[0].content, /只描述可见画面，不替用户回复，不分析聊天含义/);
      assert.doesNotMatch(JSON.stringify(vision[0].messages), /解释图中文字与本轮事情的关系|图片问答范围/);
      for (const body of chat) assert.ok(textOf(body.messages.at(-1).content).includes(objective));
    }
  }
});

for (const [name, word] of [["praise with success", "表现出色"], ["negative wording with success", "糟糕透了"]]) {
  test(name + " retains supplied words/results without assembling sender intent", async t => {
    for (const entry of ["native", "description"]) {
      const input = request("验收已成功。图中文字为‘" + word + "’。这句与结果有什么关系？", name.replaceAll(" ", "-"));
      const { chat } = await execute(t, input, { entry });
      for (const body of chat) {
        assertFocused(body, input);
        const material = body.messages.slice(1).map(message => textOf(message.content)).join("\n");
        assert.ok(material.includes(input.options.currentInput));
        assert.doesNotMatch(material, /(?:发送者|发图者|上传者)(?:是在|想要|意在|为了|正在)(?:赞扬|贬低|鼓励|安慰|嘲讽)|(?:赞扬|贬低|鼓励|安慰|嘲讽)(?:你|自己)/);
        assert.doesNotMatch(material, /\[与本轮图片一起阅读的引用资料\]/);
        const last = body.messages.at(-1).content;
        if (entry === "native") assert.deepEqual(last.map(part => part.type), ["text", "image_url", "text"]);
      }
    }
  });
}

for (const userId of ["62100", "62101"]) {
  test("explicit quoted self-claim retains near-image provenance for uid=" + userId, async t => {
    for (const entry of ["native", "description"]) {
      const input = request("解释被回复者明说的用途与图中文字的关系。", "claim-" + userId + "-" + entry);
      const quote = { role: "user", content: buildQuotedMessageBlock("我发这张图是为了鼓励同事。", "synthetic-speaker",
        { state: "verified", userId, messageId: "72101" }) };
      input.history = [quote];
      registerContextGroups(input.history, [{ group: "intent-quote", priority: 95, index: 0,
        sources: [{ kind: "quote", userId, messageId: "72101", verified: true, clipped: false, groupId: "52100" }],
        memorySources: [], memoryExpiresAt: null }]);
      const reading = registeredQuoteReading(input.history);
      assert.equal(reading.length, 1);
      assert.deepEqual(reading[0].sources[0], { speakerUid: userId, messageId: "72101", sourceVerified: true,
        sourceRole: "quoted_message_speaker", verificationScope: "message_origin_only", excerptTruncated: false });
      const { chat } = await execute(t, input, { entry });
      for (const body of chat) {
        assertFocused(body, input);
        assert.ok(body.messages.some(message => message.content === quote.content));
        const near = textOf(body.messages.at(-1).content);
        const marker = "[与本轮图片一起阅读的引用资料]\n";
        assert.equal(near.split(marker).length, 2);
        assert.deepEqual(JSON.parse(near.split(marker)[1].split("\n")[0]), { providedQuotes: reading });
        assert.match(near, /不新增其心理事实.*不把引用者自述转成上传者意图/);
        assert.match(near, /消息发送人 uid=62100/);
        assert.match(body.messages[0].content, /只报告其说法，不视为已验证的心理事实/);
        assert.match(body.messages[0].content, /UID 未知或不同、仅昵称相同，都不合并身份/);
      }
    }
  });
}

test("ordinary text retains original nonfocused system bytes despite caller escalation", async t => {
  const input = request("普通文字问题：计算 4 + 9。", "absent");
  input.imageUrls = [];
  Object.assign(input.options, { imageTask: true, imagePolicy: IMAGE_POLICY_EVIDENCE });
  const { chat } = await execute(t, input);
  for (const body of chat) {
    assert.equal(hash(body.messages[0].content), "99c0e87a861043ce2ec614019015e125b399e6642dc32be4105a3f18d86cedd3");
    assert.equal(body.messages.at(-1).content, input.options.currentInput);
  }
});

test("closed and nonselected image scopes retain original STABLE system bytes", async t => {
  for (const [rollout, groupId] of [["", 52100], ["52100", 52101]]) {
    process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = rollout;
    const input = request("解释图中文字。", "stable-" + groupId);
    input.groupId = groupId;
    Object.assign(input.options, { imageTask: true, imagePolicy: IMAGE_POLICY_EVIDENCE });
    const { chat } = await execute(t, input, { liveScope: { ...scope, groupId: String(groupId) } });
    for (const body of chat) assert.equal(hash(body.messages[0].content), "125a70f8c22cb3000b07c68e4f513059ac0edc33702c75714b5e9d4c3bce72ff");
  }
});

test("private and passive image scopes retain their original system hashes", async t => {
  const input = request("私聊：解释单据文字。", "private");
  input.groupId = null;
  Object.assign(input.options, { imageTask: true, imagePolicy: IMAGE_POLICY_EVIDENCE, visionContext: objective });
  const { chat } = await execute(t, input, { liveScope: { surface: "private", groupId: null, userId: "62100" } });
  assert.equal(hash(chat[0].messages[0].content), "125a70f8c22cb3000b07c68e4f513059ac0edc33702c75714b5e9d4c3bce72ff");
  for (const [rollout, imagePolicy, originalHash] of [
    ["52100", IMAGE_POLICY_EVIDENCE, "03c56ff80d345260130f35e0ec48b2f7fc7dfc3671af1234ed05f1c74222c87c"],
    ["", IMAGE_POLICY_STABLE, "723ce7abce534607cda82f7acb84e39bf4712e6d7a5d8a6fcb192cdf70032ec3"],
  ]) {
    process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = rollout;
    const passive = request("旁观消息。", "passive");
    Object.assign(passive.options, { replyMode: "interjection", imageTask: true, imagePolicy: IMAGE_POLICY_EVIDENCE });
    const wire = await execute(t, passive, { fallback: false });
    assert.equal(hash(wire.chat[0].messages[0].content), originalHash);
    assert.equal(wire.chat[0].messages[0].content, buildModelPrompt({ imagePolicy, replyMode: "interjection" }).system);
  }
});

test("reasoning-only primary falls back and reasoning on either slot never becomes final output", async t => {
  for (const fallback of [false, true]) {
    const input = request("解释这句图中文字。", "reasoning-" + fallback);
    const wire = await execute(t, input, { fallback });
    assert.equal(wire.result.position, fallback ? "fallback" : "primary");
    for (const body of wire.chat) assertFocused(body, input);
  }
});
