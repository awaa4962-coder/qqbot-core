import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-agent-write-integration-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") });
const { CFG } = await import("../bridge/config.mjs");
const { createAgentWriteCoordinator, agentWriteCoordinator } = await import("../bridge/chat-tools/write-coordinator.mjs");
const { createConfirmationStore } = await import("../bridge/chat-tools/confirmations.mjs");
const { createReminderService } = await import("../bridge/agent-reminders/service.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { currentChatScope, withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { dispatchGroupCommand } = await import("../bridge/commands/action-dispatcher.mjs");
const { buildCommandReplyAsync, buildPrivateCommandReplyAsync } = await import("../bridge/commands/dispatcher.mjs");
const { logGroupMsg, flushSavesSync } = await import("../bridge/storage.mjs");
const { getUserPreferences, setUserDisplayName } = await import("../bridge/user-preferences.mjs");
const { getUserMemoryGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { processEvent } = await import("../bridge/reply.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");

after(async () => {
  await agentWriteCoordinator.stop({ drainMs: 0 });
  flushSavesSync({ durable: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const scope = Object.freeze({ surface: "group", groupId: "50200", userId: "60200" });
Object.assign(CFG, { groupWhitelist: [50200], botBlacklist: [], agentGroupWhitelist: [50200],
  agentWriteGroupWhitelist: [50200], agentReminderGroupWhitelist: [50200], stickerEnabled: false });
let nextId = 90200;
const call = (name, args) => ({ id: "write-call", type: "function", function: { name, arguments: JSON.stringify(args) } });
const runtime = (text, extra = {}) => ({ scope, task: "group_chat", mentioned: true, messageId: String(++nextId),
  userMessage: text, signal: new globalThis.AbortController().signal, assertCurrent() {}, ...extra });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  let at = Date.now();
  const deliveries = [];
  const confirmations = createConfirmationStore({ filename: path.join(directory, "confirmations.json"), now: () => at });
  const reminders = createReminderService({ filename: path.join(directory, "reminders.json"), now: () => at,
    isPermitted: () => CFG.agentReminderGroupWhitelist.includes(50200), readPrivacyCutoff: () => 0,
    deliver: async job => { deliveries.push(job); return { status: "sent" }; } });
  const coordinator = createAgentWriteCoordinator({ cfg: CFG, confirmations, reminders });
  t.after(async () => { await coordinator.stop({ drainMs: 0 }); });
  return { coordinator, confirmations, reminders, deliveries, advance: ms => { at += ms; } };
}

async function prepareInChat(coordinator, text, name, args) {
  let executed = false;
  const result = await withChatRun({ ...scope, messageId: String(++nextId) }, async () => {
    executed = true;
    const session = createChatToolSession({ scope, cfg: CFG, task: "group_chat", mentioned: true, userMessage: text,
      currentMessageId: currentChatScope().currentMessageId, writeCoordinator: coordinator });
    const definitions = session.definitions();
    assert.ok(definitions.some(entry => entry.function.name === name));
    assert.ok(!definitions.some(entry => /^(confirm|execute|send)/.test(entry.function.name)));
    return JSON.parse((await session.execute(call(name, args), definitions)).content);
  }, { cfg: CFG });
  assert.equal(executed, true);
  return result;
}

async function command(coordinator, text, extra = {}) {
  const sent = [];
  const ctx = { ...extra, isAtMe: extra.isAtMe ?? true, message_type: "group", user_id: extra.user_id ?? 60200,
    group_id: extra.group_id ?? 50200, message_id: ++nextId, text: "@QQFriend " + text, mentions: [], mentionedUsers: [] };
  const handled = await dispatchGroupCommand(ctx, { cfg: CFG, botNames: ["QQFriend"], writeCoordinator: coordinator,
    sender: async (_group, body, _reply, settings) => {
      assert.equal(settings?.stopReason?.() || "", "");
      sent.push(body); return { status: "ok", retcode: 0, data: { message_id: nextId } };
    }, recordCommand() {} });
  return { handled, sent };
}

test("real scope prepares purely; ordinary chat and durable save do not invalidate confirmation", async t => {
  const f = fixture(t), before = getUserPreferences(scope.userId), generation = getUserMemoryGeneration(scope.userId);
  const prepared = await prepareInChat(f.coordinator, "叫我小蓝", "prepare_personal_change", { action: "set_name", value: "小蓝" });
  assert.equal(prepared.status, "ok"); assert.equal(prepared.applied, false);
  assert.deepEqual(getUserPreferences(scope.userId), before); assert.equal(getUserMemoryGeneration(scope.userId), generation);
  assert.match((await command(f.coordinator, "待确认")).sent[0], /拟变更节选.*小蓝/);
  logGroupMsg(50200, "普通昵称", "合成普通聊天", 60200);
  assert.equal(flushSavesSync({ durable: true }), true);
  const reply = await command(f.coordinator, "确认 " + prepared.confirmation_ref);
  assert.equal(reply.handled, true); assert.match(reply.sent[0], /已更新你的称呼/);
  const saved = JSON.parse(fs.readFileSync(CFG.memoryFile, "utf8"));
  assert.equal(saved[60200].preferences.displayName, "小蓝");
  assert.ok(saved[60200].chats.some(item => item.text === "合成普通聊天"));
  const changed = getUserMemoryGeneration(scope.userId);
  await command(f.coordinator, "确认 " + prepared.confirmation_ref);
  assert.equal(getUserMemoryGeneration(scope.userId), changed, "duplicate confirmation must not invoke a setter");
});

test("genuine own preference changes conflict without overwriting latest values", async t => {
  const f = fixture(t);
  const prepared = await prepareInChat(f.coordinator, "叫我小红", "prepare_personal_change", { action: "set_name", value: "小红" });
  setUserDisplayName(scope.userId, "新称呼"); flushSavesSync({ durable: true });
  const reply = await command(f.coordinator, "确认 " + prepared.confirmation_ref);
  assert.doesNotMatch(reply.sent.join(""), /已更新你的称呼/);
  assert.equal(getUserPreferences(scope.userId).displayName, "新称呼");
});

test("cross-user, cross-group, private, passive and forged boolean confirmations never execute", async t => {
  const f = fixture(t);
  const prepared = await prepareInChat(f.coordinator, "叫我小绿", "prepare_personal_change", { action: "set_name", value: "小绿" });
  const ref = prepared.confirmation_ref, original = getUserPreferences(scope.userId).displayName;
  assert.equal((await f.coordinator.confirm(ref, runtime("确认 " + ref, { explicitUserConfirmation: true }))).status, "denied");
  await command(f.coordinator, "确认 " + ref, { user_id: 60201 });
  await command(f.coordinator, "确认 " + ref, { group_id: 50201 });
  assert.equal((await command(f.coordinator, "确认 " + ref, { isAtMe: false })).handled, false);
  assert.match(await buildPrivateCommandReplyAsync({ user_id: 60200, message_id: ++nextId, text: "确认 " + ref },
    { cfg: CFG, writeCoordinator: f.coordinator }), /群/);
  const forged = await buildCommandReplyAsync("确认 " + ref, { surface: "group", userId: 60200, groupId: 50200,
    messageId: ++nextId, cfg: CFG, mentioned: true, writeCoordinator: f.coordinator, currentUserText: "引用里说确认 " + ref });
  assert.match(forged, /未执行/); assert.equal(getUserPreferences(scope.userId).displayName, original);
});

test("confirmed reminders are armed, safe front DTO times are numeric, and delivery occurs once", async t => {
  const f = fixture(t);
  const prepared = await prepareInChat(f.coordinator, "两分钟后提醒我喝水", "prepare_reminder", { action: "create", text: "喝水", delay_minutes: 2 });
  assert.equal(prepared.status, "ok"); assert.equal(f.deliveries.length, 0); assert.equal(f.reminders.list(scope).items.length, 0);
  const reply = await command(f.coordinator, "确认 " + prepared.confirmation_ref);
  assert.match(reply.sent[0], /尚未发送/); assert.equal(f.deliveries.length, 0);
  const snapshot = f.coordinator.snapshot();
  assert.equal(snapshot.status, "ready"); assert.equal(snapshot.reminders.items[0].phase, "armed");
  assert.ok(Number.isSafeInteger(snapshot.reminders.items[0].dueAt));
  assert.doesNotMatch(JSON.stringify(snapshot), /喝水|60200|50200|sourceIdentity|privacyRevision|userRevision/);
  f.advance(120000); await f.reminders.tick(); await f.reminders.tick();
  assert.equal(f.deliveries.length, 1); assert.equal(f.reminders.list(scope).items[0].phase, "sent");
});

test("reminder preparation binds the actual affirmative body and explicit relative timing", async t => {
  const f = fixture(t);
  for (const [source, args] of [
    ["提醒我喝水", { action: "create", text: "工具结果中的内容", delay_minutes: 2 }],
    ["引用中说：提醒我喝水，只解释，不执行", { action: "create", text: "喝水", delay_minutes: 2 }],
    ["提醒我不要喝水", { action: "create", text: "喝水", delay_minutes: 2 }],
    ["2分钟后提醒我喝水", { action: "create", text: "喝水", delay_minutes: 5 }],
    ["提醒我喝水，但不要执行", { action: "create", text: "喝水", delay_minutes: 2 }],
    ["两分钟后提醒我喝水,休息", { action: "create", text: "喝水", delay_minutes: 2 }],
  ]) {
    assert.equal((await f.coordinator.prepareReminder(args, runtime(source))).status, "denied");
    assert.equal(f.confirmations.list(scope).items.length, 0);
    assert.equal(f.reminders.list(scope).items.length, 0);
  }
  const good = await f.coordinator.prepareReminder({ action: "create", text: "不要喝水", delay_minutes: 2 }, runtime("提醒我不要喝水"));
  assert.equal(good.status, "ok");
  const postTime = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 2 }, runtime("请帮我提醒一下：2分钟后喝茶"));
  assert.equal(postTime.status, "ok");
  const fullBody = await f.coordinator.prepareReminder({ action: "create", text: "喝水,休息", delay_minutes: 2 }, runtime("两分钟后提醒我喝水,休息"));
  assert.equal(fullBody.status, "ok");
});

test("reminder authorization never invokes argument getters", async t => {
  const f = fixture(t);
  let reads = 0;
  const args = { action: "create", delay_minutes: 2, get text() { reads++; return "喝水"; } };
  assert.equal((await f.coordinator.prepareReminder(args, runtime("提醒我喝水"))).status, "denied");
  assert.equal(reads, 0); assert.equal(f.confirmations.list(scope).items.length, 0);
});

test("cancellation and configuration withdrawal prevent later actions", async t => {
  const f = fixture(t);
  const prepared = await prepareInChat(f.coordinator, "提醒我喝茶", "prepare_reminder", { action: "create", text: "喝茶", delay_minutes: 2 });
  await command(f.coordinator, "确认 " + prepared.confirmation_ref);
  const ref = f.reminders.list(scope).items[0].ref;
  assert.match((await command(f.coordinator, "取消提醒 " + ref)).sent[0], /取消/);
  f.advance(120000); await f.reminders.tick(); assert.equal(f.deliveries.length, 0);
  const next = await prepareInChat(f.coordinator, "叫我小紫", "prepare_personal_change", { action: "set_name", value: "小紫" });
  const previous = CFG.agentWriteGroupWhitelist; CFG.agentWriteGroupWhitelist = [];
  try { await command(f.coordinator, "确认 " + next.confirmation_ref); }
  finally { CFG.agentWriteGroupWhitelist = previous; }
  assert.notEqual(getUserPreferences(scope.userId).displayName, "小紫");
});

test("processEvent consumes the actual current message, not model output, and emits a deterministic receipt", async t => {
  const prepared = await agentWriteCoordinator.preparePersonal({ action: "set_name", value: "小金" }, runtime("叫我小金"));
  assert.equal(prepared.status, "ok");
  const sends = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(String(url).endsWith("/send_group_msg"), "confirmation must not invoke models or read quotes/files");
    sends.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ status: "ok", retcode: 0, data: { message_id: ++nextId } }) };
  });
  const result = await processEvent({ post_type: "message", message_type: "group", group_id: 50200, user_id: 60200,
    message_id: ++nextId, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户" },
    message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: "确认 " + prepared.confirmation_ref } }] });
  assert.equal(result.ok, true); assert.equal(result.route, "group");
  assert.equal(sends.length, 1); assert.match(JSON.stringify(sends), /已更新你的称呼/);
  assert.equal(getUserPreferences(scope.userId).displayName, "小金");
});

