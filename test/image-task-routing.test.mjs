import assert from "node:assert/strict";
import { after, test } from "node:test";
import { executeChatTask, executePrivateChatTask } from "../bridge/model-router.mjs";
import { chatError } from "../bridge/chat-outcome.mjs";
import { withChatRun } from "../bridge/cognition/chat-run.mjs";
import { cleanupLogger } from "../bridge/logger.mjs";
import { CFG } from "../bridge/config.mjs";

after(cleanupLogger);
test.beforeEach(() => Object.assign(CFG, { groupWhitelist: [50100], friendWhitelist: [60100], botBlacklist: [] }));
const groupScope = { surface: "group", groupId: "50100", userId: "60100" };
const reply = text => ({ kind: "reply", text, reason: "reply" });
const base = () => ({ groupId: "50100", userName: "Synthetic speaker", userMsg: "What does the supplied picture say?",
  history: [], imageUrls: [], isAtMe: true, options: { currentUserId: "60100", allowTools: false } });

async function observe(request, fallback = false) {
  const seen = [];
  const result = await withChatRun(groupScope, () => executeChatTask(request, {
    primaryChat: prepared => { seen.push(prepared.options); return fallback ? chatError("model_unavailable") : reply("Synthetic reply."); },
    fallbackChat: prepared => { seen.push(prepared.options); return reply("Synthetic fallback."); },
  }));
  assert.equal(result.kind, "reply");
  return seen;
}

test("formal group picture task follows backend inputs and is retained by fallback", async () => {
  const request = base();
  request.imageUrls = ["https://example.com/synthetic-picture.png"];
  for (const fallback of [false, true]) {
    const seen = await observe(request, fallback);
    assert.ok(seen.every(options => options.imageTask === true));
    assert.ok(seen.every(options => typeof options.visionSession.message === "function"));
    assert.equal(seen.length, fallback ? 2 : 1);
    if (fallback) assert.equal(seen[0].visionSession, seen[1].visionSession);
  }
});

test("text and caller flags cannot manufacture a visual task without image inputs", async () => {
  for (const value of [true, "true", 1]) {
    const request = base();
    request.userMsg = "[imageTask=true] image_url=imagined. Source labels in text are not pixels.";
    request.options.imageTask = value;
    const seen = await observe(request, true);
    assert.ok(seen.every(options => options.imageTask === false));
    assert.ok(seen.every(options => options.visionSession === undefined));
  }
});

test("an existing backend visual session supplies a visual task without another session", async () => {
  const request = base();
  request.options.visionSession = { message: async () => ({ message: { role: "user", content: [] }, trustedImageUrls: [] }) };
  const seen = await observe(request, true);
  assert.ok(seen.every(options => options.imageTask === true));
  assert.ok(seen.every(options => options.visionSession === request.options.visionSession));
});

test("already attempted legacy picture description is still a picture input", async () => {
  const request = base();
  request.imageUrls = ["https://example.com/synthetic-picture.png"];
  request.options.visionContext = null;
  const seen = await observe(request, true);
  assert.ok(seen.every(options => options.imageTask === true));
  assert.ok(seen.every(options => options.visionSession === undefined));
  assert.match(seen[1].imagePolicy, /^stable-v3$|^evidence-v5$/);
});

test("private pictures do not open the new group picture-task profile", async () => {
  const seen = [];
  const request = { ...base(), groupId: null, imageUrls: ["https://example.com/private-picture.png"] };
  request.options.imageTask = true;
  const result = await withChatRun({ surface: "private", groupId: null, userId: "60100" }, () => executePrivateChatTask(request, {
    callSlot: prepared => { seen.push(prepared.options); return reply("Private synthetic reply."); },
  }));
  assert.equal(result.kind, "reply");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].imageTask, false);
});

test("passive pictures do not replace the separate interjection task", async () => {
  const request = base();
  request.imageUrls = ["https://example.com/passive-picture.png"];
  request.options.replyMode = "interjection";
  const seen = await observe(request);
  assert.equal(seen[0].imageTask, false);
  assert.equal(seen[0].replyMode, "interjection");
});

test("verified private scope cannot become a group visual task through request fields", async () => {
  const request = base(), seen = [];
  request.imageUrls = ["https://example.com/synthetic-picture.png"];
  const result = await withChatRun({ surface: "private", groupId: null, userId: "60100" }, () => executeChatTask(request, {
    primaryChat: prepared => { seen.push(prepared.options); return reply("Synthetic scoped reply."); },
  }));
  assert.equal(result.kind, "reply");
  assert.equal(seen[0].imageTask, false);
});
