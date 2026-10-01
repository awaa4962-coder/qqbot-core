import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import sharp from "sharp";
import { IMAGE_POLICY_EVIDENCE, IMAGE_POLICY_STABLE } from "../bridge/system-prompts/image-policy.mjs";

const temporaryParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, "qqfriend-image-input-"));
const env = { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_IMAGE_CONTEXT_ROLLOUT: "50100" };
const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const { CFG } = await import("../bridge/config.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { executeChatTask } = await import("../bridge/model-router.mjs");
const { runScopedChat } = await import("../bridge/chat-tools/runner.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { CHAT_TOOL_LIMITS } = await import("../bridge/chat-tools/policy.mjs");
const { createVisionSession } = await import("../bridge/vision/session.mjs");
const { prepareVisionImages, VISION_IMAGE_LIMITS } = await import("../bridge/vision/images.mjs");
const { clearVisionDescriptionCache, getVisionDescriptionCacheStatus } = await import("../bridge/vision/description-cache.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { invalidateMemoryPrivacyGeneration, invalidateUserMemoryGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { registerContextGroups, registeredContextSources, registeredQuoteReading, hasRegisteredContextGroup } = await import("../bridge/context/pruning.mjs");
const { buildModelPrompt } = await import("../bridge/system-prompts/compose.mjs");
const { buildObjectiveVisionMessages } = await import("../bridge/system-prompts/vision.mjs");

const scope = { surface: "group", groupId: "50100", userId: "60100" };
const assets = ["current", "quote", "recent"].map(kind => "https://example.com/assembly-" + kind + ".png");
const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#a02d4c" } }).png().toBuffer();
const preparedFixture = await prepareVisionImages(assets, { fetchBuffer: async () => ({ buffer: png }) });
const currentInput = "  [当前输入]\r\nspeaker=current-speaker uid=60100\r\nmessage=Compare the image with the quoted statement.\n\nKeep this final question exactly.  \n";
const caption = "图1：深红色矩形。图2：深红色矩形。图3：深红色矩形。";
const reply = "A synthetic answer based on this question only.";
const privateReasoning = "ASSEMBLY_PRIMARY_PRIVATE_REASONING";

function provider(id, model = id) {
  saveApiProvider({ id, model, presetId: "custom-openai-chat", auth: "none",
    endpoint: "https://example.com/" + model, enabled: true,
    capabilities: model.startsWith("text") ? ["text", "tools"] : ["text", "vision", "tools"] }, { root });
}
for (const id of ["pixel-primary", "pixel-fallback", "text-primary", "text-fallback", "objective"]) provider(id);
function routes(primary = "pixel-primary", fallback = "text-fallback") {
  provider("deepseek", fallback);
  saveApiRoutes({ group_chat: { primary, fallback: "deepseek" },
    vision: { primary: "objective", fallback: null } }, { root });
}
after(() => {
  cleanupLogger();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(fs.realpathSync(root)), temporaryParent);
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  Object.assign(CFG, { groupWhitelist: [50100, 50101], friendWhitelist: [60100], agentGroupWhitelist: [50100], botBlacklist: [] });
  clearVisionDescriptionCache();
  routes();
});

function freeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function register(messages, sources = messages.map(() => []), memorySources = messages.map(() => [])) {
  registerContextGroups(messages, messages.map((message, index) => ({ group: "assembly-" + index,
    priority: 90, index, sources: sources[index], memorySources: memorySources[index], memoryExpiresAt: null })));
}
function request(extra = {}) {
  const history = freeze([
    { role: "user", content: "  [已选近期原话] speaker=recent-speaker uid=60102\nmessage=Earlier factual context.  \n" },
    { role: "user", content: "[已核验引用消息] speaker=quote-speaker uid=60101 messageId=70101\nmessage=Quoted statement with two  spaces.\n" },
    { role: "assistant", content: "Prior public answer, not the current question." },
    { role: "user", content: [{ type: "text", text: "  First historical part.\n" }, { type: "text", text: "Second historical part.  " }] },
  ]);
  register(history, history.map((message, index) => [{ messageId: String(70100 + index), userId: index === 1 ? "60101" : "60102", groupId: "50100" }]));
  return { groupId: 50100, userName: "current-speaker", userMsg: "Compare the image with the quoted statement.",
    imageUrls: [...assets], isAtMe: true, history,
    options: { currentUserId: "60100", currentInput, allowTools: false, personaCue: "assembly-cue",
      imageSources: freeze([{ kind: "current", userId: "60100" }, { kind: "quote", userId: "60101" }, { kind: "recent", userId: "60102" }]) }, ...extra };
}
function capture(t, modelReply = () => ({ content: reply }), download = () => png) {
  const bodies = [], downloads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (assets.includes(String(url))) {
      downloads.push(String(url));
      return new globalThis.Response(await download(String(url)), { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(options.body);
    assert.ok(["pixel-primary", "pixel-fallback", "text-primary", "text-fallback", "objective"].includes(body.model), "unexpected provider");
    assert.ok(String(url).startsWith("https://example.com/" + body.model), "unexpected external request");
    bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: await modelReply(body, bodies) }] }) };
  });
  return { bodies, downloads };
}
const images = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url") : []);
function observeEvidence(t, input, imagePolicy = IMAGE_POLICY_EVIDENCE) {
  const session = createVisionSession(input.imageUrls, { scope, imagePolicy, sources: input.options.imageSources });
  const records = [];
  input.options.visionSession = { message: async (...args) => {
    const evidence = await session.message(...args);
    records.push({ model: args[0].model, evidence, snapshot: globalThis.structuredClone(evidence) });
    return evidence;
  } };
  const toolSession = createChatToolSession({ scope, task: "group_chat", userMessage: input.userMsg, allowTools: false });
  const original = toolSession.prepareModel;
  const sources = registeredContextSources(input.history);
  t.mock.method(toolSession, "prepareModel", modelRequest => {
    for (const message of input.history) assert.ok(modelRequest.messages.includes(message), "history object identity lost");
    assert.deepEqual(registeredContextSources(modelRequest.messages), sources);
    return original(modelRequest);
  });
  input.options.toolSession = toolSession;
  return { records, toolSession };
}
function assertAssembly(body, record, input) {
  const last = body.messages.at(-1);
  assert.equal(last.role, "user");
  const evidence = record.snapshot.message.content;
  const quotes = registeredQuoteReading(input.history);
  const reading = quotes.length ? { type: "text", text: "[与本轮图片一起阅读的引用资料]\n" +
    JSON.stringify({ providedQuotes: quotes }) + "\n这里保留原话及来源，不新增其心理事实；按本轮问题理解，不把引用者自述转成上传者意图。" } : null;
  if (Array.isArray(evidence)) {
    assert.deepEqual(last.content, [...(reading ? [reading] : []), ...evidence, { type: "text", text: input.options.currentInput }]);
    assert.deepEqual(last.content.map(part => part.type), [...(reading ? ["text"] : []), "text", "image_url", "image_url", "image_url", "text"]);
    assert.equal(images(body).length, 3);
    for (const part of images(body)) assert.match(part.image_url.url, /^data:image\/jpeg;base64,/);
  } else {
    assert.equal(last.content, (reading ? reading.text + "\n\n" : "") + evidence + "\n\n" + input.options.currentInput);
    assert.equal(images(body).length, 0);
    assert.doesNotMatch(JSON.stringify(body), /data:image|assembly-(?:current|quote|recent)\.png/);
  }
  assert.equal(body.messages.length, input.history.length + 4);
  assert.equal(body.messages[1].role, "system");
  assert.match(body.messages[1].content, /^\[本轮机器人运行事实\]/);
  assert.deepEqual(body.messages.slice(3, -1), input.history);
  const evidenceText = Array.isArray(evidence) ? evidence[0].text : evidence;
  assert.match(evidenceText, /图1：当前消息，消息发送人 uid=60100/);
  assert.match(evidenceText, /图2：已核验引用消息，消息发送人 uid=60101/);
  assert.match(evidenceText, /图3：已选近期消息，消息发送人 uid=60102/);
  assert.equal(JSON.stringify(body.messages).split(JSON.stringify(input.options.currentInput).slice(1, -1)).length, 2);
  assert.deepEqual(record.evidence, record.snapshot, "prepared image evidence was mutated");
}