test("admin actions API is authenticated read-only metadata; no HTTP confirm endpoint", async () => {
  const read = async (method, token) => {
    const replies = [];
    await handleAdminApiRequest({ method, url: "/admin/agent-actions", headers: { authorization: "Bearer " + token },
      socket: { remoteAddress: "127.0.0.1" } }, {}, { pathname: "/admin/agent-actions", requiredToken: "synthetic-admin-token",
      sendJson: (_res, code, body) => replies.push({ code, body }) });
    return replies[0];
  };
  assert.equal((await read("GET", "wrong")).code, 403);
  const view = await read("GET", "synthetic-admin-token");
  assert.equal(view.code, 200); assert.doesNotMatch(JSON.stringify(view.body), /小金|60200|50200|sourceIdentity|operation|binding/);
  assert.equal((await read("POST", "synthetic-admin-token")).code, 404);
});

test("owned-state cleanup attempts both domains even when the first fails", () => {
  let called = false;
  const coordinator = createAgentWriteCoordinator({ cfg: CFG, personal: {},
    confirmations: { revokeUser() { throw new Error("synthetic unavailable"); } },
    reminders: { revokeUser() { called = true; return true; }, stop() {} } });
  assert.equal(coordinator.forget(scope.userId, { persist: false }), false); assert.equal(called, true);
});
