import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-delivery-contract-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");
const { aiReply } = await import("../bridge/reply-ai.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { dispatchGroupCommand } = await import("../bridge/commands/action-dispatcher.mjs");
const { getConversationThread, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");
const { chatDeliveryLedger, createChatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const UID = "60931", GROUP = "50931";
let nextId = 80931;
CFG.groupWhitelist = [Number(GROUP)]; CFG.friendWhitelist = [Number(UID)]; CFG.botBlacklist = [];
CFG.legacyProfileRefreshEnabled = false; CFG.stickerEnabled = false;
for (const id of ["delivery-contract", "deepseek"]) saveApiProvider({ id, model: id, presetId: "custom-openai-chat",
  endpoint: "https://example.com/" + id, auth: "none", enabled: true, capabilities: ["text"] }, { root });
saveApiRoutes(Object.fromEntries(["group_chat", "interjection", "private_chat", "file_chat"].map(task =>
  [task, { primary: "delivery-contract", fallback: "deepseek" }])), { root });

after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

async function verifyEntry(t, mode, receiptKind) {
  users[UID] = { uid: UID, nicknames: [], chats: [] }; groupChats[GROUP] = [];
  resetCognitionForTest();
  const id = nextId++;
  const privateMode = mode.startsWith("private");
  const scope = { surface: privateMode ? "private" : "group", userId: UID, groupId: privateMode ? undefined : GROUP, messageId: id };
  const incomplete = ["partial", "mixed"].includes(receiptKind);
  const body = incomplete ? "合成回复验收内容。".repeat(240) : "合成回复验收内容。";
  let calls = 0, sends = 0;
  t.mock.method(globalThis, "fetch", async (url, request) => {
    if (String(url).startsWith("https://example.com/")) {
      assert.equal(String(url), "https://example.com/delivery-contract", "outbound failures never retry generation");
      calls++;
      assert.ok(JSON.parse(request.body).messages.length);
      const content = mode === "interjection" ? JSON.stringify({ reply: body }) : body;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    assert.ok(String(url).endsWith(privateMode ? "/send_private_msg" : "/send_group_msg"));
    sends++;
    const accepted = { status: "ok", retcode: 0, data: { message_id: 90931 + sends } };
    const receipts = { sent: accepted, failed: { status: "failed", retcode: 100 }, unknown: {},
      contradictory: { status: "failed", retcode: 0 }, partial: sends === 1 ? accepted : { status: "failed", retcode: 100 },
      mixed: sends === 1 ? accepted : {} };
    return { ok: true, status: 200, json: async () => receipts[receiptKind] };
  });
  if (privateMode) {
    await handlePrivateMessage({ message_type: "private", user_id: UID, message_id: id, nickname: "Synthetic owner",
      text: "请说一句合成验收内容", images: [], files: mode === "private-file" ? [{ name: "synthetic.txt", url: "https://example.com/file" }] : [] },
    { fetchEvidence: async () => ({ status: "ok", text: "SYNTHETIC_FILE_ONLY" }) });
  } else {
    await aiReply(GROUP, UID, "请说一句合成验收内容", "Synthetic owner", [], id, "", mode !== "interjection", [], { messageId: id });
  }
  assert.equal(calls, 1);
  assert.equal(sends, receiptKind === "partial" ? 3 : receiptKind === "failed" || incomplete ? 2 : 1);
  const expected = ["unknown", "contradictory", "mixed"].includes(receiptKind) ? "unknown" : receiptKind;
  const current = chatDeliveryLedger().find(scope);
  assert.equal(current.status, expected);
  const restarted = createChatDeliveryLedger({ filename: path.join(CFG.dataRoot, ".qqfriend", "chat-delivery.json") });
  assert.equal(restarted.find(scope).status, expected);
  assert.equal(restarted.claim(scope).ok, false, "no result, including partial or unknown, authorizes automatic replay");
  const thread = getConversationThread(UID, privateMode ? "private" : GROUP);
  const assistant = (groupChats[GROUP] || []).filter(item => item.role === "assistant");
  if (receiptKind === "sent") {
    if (mode !== "interjection") assert.equal(thread.turns.at(-1).assistantSummary, body);
    else assert.equal(thread, null, "passive output does not create an active personal thread");
    assert.equal(assistant.length, privateMode ? 0 : 1);
    assert.equal(current.confirmed, 1);
  } else {
    assert.equal(thread, null); assert.equal(assistant.length, 0);
    assert.equal(current.confirmed, incomplete ? 1 : 0);
  }
  assert.doesNotMatch(JSON.stringify(users[UID].chats), /SYNTHETIC_FILE_ONLY|合成回复验收内容/);
  assert.doesNotMatch(fs.readFileSync(path.join(CFG.dataRoot, ".qqfriend", "chat-delivery.json"), "utf8"), /合成回复验收内容|SYNTHETIC_FILE_ONLY/);
}

for (const mode of ["group", "interjection", "private", "private-file"]) {
  for (const receipt of ["sent", "failed", "unknown", "contradictory"]) {
    test(`${mode}: ${receipt} receipt preserves only confirmed complete conversation evidence`, t => verifyEntry(t, mode, receipt));
  }
  if (mode !== "interjection") for (const receipt of ["partial", "mixed"]) {
    test(`${mode}: ${receipt} receipt persists without remembering the unsent full answer`, t => verifyEntry(t, mode, receipt));
  }
}

for (const mode of ["group", "private"]) for (const command of ["help", "version"]) {
  test(`${mode}: ${command} uses local content and never calls a model`, async t => {
    let sends = 0;
    t.mock.method(globalThis, "fetch", async url => {
      assert.ok(String(url).endsWith(mode === "group" ? "/send_group_msg" : "/send_private_msg"), "deterministic command must not call an API provider");
      sends++;
      return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 90960 + sends } }) };
    });
    const ctx = { message_type: mode, isAtMe: mode === "group", text: command, user_id: UID, group_id: mode === "group" ? GROUP : undefined,
      message_id: nextId++, files: [], images: [] };
    if (mode === "group") assert.equal(await dispatchGroupCommand(ctx), true);
    else await handlePrivateMessage(ctx);
    assert.ok(sends > 0);
  });
}

test("a confirmed reply to an excluded source keeps its receipt but cannot seed future conversational memory", async t => {
  users[UID] = { uid: UID, nicknames: [], chats: [] }; groupChats[GROUP] = [];
  resetCognitionForTest();
  const id = nextId++;
  let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).endsWith("/send_group_msg")); sends++;
    return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 90999 } }) };
  });
  await aiReply(GROUP, UID, "这个引用还能用吗", "Synthetic", [], id, "", true, [], {
    messageId: id, memorySourceExcluded: true,
    executeChatTask: async () => ({ kind: "reply", text: "这段来源已不可用，请补充当前问题。" }),
  });
  assert.equal(sends, 1);
  assert.equal(chatDeliveryLedger().find({ surface: "group", groupId: GROUP, userId: UID, messageId: id }).status, "sent");
  assert.equal(getConversationThread(UID, GROUP), null);
  assert.equal(groupChats[GROUP].at(-1).retracted, true);
});