for (const primary of ["pixel-primary", "text-primary"]) {
  test(`registered quote reading reaches the exact ${primary} wire next to image evidence`, async t => {
    routes(primary, "pixel-fallback");
    const input = request(), original = globalThis.structuredClone(input.history);
    const sources = input.history.map((message, index) => index === 1
      ? [{ kind: "quote", reason: "reply_chain", userId: "60101", messageId: "70101", verified: true }]
      : []);
    register(input.history, sources);
    assert.equal(registeredQuoteReading(input.history).length, 1);
    const { records, toolSession } = observeEvidence(t, input);
    const { bodies } = capture(t, body => ({ content: body.model === "objective" ? caption : reply }));
    const result = await executeChatTask(input);
    assert.equal(result.kind, "reply");
    const body = bodies.find(item => item.model === primary);
    assertAssembly(body, records.find(item => item.model === primary), input);
    const content = body.messages.at(-1).content;
    const reading = Array.isArray(content) ? content[0].text : content.split("\n\n")[0];
    assert.ok(reading.startsWith("[与本轮图片一起阅读的引用资料]\n"));
    const projected = JSON.parse(reading.split("\n")[1]).providedQuotes;
    assert.equal(projected.length, 1);
    assert.equal(projected[0].providedFrame, input.history[1].content);
    assert.deepEqual(projected[0].sources, [{ speakerUid: "60101", messageId: "70101", sourceVerified: true, excerptTruncated: false }]);
    assert.equal(toolSession.snapshot().modelRounds, 1);
    assert.equal(toolSession.snapshot().transportAttempts, 1);
    assert.deepEqual(input.history, original);
    for (const objective of bodies.filter(item => item.model === "objective")) {
      assert.deepEqual(objective.messages, buildObjectiveVisionMessages(preparedFixture));
      assert.doesNotMatch(JSON.stringify(objective.messages), /providedQuotes|Quoted statement|60101|与本轮图片一起阅读/);
    }
  });
}

for (const [primary, fallback, failPrimary] of [
  ["pixel-primary", "text-fallback", false], ["text-primary", "pixel-fallback", false],
  ["pixel-primary", "pixel-fallback", true], ["pixel-primary", "text-fallback", true],
  ["text-primary", "pixel-fallback", true], ["text-primary", "text-fallback", true],
]) {
  test(`evidence-v5 assembles exact current input through ${primary}${failPrimary ? " -> " + fallback : " directly"}`, async t => {
    routes(primary, fallback);
    const input = request(), original = globalThis.structuredClone(input);
    const { records, toolSession } = observeEvidence(t, input);
    const { bodies, downloads } = capture(t, body => {
      if (body.model === primary && failPrimary) {
        process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "";
        return { content: "", reasoning_content: privateReasoning };
      }
      return { content: body.model === "objective" ? caption : reply };
    });
    const result = await executeChatTask(input);
    assert.equal(result.kind, "reply");
    assert.equal(result.position, failPrimary ? "fallback" : "primary");
    assert.equal(result.text, reply);
    const expectedModels = primary.startsWith("text") ? ["objective", primary] : [primary];
    if (failPrimary) {
      if (!primary.startsWith("text") && fallback.startsWith("text")) expectedModels.push("objective");
      expectedModels.push(fallback);
    }
    assert.deepEqual(bodies.map(body => body.model), expectedModels);
    assert.deepEqual(downloads, assets, "primary/fallback must share one prepared download");
    for (const body of bodies.filter(body => body.model !== "objective")) {
      assertAssembly(body, records.find(record => record.model === body.model), input);
      assert.match(body.messages[0].content, /图片解读任务：/);
      assert.equal(body.messages[0].content, buildModelPrompt({ imagePolicy: IMAGE_POLICY_EVIDENCE, groupId: 50100 }).system);
    }
    for (const body of bodies.filter(body => body.model === "objective")) {
      assert.deepEqual(body.messages, buildObjectiveVisionMessages(preparedFixture));
      assert.doesNotMatch(JSON.stringify(body.messages), /当前输入|已核验引用消息|已选近期原话|60100|60101|60102|ASSEMBLY_PRIMARY_PRIVATE_REASONING/);
    }
    assert.doesNotMatch(JSON.stringify(bodies) + JSON.stringify(result), /ASSEMBLY_PRIMARY_PRIVATE_REASONING|providerContinuation|trustedImageUrls/);
    assert.deepEqual(input.history, original.history);
    assert.deepEqual(input.imageUrls, original.imageUrls);
    assert.deepEqual(input.options.imageSources, original.options.imageSources);
    assert.equal(input.options.currentInput, original.options.currentInput);
    assert.equal(toolSession.snapshot().modelRounds, failPrimary ? 2 : 1);
    assert.equal(toolSession.snapshot().transportAttempts, failPrimary ? 2 : 1);
    assert.equal(toolSession.snapshot().toolCalls, 0);
  });
}

test("stable-v3 preserves the separate evidence message on vision and text fallback wires", async t => {
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "";
  const input = request(), original = globalThis.structuredClone(input);
  const { records } = observeEvidence(t, input, IMAGE_POLICY_STABLE);
  const { bodies } = capture(t, body => ({ content: body.model === "pixel-primary" ? "" : body.model === "objective" ? caption : reply }));
  assert.equal((await executeChatTask(input)).position, "fallback");
  for (const body of bodies.filter(body => body.model !== "objective")) {
    assert.equal(body.messages.length, input.history.length + 5);
    assert.deepEqual(body.messages.slice(3, -2), input.history);
    assert.deepEqual(body.messages.at(-2), records.find(record => record.model === body.model).snapshot.message);
    assert.deepEqual(body.messages.at(-1), { role: "user", content: currentInput });
    assert.doesNotMatch(body.messages[0].content, /图片解读任务：/);
  }
  assert.deepEqual(input.history, original.history);
});

test("no-image request assembly stays identical under both policies for primary and fallback", async t => {
  const input = request({ imageUrls: [] });
  const { bodies, downloads } = capture(t, body => ({ content: body.model === "pixel-primary" ? "" : reply }));
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "";
  assert.equal((await executeChatTask(input)).position, "fallback");
  process.env.QQBOT_IMAGE_CONTEXT_ROLLOUT = "50100";
  assert.equal((await executeChatTask(input)).position, "fallback");
  assert.equal(bodies.length, 4);
  assert.deepEqual(downloads, []);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(bodies[index].messages.slice(1), bodies[index + 2].messages.slice(1));
    assert.deepEqual({ ...bodies[index], messages: [] }, { ...bodies[index + 2], messages: [] });
  }
  for (const body of bodies) {
    assert.deepEqual(body.messages.at(-1), { role: "user", content: currentInput });
    assert.deepEqual(body.messages.slice(3, -1), input.history);
    assert.equal(body.messages.length, input.history.length + 4);
    assert.doesNotMatch(JSON.stringify(body.messages.slice(1)), /本轮图片证据|视觉识别失败/);
  }
});

const syntheticEvidence = freeze({ role: "user", content: "[synthetic prepared image evidence]" });
async function guardedLast(t, last, { registered = false, sources = [] } = {}) {
  if (registered) register([last], [sources]);
  const messages = freeze([{ role: "system", content: "Synthetic system." }, last]);
  const session = createChatToolSession({ scope, task: "group_chat", allowTools: false });
  const original = session.prepareModel;
  let prepared = false;
  t.mock.method(session, "prepareModel", modelRequest => {
    prepared = true;
    assert.equal(modelRequest.messages.at(-1), last, "last-message identity must survive the safeguard");
    assert.equal(modelRequest.messages.at(-2), syntheticEvidence);
    assert.deepEqual(registeredContextSources(modelRequest.messages), sources);
    if (registered) assert.equal(hasRegisteredContextGroup(modelRequest.messages.at(-1)), true);
    return original(modelRequest);
  });
  const { bodies } = capture(t);
  const result = await runScopedChat({ messages, selfContext: scope, maxTokens: 128 }, {
    providerId: "pixel-primary", task: "group_chat", imagePolicy: IMAGE_POLICY_EVIDENCE,
    allowTools: false, toolSession: session, visionSession: { message: async () => ({ message: syntheticEvidence, trustedImageUrls: [] }) },
  });
  assert.equal(result.kind, "reply");
  assert.equal(prepared, true);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].messages[0], messages[0]);
  assert.equal(bodies[0].messages[1].role, "system");
  assert.match(bodies[0].messages[1].content, /^\[本轮机器人运行事实\]/);
  assert.deepEqual(bodies[0].messages.slice(2), [syntheticEvidence, last]);
  assert.equal(messages.at(-1), last);
}
for (const sources of [[], [{ messageId: "70101", userId: "60101", groupId: "50100" }]]) {
  test(`registered current user retains its WeakMap identity with ${sources.length ? "nonempty" : "empty"} sources`, async t => {
    await guardedLast(t, freeze({ role: "user", content: currentInput }), { registered: true, sources });
  });
}
for (const [name, last] of [
  ["assistant", { role: "assistant", content: currentInput }],
  ["multimodal", { role: "user", content: [{ type: "text", text: currentInput }] }],
  ["null content", { role: "user", content: null }],
  ["non-string content", { role: "user", content: 42 }],
  ["tool_calls", { role: "user", content: currentInput, tool_calls: [] }],
  ["tool_call_id", { role: "user", content: currentInput, tool_call_id: "native-call" }],
  ["providerContinuation", { role: "user", content: currentInput, providerContinuation: { protocol: "openai-responses", items: [] } }],
  ["reasoning_content", { role: "user", content: currentInput, reasoning_content: "native private continuation" }],
]) {
  test(`unsafe last message (${name}) keeps the split transcript`, async t => guardedLast(t, freeze(last)));
}

for (const [name, invalidate] of [
  ["privacy", () => invalidateMemoryPrivacyGeneration()],
  ["user preference", () => invalidateUserMemoryGeneration(scope.userId, { privacy: false })],
  ["permission", () => { CFG.groupWhitelist = []; }],
]) {
  test(`${name} change during image preparation prevents both model slots from seeing combined input`, async t => {
    const input = request({ imageUrls: [assets[0]] }), original = globalThis.structuredClone(input);
    const { bodies, downloads } = capture(t, () => assert.fail("model called after invalidation"), () => { invalidate(); return png; });
    const result = await withChatRun(scope, () => executeChatTask(input));
    assert.equal(result.kind, "cancelled");
    assert.deepEqual(bodies, []);
    assert.deepEqual(downloads, [assets[0]]);
    assert.equal(getVisionDescriptionCacheStatus().entries, 0);
    assert.deepEqual(input, original);
  });
}

test("registered source revision remains guarded while objective fallback is pending", async t => {
  const input = request();
  let revision = 1;
  const dependency = { noteId: "aabbccddeeff", revision: 1 };
  register(input.history, input.history.map(() => []), [[dependency], [], [], []]);
  input.options.toolSession = createChatToolSession({ scope, task: "group_chat", allowTools: false,
    memoryRead: () => ({ entries: [{ noteId: dependency.noteId, revision, active: true, expiresAt: Date.now() + 60000 }] }) });
  const { bodies } = capture(t, body => {
    if (body.model === "objective") { revision++; return { content: caption }; }
    assert.equal(body.model, "pixel-primary", "stale source reached text fallback");
    return { content: "", reasoning_content: privateReasoning };
  });
  const result = await executeChatTask(input);
  assert.equal(result.kind, "cancelled");
  assert.equal(result.reason, "memory_unavailable");
  assert.deepEqual(bodies.map(body => body.model), ["pixel-primary", "objective"]);
  assert.equal(hasRegisteredContextGroup(input.history[0]), true);
  assert.deepEqual(input.options.toolSession.sources(), [dependency]);
  assert.doesNotMatch(JSON.stringify(result), /ASSEMBLY_PRIMARY_PRIVATE_REASONING/);
});

test("combined image parts still require trusted byte admission, not caller history or MIME labels", async t => {
  const injected = request({ imageUrls: [] });
  injected.history = freeze([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } }] }]);
  const { bodies } = capture(t, () => assert.fail("unadmitted history image reached transport"));
  assert.equal((await executeChatTask(injected)).kind, "error");
  assert.deepEqual(bodies, []);
});

for (const primary of ["pixel-primary", "text-primary"]) {
  test(primary + " preserves long source attribution through the final privacy boundary", async t => {
    routes(primary);
    const uid = "123456789012345", messageId = "-123456789012345678";
    const input = request({ imageUrls: [assets[0]] });
    input.options.imageSources = [{ kind: "quote", userId: uid, messageId }];
    input.history = [{ role: "user", content: "[被回复消息]\nspeaker=source uid=" + uid +
      "\nsource=message_id=" + messageId + "\nmessage=phone=13800138000 token=synthetic-private-value" }];
    const { bodies } = capture(t, body => ({ content: body.model === "objective" ? caption : reply }));
    assert.equal((await executeChatTask(input)).kind, "reply");
    const body = bodies.find(item => item.model === primary);
    const content = body.messages.at(-1).content;
    const label = Array.isArray(content) ? content[0].text : content;
    assert.ok(label.includes("消息发送人 uid=" + uid));
    assert.ok(label.includes("message_id=" + messageId));
    assert.ok(body.messages.some(item => typeof item.content === "string" && item.content.includes("source=message_id=" + messageId)));
    assert.doesNotMatch(JSON.stringify(body), /13800138000|synthetic-private-value/);
  });
}

for (const [name, bytes] of [
  ["false raster MIME", Buffer.from("not a raster image")],
  ["source larger than 10 MiB", Buffer.alloc(VISION_IMAGE_LIMITS.maxSourceBytes + 1)],
]) {
  test(`${name} produces honest text evidence plus the exact current question`, async t => {
    const input = request({ imageUrls: [assets[0]] });
    const { bodies, downloads } = capture(t, () => ({ content: reply }), () => bytes);
    assert.equal((await executeChatTask(input)).kind, "reply");
    assert.deepEqual(downloads, [assets[0]]);
    assert.deepEqual(bodies.map(body => body.model), ["pixel-primary"]);
    const content = bodies[0].messages.at(-1).content;
    assert.equal(typeof content, "string");
    assert.match(content, /视觉识别失败|未能读取=1/);
    assert.ok(content.endsWith("\n\n" + currentInput));
    assert.equal(images(bodies[0]).length, 0);
  });
}

test("image assembly preserves native tool continuation and the shared four-round budget", async t => {
  assert.equal(CHAT_TOOL_LIMITS.modelRounds, 4);
  assert.equal(CHAT_TOOL_LIMITS.toolCalls, 4);
  assert.equal(CHAT_TOOL_LIMITS.durationMs, 90000);
  assert.equal(CHAT_TOOL_LIMITS.transportAttempts, 8);
  routes("pixel-primary", "pixel-fallback");
  const input = request();
  input.options.allowTools = true;
  const session = createChatToolSession({ scope, task: "group_chat", userMessage: input.userMsg, mentioned: true });
  input.options.toolSession = session;
  const { bodies, downloads } = capture(t, (body, calls) => {
    if (calls.length <= 2) return { content: null, reasoning_content: privateReasoning,
      tool_calls: [{ id: "assembly-calc-" + calls.length, type: "function", function: { name: "calculate", arguments: '{"expression":"21*2"}' } }] };
    return { content: calls.length === 3 ? "" : reply, reasoning_content: privateReasoning };
  });
  const result = await executeChatTask(input);
  assert.equal(result.position, "fallback");
  assert.equal(result.text, reply);
  assert.deepEqual(bodies.map(body => body.model), ["pixel-primary", "pixel-primary", "pixel-primary", "pixel-fallback"]);
  assert.deepEqual(downloads, assets);
  const initial = bodies[0].messages.at(-1);
  assert.deepEqual(initial.content.at(-1), { type: "text", text: currentInput });
  for (const body of bodies.slice(1, 3)) {
    assert.deepEqual(body.messages[3 + input.history.length], initial);
    const assistant = body.messages.filter(message => message.tool_calls).at(-1);
    const tool = body.messages.filter(message => message.role === "tool").at(-1);
    assert.equal(assistant.reasoning_content, privateReasoning);
    assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
    assert.equal(JSON.parse(tool.content).result, 42);
  }
  assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /ASSEMBLY_PRIMARY_PRIVATE_REASONING|assembly-calc-|reasoning_content|providerContinuation/);
  assert.deepEqual(bodies.at(-1).messages.at(-1), initial);
  assert.equal(session.snapshot().modelRounds, 4);
  assert.equal(session.snapshot().transportAttempts, 4);
  assert.equal(session.snapshot().toolCalls, 2);
  assert.equal(session.remainingModels(), 0);
  assert.equal((await executeChatTask(input)).kind, "error");
  assert.equal(bodies.length, 4, "fallback must not reset the shared budget");
  assert.doesNotMatch(JSON.stringify(result), /ASSEMBLY_PRIMARY_PRIVATE_REASONING/);
});
