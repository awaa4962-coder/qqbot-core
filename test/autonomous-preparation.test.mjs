import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-autonomous-preparation-"));
Object.assign(process.env, { NODE_ENV: "test", CI: "1", QQBOT_CONFIG_ROOT: path.join(root, "config"),
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp") });
const { createWriteServices } = await import("../bridge/chat-tools/write-services.mjs");
const { createMaterialServices } = await import("../bridge/chat-tools/material-services.mjs");
const { createAgentWriteCoordinator } = await import("../bridge/chat-tools/write-coordinator.mjs");
const { createPersonalChangeAdapter } = await import("../bridge/chat-tools/personal-changes.mjs");
const { createConfirmationStore } = await import("../bridge/chat-tools/confirmations.mjs");
const { createReminderService } = await import("../bridge/agent-reminders/service.mjs");
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { createDraftTaskService } = await import("../bridge/chat-tools/draft-tasks.mjs");
const { createBusinessDraftAdapter } = await import("../bridge/chat-tools/business-drafts.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { withChatRun, currentChatScope } = await import("../bridge/cognition/chat-run.mjs");
const { autonomousPreparationAllowed } = await import("../bridge/chat-tools/preparation-policy.mjs");
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

const scope = Object.freeze({ surface: "group", userId: "60160", groupId: "50160", currentMessageId: "70160" });
const names = service => service.definitions().map(tool => tool.function.name);
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const cfg = { dataRoot: directory, memoryFile: path.join(directory, "users.json"),
    memoryProfileFile: path.join(directory, "profiles.json"), chatLogFile: path.join(directory, "groups.json"),
    groupWhitelist: [50160], botBlacklist: [], agentGroupWhitelist: [50160], agentWriteGroupWhitelist: [50160],
    agentReminderGroupWhitelist: [50160], agentDraftGroupWhitelist: [50160],
    summaryGroupWhitelist: [50160], conversationSummaryGroupWhitelist: [50160], ...overrides };
  const state = { writes: 0, noteWrites: 0, deliveries: 0, at: 1791547200000 };
  const users = {}, profiles = {};
  const notes = createMemoryNoteService({ profiles, available: () => true, now: () => state.at,
    readPrivacy: () => ({ epoch: 0, users: {} }), persist: () => { state.noteWrites++; return true; } });
  const personal = createPersonalChangeAdapter({ users, saveUsers: () => { state.writes++; }, flushSavesSync: () => true,
    readPrivacy: () => ({ epoch: 0, users: {} }), memoryNotesSnapshot: own => notes.snapshot(own),
    applyMemoryNoteAction: (args, context) => notes.act(args, context) });
  const confirmationFile = path.join(directory, "confirmations.json");
  const confirmations = createConfirmationStore({ filename: confirmationFile, now: () => state.at });
  const reminders = createReminderService({ filename: path.join(directory, "reminders.json"), now: () => state.at,
    isPermitted: () => cfg.agentReminderGroupWhitelist.includes(50160), readPrivacyCutoff: () => 0,
    deliver: () => { state.deliveries++; assert.fail("preparation must never send"); } });
  const coordinator = createAgentWriteCoordinator({ cfg, personal, confirmations, reminders });
  const runtime = { scope, cfg, task: "group_chat", mentioned: true, userMessage: "最近比较喜欢清淡的绿茶。",
    messageId: "70160", autonomous: true, assertCurrent() {}, signal: new globalThis.AbortController().signal,
    remainingMs: () => 2000, callModel: () => assert.fail("no independent model transport") };
  t.after(() => coordinator.stop({ drainMs: 0 }));
  const options = { task: runtime.task, mentioned: runtime.mentioned, userMessage: runtime.userMessage,
    currentMessageId: runtime.messageId, writeCoordinator: coordinator };
  return { cfg, state, users, profiles, personal, notes, confirmations, reminders, coordinator, runtime, options, confirmationFile };
}
function serviceContext(f, autonomous = true) { return { ...f.runtime, autonomous }; }
function confirmationRuntime(f, ref, extra = {}) {
  return { ...f.runtime, scope: { surface: "group", userId: scope.userId, groupId: scope.groupId },
    messageId: "70161", userMessage: "确认 " + ref, actualUserCommand: "确认 " + ref, ...extra };
}

test("definitions use parent context only, with legacy and phase admission intact", t => {
  const f = fixture(t);
  for (const flag of [true, false, undefined, "true", 1]) {
    const context = serviceContext(f, flag);
    if (flag === undefined) delete context.autonomous;
    const writes = createWriteServices({ ...f.options, autonomous: true }, context);
    assert.equal(names(writes).includes("prepare_personal_change"), flag === true);
    assert.equal(names(writes).includes("prepare_reminder"), flag === true);
    const materials = createMaterialServices({ ...f.options, autonomous: true, draftTaskService: { initialReferences: () => [] } }, context);
    assert.equal(names(materials).includes("draft_chat_summary"), flag === true);
  }
  for (const override of [{ mentioned: false }, { task: "interjection" }, { allowTools: false }]) {
    const writes = createWriteServices({ ...f.options, ...override }, serviceContext(f));
    assert.deepEqual(names(writes), []);
    assert.equal(writes.writes.preparePersonal({ action: "set_name", value: "小茶" }).status, "denied");
    const materials = createMaterialServices({ ...f.options, ...override }, serviceContext(f));
    assert.equal(names(materials).includes("draft_chat_summary"), false);
  }
  f.cfg.autonomous = true; f.cfg.agentWriteGroupWhitelist = []; f.cfg.agentReminderGroupWhitelist = [];
  assert.deepEqual(names(createWriteServices(f.options, serviceContext(f))), []);
  const privateContext = { ...serviceContext(f), scope: { surface: "private", userId: scope.userId } };
  assert.deepEqual(names(createWriteServices(f.options, privateContext)), []);
});

test("ordinary semantics produce reworded personal proposals, not memory writes", async t => {
  const f = fixture(t), service = createWriteServices(f.options, serviceContext(f));
  const result = await service.writes.preparePersonal({ action: "memory_create", title: "饮品偏好", text: "我偏爱清淡的绿茶", ttlDays: 30 });
  assert.equal(result.status, "ok"); assert.equal(result.phase, "pending"); assert.equal(result.applied, false);
  assert.match(result.text, /待确认.*尚未保存或执行/);
  assert.equal(f.state.noteWrites, 0); assert.equal(f.state.writes, 0);
  assert.equal(f.notes.snapshot(scope).items.length, 0); assert.deepEqual(f.users, {});
  assert.equal(f.reminders.list(scope).items.length, 0); assert.equal(f.state.deliveries, 0);
  const second = await service.writes.preparePersonal({ action: "memory_create", title: "饮品偏好", text: "我偏爱清淡的绿茶", ttlDays: 30 });
  assert.equal(second.confirmation_ref, result.confirmation_ref);
  const ref = result.confirmation_ref;
  assert.equal((await f.coordinator.confirm(ref, { ...f.runtime, explicitUserConfirmation: true })).status, "denied");
  assert.equal((await f.coordinator.confirm(ref, confirmationRuntime(f, ref, { scope: { surface: "group", userId: "60161", groupId: scope.groupId } }))).status, "denied");
  assert.equal((await f.coordinator.confirm(ref, confirmationRuntime(f, ref, { scope: { surface: "group", userId: scope.userId, groupId: "50161" } }))).status, "denied");
  assert.equal((await f.coordinator.confirm(ref, confirmationRuntime(f, ref))).status, "applied");
  assert.equal(f.state.noteWrites, 1); assert.equal(f.notes.snapshot(scope).items[0].text, "我偏爱清淡的绿茶");
  await f.coordinator.confirm(ref, confirmationRuntime(f, ref));
  assert.equal(f.state.noteWrites, 1);
});

test("reminder proposals allow reformulation and become armed only after owner confirmation", async t => {
  const f = fixture(t); f.options.userMessage = "我一会儿还有场线上会议。";
  const service = createWriteServices(f.options, serviceContext(f));
  const result = await service.writes.prepareReminder({ action: "create", text: "准备参加线上会议", delay_minutes: 20 });
  assert.equal(result.status, "ok"); assert.equal(result.applied, false);
  assert.equal(f.reminders.list(scope).items.length, 0); assert.equal(f.state.deliveries, 0);
  assert.equal((await f.coordinator.confirm(result.confirmation_ref, confirmationRuntime(f, result.confirmation_ref))).status, "applied");
  assert.equal(f.reminders.list(scope).items[0].phase, "armed"); assert.equal(f.state.deliveries, 0);
});

test("legacy coordinator still requires canonical intent and matching reminder body/time", async t => {
  const f = fixture(t), runtime = { ...f.runtime, autonomous: false };
  assert.equal((await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, runtime)).status, "denied");
  assert.equal((await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 2 }, runtime)).status, "denied");
  assert.equal((await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, { ...runtime, userMessage: "叫我小茶" })).status, "ok");
  assert.equal((await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 3 }, { ...runtime, userMessage: "2分钟后提醒我喝茶" })).status, "denied");
});

test("autonomous cancellation proposals must target an existing reminder in the real owner scope", async t => {
  const f = fixture(t);
  const absent = "rem_" + "0".repeat(32);
  assert.equal((await f.coordinator.prepareReminder({ action: "cancel", ref: absent }, f.runtime)).status, "denied");
  const created = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 20 }, f.runtime);
  await f.coordinator.confirm(created.confirmation_ref, confirmationRuntime(f, created.confirmation_ref));
  const ref = f.reminders.list(scope).items[0].ref;
  assert.equal((await f.coordinator.prepareReminder({ action: "cancel", ref }, { ...f.runtime, scope: { ...scope, userId: "60161" } })).status, "denied");
  const proposal = await f.coordinator.prepareReminder({ action: "cancel", ref }, f.runtime);
  assert.equal(proposal.status, "ok"); assert.equal(f.reminders.list(scope).items[0].phase, "armed");
  await f.coordinator.confirm(proposal.confirmation_ref, confirmationRuntime(f, proposal.confirmation_ref));
  assert.equal(f.reminders.list(scope).items[0].phase, "cancelled"); assert.equal(f.state.deliveries, 0);
});

test("requesting cancellation of an existing reminder is distinct from vetoing preparation or execution", async t => {
  const f = fixture(t);
  const created = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 20 }, f.runtime);
  await f.coordinator.confirm(created.confirmation_ref, confirmationRuntime(f, created.confirmation_ref));
  const ref = f.reminders.list(scope).items[0].ref;
  const args = { action: "cancel", ref }, source = "取消我的提醒 " + ref;
  for (const userMessage of [source, "取消提醒 " + ref, "请帮我" + source, "@QQFriend " + source]) {
    assert.equal(autonomousPreparationAllowed(userMessage, "reminder", args), true);
  }
  for (const userMessage of ["不要" + source, source + "，不要执行", "只解释：" + source, "取消提醒草稿", "取消新提醒草稿", "取消", "停止"]) {
    assert.equal(autonomousPreparationAllowed(userMessage, "reminder", args), false, userMessage);
    assert.equal((await f.coordinator.prepareReminder(args, { ...f.runtime, userMessage })).status, "denied");
  }
  assert.equal((await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 2 }, { ...f.runtime, userMessage: source })).status, "denied");
  const wrong = { action: "cancel", ref: "rem_" + "0".repeat(32) };
  assert.equal((await f.coordinator.prepareReminder(wrong, { ...f.runtime, userMessage: source })).status, "denied");
  assert.equal((await f.coordinator.prepareReminder(args, { ...f.runtime, userMessage: source, scope: { ...scope, userId: "60161" } })).status, "denied");
  const service = createWriteServices({ ...f.options, userMessage: source }, serviceContext(f));
  const prepared = await service.writes.prepareReminder(args);
  assert.equal(prepared.status, "ok"); assert.equal(prepared.phase, "pending"); assert.equal(prepared.applied, false);
  assert.equal(f.reminders.list(scope).items[0].phase, "armed");
  assert.equal((await f.coordinator.confirm(prepared.confirmation_ref, { ...f.runtime, explicitUserConfirmation: true })).status, "denied");
  assert.equal((await f.coordinator.confirm(prepared.confirmation_ref, confirmationRuntime(f, prepared.confirmation_ref,
    { scope: { surface: "group", userId: "60161", groupId: scope.groupId } }))).status, "denied");
  assert.equal((await f.coordinator.confirm(prepared.confirmation_ref, confirmationRuntime(f, prepared.confirmation_ref))).status, "applied");
  assert.equal(f.reminders.list(scope).items[0].phase, "cancelled"); assert.equal(f.state.deliveries, 0);
});

test("existing-reminder cancellation never overrides quotation, veto or argument boundaries", async t => {
  const f = fixture(t);
  const created = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 20 }, f.runtime);
  assert.equal((await f.coordinator.confirm(created.confirmation_ref, confirmationRuntime(f, created.confirmation_ref))).status, "applied");
  const ref = f.reminders.list(scope).items[0].ref;
  const args = { action: "cancel", ref }, source = "取消我的提醒 " + ref;
  const ledger = fs.readFileSync(f.confirmationFile, "utf8");
  const reminderFile = path.join(path.dirname(f.confirmationFile), "reminders.json");
  const reminders = fs.readFileSync(reminderFile, "utf8");
  for (const userMessage of ["不需要" + source, "禁止执行：" + source, "仅解释：" + source,
    "只引用：" + source, '"' + source + '"', source + "，算了", source + "，不要准备新提醒",
    "不要准备新提醒", "取消新提醒草稿", "only explain: " + source,
    "不要取消我的提醒", "那个提醒先别撤", "算了不撤", "不\u200B要撤掉那个提醒", "不需要新提醒",
    "don't cancel my reminder", "do not remove that reminder", "never mind, cancel my reminder",
    "cancel the reminder draft", "stop preparing a new reminder"]) {
    const service = createWriteServices({ ...f.options, userMessage }, serviceContext(f));
    assert.equal(autonomousPreparationAllowed(userMessage, "reminder", args), false, userMessage);
    assert.equal((await service.writes.prepareReminder(args)).status, "denied", userMessage);
    assert.equal((await f.coordinator.prepareReminder(args, { ...f.runtime, userMessage })).status, "denied", userMessage);
  }
  for (const domain of ["personal", "draft"]) assert.equal(autonomousPreparationAllowed(source, domain, args), false);
  let reads = 0;
  for (const invalid of [{ action: "create", ref }, { action: "cancel", ref: "rem_" + "0".repeat(32) },
    { get action() { reads++; return "cancel"; }, ref }, { action: "cancel", get ref() { reads++; return ref; } }]) {
    assert.equal(autonomousPreparationAllowed(source, "reminder", invalid), false);
    assert.equal((await f.coordinator.prepareReminder(invalid, { ...f.runtime, userMessage: source })).status, "denied");
  }
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(f.confirmationFile, "utf8"), ledger);
  assert.equal(fs.readFileSync(reminderFile, "utf8"), reminders);
  assert.equal(f.state.deliveries, 0);
});

test("cancellation uses real owner/ref permissions even when both groups are authorized", async t => {
  const f = fixture(t, { groupWhitelist: [50160, 50161], agentGroupWhitelist: [50160, 50161],
    agentReminderGroupWhitelist: [50160, 50161] });
  const own = { surface: "group", userId: scope.userId, groupId: scope.groupId };
  const otherUser = { ...own, userId: "60161" }, otherGroup = { ...own, groupId: "50161" };
  const refs = [];
  for (const owner of [own, otherUser, otherGroup]) {
    const created = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 20 },
      { ...f.runtime, scope: owner });
    assert.equal(created.status, "ok");
    assert.equal((await f.coordinator.confirm(created.confirmation_ref,
      confirmationRuntime(f, created.confirmation_ref, { scope: owner }))).status, "applied");
    refs.push(f.reminders.list(owner).items[0].ref);
  }
  const [ref, userRef, groupRef] = refs;
  const source = "取消我的提醒 " + ref, args = { action: "cancel", ref };
  const ledger = fs.readFileSync(f.confirmationFile, "utf8");
  for (const foreignRef of [userRef, groupRef, "rem_" + "0".repeat(32)]) {
    const userMessage = "取消我的提醒 " + foreignRef;
    const service = createWriteServices({ ...f.options, userMessage }, serviceContext(f));
    assert.equal((await service.writes.prepareReminder({ action: "cancel", ref: foreignRef })).status, "denied");
  }
  for (const fields of [{ userId: otherUser.userId }, { groupId: otherGroup.groupId }]) {
    assert.equal((await f.coordinator.prepareReminder({ ...args, ...fields },
      { ...f.runtime, userMessage: source })).status, "invalid_arguments");
  }
  for (const owner of [otherUser, otherGroup]) {
    const context = { ...serviceContext(f), scope: owner };
    const service = createWriteServices({ ...f.options, userMessage: source }, context);
    assert.equal((await service.writes.prepareReminder(args)).status, "denied");
  }
  assert.equal(fs.readFileSync(f.confirmationFile, "utf8"), ledger);
  const service = createWriteServices({ ...f.options, userMessage: source }, serviceContext(f));
  const pending = await service.writes.prepareReminder(args);
  assert.equal(pending.status, "ok"); assert.equal(pending.phase, "pending"); assert.equal(pending.applied, false);
  assert.match(pending.text, /由本人另发/);
  assert.equal((await service.writes.prepareReminder(args)).confirmation_ref, pending.confirmation_ref);
  for (const owner of [otherUser, otherGroup]) {
    assert.equal((await f.coordinator.confirm(pending.confirmation_ref,
      confirmationRuntime(f, pending.confirmation_ref, { scope: owner }))).status, "denied");
  }
  f.cfg.agentReminderGroupWhitelist = [];
  assert.equal((await service.writes.prepareReminder(args)).status, "denied");
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref,
    confirmationRuntime(f, pending.confirmation_ref))).status, "denied");
  f.cfg.agentReminderGroupWhitelist = [50160, 50161];
  assert.equal(f.reminders.list(own).items[0].phase, "armed");
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref,
    confirmationRuntime(f, pending.confirmation_ref))).status, "applied");
  assert.equal(f.reminders.list(own).items[0].phase, "cancelled");
  for (const owner of [otherUser, otherGroup]) assert.equal(f.reminders.list(owner).items[0].phase, "armed");
  assert.equal(f.state.deliveries, 0);
});

test("natural cancellation wording prepares only an owned reminder and still needs owner confirmation", async t => {
  const f = fixture(t);
  const created = await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 20 }, f.runtime);
  assert.equal((await f.coordinator.confirm(created.confirmation_ref,
    confirmationRuntime(f, created.confirmation_ref))).status, "applied");
  const ref = f.reminders.list(scope).items[0].ref, args = { action: "cancel", ref };
  let pending;
  for (const userMessage of ["cancel my reminder", "Please cancel my reminder " + ref,
    "那个提醒先撤掉", "把刚才那个闹钟取消一下吧", "停止那个提醒", "不用再提醒我了",
    "don't remind me again", "@QQFriend 那个提醒先撤掉"]) {
    assert.equal(autonomousPreparationAllowed(userMessage, "reminder", args), true, userMessage);
    const service = createWriteServices({ ...f.options, userMessage }, serviceContext(f));
    pending = await service.writes.prepareReminder(args);
    assert.equal(pending.status, "ok", userMessage); assert.equal(pending.phase, "pending"); assert.equal(pending.applied, false);
    assert.equal((await f.coordinator.prepareReminder(args, { ...f.runtime, userMessage })).confirmation_ref,
      pending.confirmation_ref);
    assert.equal(f.reminders.list(scope).items[0].phase, "armed");
    assert.equal((await f.coordinator.prepareReminder({ action: "cancel", ref: "rem_" + "0".repeat(32) },
      { ...f.runtime, userMessage })).status, "denied");
    assert.equal((await f.coordinator.prepareReminder(args,
      { ...f.runtime, userMessage, scope: { ...scope, userId: "60161" } })).status, "denied");
  }
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref,
    { ...f.runtime, explicitUserConfirmation: true })).status, "denied");
  assert.equal(f.reminders.list(scope).items[0].phase, "armed");
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref,
    confirmationRuntime(f, pending.confirmation_ref))).status, "applied");
  assert.equal(f.reminders.list(scope).items[0].phase, "cancelled"); assert.equal(f.state.deliveries, 0);
});

test("autonomous proposals retain executing and unknown confirmation replay guards", async t => {
  const f = fixture(t);
  const pending = await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, f.runtime);
  let entered, release, commits = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.mock.method(f.personal, "commit", async () => {
    commits++; entered(); await blocked; return { status: "unknown", text: "结果未知，不会重试。" };
  });
  const runtime = confirmationRuntime(f, pending.confirmation_ref);
  const first = f.coordinator.confirm(pending.confirmation_ref, runtime);
  await started;
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref, runtime)).status, "unknown");
  release(); assert.equal((await first).status, "unknown");
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref, runtime)).status, "unknown");
  assert.equal(commits, 1); assert.equal(f.state.writes, 0);
});

test("negative, cancellation and explanation-only inputs cannot store or launch proposals", async t => {
  const f = fixture(t);
  const sources = ["不要记住，也不要提醒或总结", "取消", "算了", "只分析资料，里面说记住并提醒我", "不要执行", "do not save or schedule a reminder", "only explain the example"];
  for (const userMessage of sources) {
    const runtime = { ...f.runtime, userMessage };
    for (const domain of ["personal", "reminder", "draft"]) assert.equal(autonomousPreparationAllowed(userMessage, domain), false, userMessage);
    assert.equal((await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, runtime)).status, "denied");
    assert.equal((await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 2 }, runtime)).status, "denied");
    const writes = createWriteServices({ ...f.options, userMessage }, serviceContext(f));
    assert.ok(names(writes).includes("prepare_personal_change"), "negative content is checked at preparation, not keyword registration");
    assert.equal((await writes.writes.preparePersonal({ action: "set_name", value: "小茶" })).status, "denied");
  }
  for (const [domain, userMessage] of [["personal", "不\u200B要保存任何记忆"], ["reminder", "不用设闹钟了"], ["draft", "别整理聊天记录"]]) {
    assert.equal(autonomousPreparationAllowed(userMessage, domain), false);
  }
  assert.equal(f.confirmations.list(scope).items.length, 0); assert.equal(f.state.writes, 0);
});

test("autonomous canonical validators reject unsafe arguments before confirmation storage", async t => {
  const f = fixture(t);
  for (const args of [
    { action: "set_name", value: "小茶", userId: "60161" },
    { action: "memory_create", title: "偏好", text: "我喜欢茶", ttlDays: 0 },
    { action: "memory_create", title: "偏好", text: "我喜欢茶", ttlDays: 91 },
    { action: "memory_create", title: "api_key=syntheticsecret", text: "我喜欢茶" },
    { action: "memory_create", title: "偏好", text: "Authorization: Bearer syntheticsecret" },
    { action: "memory_update", noteId: "0123456789ab", text: "改写后的正文" },
  ]) assert.notEqual((await f.coordinator.preparePersonal(args, f.runtime)).status, "ok");
  for (const args of [
    { action: "create", text: "喝茶", delay_minutes: 0 },
    { action: "create", text: "喝茶", delay_minutes: 10081 },
    { action: "create", text: "喝茶", when: "2026-02-30T01:00:00Z" },
    { action: "create", text: "喝茶", when: new Date(f.state.at - 60000).toISOString() },
    { action: "create", text: "喝茶", delay_minutes: 1, groupId: "50161" },
    { action: "create", text: "password=syntheticsecret", delay_minutes: 1 },
    { action: "create", text: "ｐａｓｓｗｏｒｄ＝syntheticsecret", delay_minutes: 1 },
    { action: "create", text: "Ｂａｓｉｃ dXNlcjpwYXNz", delay_minutes: 1 },
  ]) assert.notEqual((await f.coordinator.prepareReminder(args, f.runtime)).status, "ok");
  let reads = 0;
  const args = { action: "create", delay_minutes: 2, get text() { reads++; return "喝茶"; } };
  assert.equal((await f.coordinator.prepareReminder(args, f.runtime)).status, "invalid_arguments");
  assert.equal(reads, 0); assert.equal(f.confirmations.list(scope).items.length, 0);
  assert.equal(fs.existsSync(f.confirmationFile), false);
});

test("scope, active phase, canonical message ID and supersession remain mandatory", async t => {
  const f = fixture(t);
  for (const override of [{ mentioned: false }, { task: "interjection" }, { messageId: "01" },
    { messageId: "70161" }, { messageId: "-0" }, { scope: { surface: "private", userId: scope.userId } },
    { scope: { ...scope, userId: "60161", groupId: "50161" } }, { signal: undefined }, { assertCurrent: () => false },
    { signal: globalThis.AbortSignal.abort() }]) {
    const runtime = { ...f.runtime, ...override };
    assert.equal((await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, runtime)).status, "denied");
    assert.equal((await f.coordinator.prepareReminder({ action: "create", text: "喝茶", delay_minutes: 2 }, runtime)).status, "denied");
  }
  assert.equal(f.confirmations.list(scope).items.length, 0);
});

test("autonomous update/remove target only notes in the real owner's current group", async t => {
  const f = fixture(t);
  const seed = (userId, groupId, title) => {
    const owned = { userId, groupId };
    const result = f.notes.act({ ...owned, action: "create", title, text: "合成资料", revision: f.notes.snapshot(owned).revision }, { origin: "user_command", messageId: "1" });
    assert.equal(result.ok, true); return f.notes.snapshot(owned).items[0].id;
  };
  const otherUser = seed("60161", scope.groupId, "他人条目");
  const otherGroup = seed(scope.userId, "50161", "其他群条目");
  const own = seed(scope.userId, scope.groupId, "本人条目");
  const writes = f.state.noteWrites;
  for (const noteId of [otherUser, otherGroup]) {
    assert.equal((await f.coordinator.preparePersonal({ action: "memory_remove", noteId }, f.runtime)).status, "denied");
    assert.equal((await f.coordinator.preparePersonal({ action: "memory_update", noteId, text: "新正文" }, f.runtime)).status, "denied");
  }
  assert.equal((await f.coordinator.preparePersonal({ action: "memory_update", noteId: own, text: "新正文" }, f.runtime)).status, "ok");
  assert.equal((await f.coordinator.preparePersonal({ action: "memory_remove", noteId: own }, f.runtime)).status, "ok");
  assert.equal(f.state.noteWrites, writes);
});

test("expiry, permission withdrawal and altered sealed parameters cannot execute", async t => {
  const f = fixture(t);
  const expired = await f.coordinator.preparePersonal({ action: "set_name", value: "小茶" }, f.runtime);
  f.state.at = expired.expiresAt;
  assert.equal((await f.coordinator.confirm(expired.confirmation_ref, confirmationRuntime(f, expired.confirmation_ref))).status, "expired");
  const pending = await f.coordinator.preparePersonal({ action: "set_name", value: "小绿" }, { ...f.runtime, messageId: "70162", scope: { ...scope, currentMessageId: "70162" } });
  f.cfg.agentWriteGroupWhitelist = [];
  assert.equal((await f.coordinator.confirm(pending.confirmation_ref, confirmationRuntime(f, pending.confirmation_ref))).status, "denied");
  f.cfg.agentWriteGroupWhitelist = [50160];
  const disk = JSON.parse(fs.readFileSync(f.confirmationFile, "utf8"));
  disk.rows.find(row => row.ref === pending.confirmation_ref).operation.parameters.value = "篡改";
  fs.writeFileSync(f.confirmationFile, JSON.stringify(disk));
  assert.notEqual((await f.coordinator.confirm(pending.confirmation_ref, confirmationRuntime(f, pending.confirmation_ref))).status, "applied");
  assert.equal(f.state.writes, 0);
});

test("autonomous drafts launch only owner-scoped tasks using the parent's model callback", async t => {
  const f = fixture(t); let models = 0;
  const service = createDraftTaskService({ cfg: f.cfg, createAdapter: runtime => ({ generate: async () => {
    await runtime.callModel("group_summary", "primary", { maxTokens: 128 });
    return { ok: true, text: "合成草稿", sent: false, persisted: false, coverage: { partial: true } };
  } }) });
  t.after(() => service.stop({ drainMs: 0 }));
  const runtime = { ...f.runtime, callModel: async () => { models++; return { ok: true }; } };
  const materials = createMaterialServices({ ...f.options, draftTaskService: service }, runtime);
  assert.ok(names(materials).includes("draft_chat_summary"));
  const result = await materials.drafts.generate({ kind: "daily", day: "today" }, runtime.signal);
  assert.equal(result.status, "ok"); assert.equal(result.sent, false); assert.equal(result.persisted, false); assert.equal(models, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.cfg.dataRoot, ".qqfriend/tasks/agent-drafts.json"), "utf8"), /合成草稿|60160|50160|70160/);
  assert.equal((await service.generate({ kind: "conversation", targets: "60161" }, runtime)).status, "denied");
  assert.equal((await service.generate({ kind: "daily", groupId: "50161" }, runtime)).status, "invalid_arguments");
  assert.equal((await service.generate({ kind: "daily", day: "../../secret" }, runtime)).status, "invalid_arguments");
  for (const override of [{ autonomous: false }, { userMessage: "不要总结" }, { messageId: "70161" }, { mentioned: false }, { task: "interjection" }]) {
    assert.equal((await service.generate({ kind: "daily" }, { ...runtime, ...override })).status, "denied");
  }
  assert.equal(models, 1);
});

test("parent session admits natural proposals and nested drafts while preserving active-phase and shared budget", async t => {
  const f = fixture(t, { toolAutonomyEnabled: true });
  let calls = 0, executed = false;
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: runtime => ({ generate: async () => {
    await runtime.callModel("group_summary", "primary", { systemPrompt: "synthetic summary system",
      messages: [{ role: "user", content: "synthetic source data" }], maxTokens: 128 });
    return { ok: true, text: "合成总结草稿", sent: false, persisted: false, coverage: { partial: true } };
  } }) });
  t.after(() => drafts.stop({ drainMs: 0 }));
  await withChatRun({ surface: scope.surface, groupId: scope.groupId, userId: scope.userId, messageId: "70170" }, async () => {
    executed = true;
    const options = { ...f.options, cfg: f.cfg, currentMessageId: currentChatScope().currentMessageId,
      draftTaskService: drafts, callNestedModel: async (_task, _position, request) => {
        calls++; request.validatePrepared(request); assert.equal(request.beforeAttempt(), "");
        assert.equal(request.toolChoice, "none"); return { ok: true, raw: "synthetic model result" };
      } };
    const session = createChatToolSession(options);
    const execute = async (name, args) => JSON.parse((await session.execute({ id: name, type: "function",
      function: { name, arguments: JSON.stringify(args) } }, session.definitions())).content);
    const prepared = await execute("prepare_personal_change", { action: "set_name", value: "小茶" });
    assert.equal(prepared.status, "ok"); assert.equal(prepared.phase, "pending"); assert.equal(f.state.writes, 0);
    const result = await execute("draft_chat_summary", { kind: "daily" });
    assert.equal(result.status, "ok"); assert.equal(result.persisted, false); assert.equal(result.sent, false);
    assert.equal(calls, 1); assert.equal(session.snapshot().modelRounds, 1); assert.equal(session.snapshot().transportAttempts, 1);
    const passive = createChatToolSession({ ...options, task: "interjection", mentioned: false });
    assert.ok(passive.definitions().every(entry => !["prepare_personal_change", "prepare_reminder", "draft_chat_summary"].includes(entry.function.name)));
  }, { cfg: f.cfg });
  assert.equal(executed, true);
});

test("natural multi-member conversation drafts use only this group and backend-bound explicit mentions", async t => {
  const f = fixture(t, { selfUin: "60199" });
  const selected = []; let models = 0;
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: runtime => createBusinessDraftAdapter({ ...runtime,
    summaryPrivacy: () => ({ epoch: 0, users: {} }),
    selectSummaryRecords: (groupId, targets, range) => {
      selected.push({ groupId, targets: targets.map(item => item.uid) });
      return { groupId, range, privacyEpoch: 0, targets: targets.map(item => ({ ...item, count: 1 })),
        transcript: [], selected: targets.length, background: 0, sampled: false, truncated: false };
    },
    generateConversationSummary: async (_bundle, settings) => {
      await settings.callProvider("conversation_summary", "primary", { systemPrompt: "synthetic system",
        messages: [{ role: "user", content: "synthetic evidence" }], maxTokens: 128 });
      return { ok: true, text: "合成多人成员草稿", provider: "synthetic", position: "primary" };
    },
  }) });
  t.after(() => drafts.stop({ drainMs: 0 }));
  const runtime = { ...f.runtime, now: () => f.state.at, mentionTargets: [{ uid: "60161" }, { qq: "60162" }],
    callModel: async () => { models++; return { ok: true }; } };
  const materials = createMaterialServices({ ...f.options, draftTaskService: drafts, mentionTargets: runtime.mentionTargets,
    wallNow: runtime.now }, runtime);
  for (const targets of ["60161,60162", "60160 60161 60162", "60161", " 60161, 60162 "]) {
    const result = await materials.drafts.generate({ kind: "conversation", targets }, runtime.signal);
    assert.equal(result.status, "ok"); assert.equal(result.sent, false); assert.equal(result.persisted, false);
  }
  const own = await drafts.generate({ kind: "conversation" }, runtime);
  assert.equal(own.status, "ok");
  assert.deepEqual(selected, [
    { groupId: scope.groupId, targets: ["60161", "60162"] },
    { groupId: scope.groupId, targets: ["60160", "60161", "60162"] },
    { groupId: scope.groupId, targets: ["60161"] },
    { groupId: scope.groupId, targets: ["60161", "60162"] },
    { groupId: scope.groupId, targets: [scope.userId] },
  ]);
  assert.equal(models, 5); assert.equal(f.state.writes, 0); assert.equal(f.state.deliveries, 0);
});

test("autonomous mention admission rejects arbitrary identities, all/bot mentions and model-supplied authority fields", async t => {
  const f = fixture(t, { selfUin: "60199" }); let starts = 0;
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: () => { starts++; assert.fail("invalid targets launched work"); } });
  t.after(() => drafts.stop({ drainMs: 0 }));
  const runtime = { ...f.runtime, mentionTargets: ["60161", { qq: "60162" }, { uid: "60163", isAll: true },
    { uid: "60164", isBot: true }, "60199", 60165, { userId: "60166" }, "all", "060167", "60168"] };
  for (const targets of ["60169", "60163", "60164", "60199", "60165", "60166", "all", "@60161", "060161", "+60161", "1234",
    "60161,60161", "60160 60161 60162 60168 60169", "60161;60162", "", "*"]) {
    assert.equal((await drafts.generate({ kind: "conversation", targets }, runtime)).status, "denied", targets);
  }
  for (const fields of [{ mentionTargets: ["60169"] }, { userId: "60169" }, { groupId: "50161" }, { scope: "all_groups" }]) {
    assert.equal((await drafts.generate({ kind: "conversation", targets: "60161", ...fields }, runtime)).status, "invalid_arguments");
  }
  assert.equal(starts, 0); assert.equal(drafts.snapshot().tasks.length, 0);
});

test("backend mention additions during admission cannot widen the initial authority", async t => {
  const f = fixture(t); let starts = 0;
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: () => { starts++; assert.fail("expanded target launched work"); } });
  t.after(() => drafts.stop({ drainMs: 0 }));
  const mentions = [{ uid: "60161" }];
  const runtime = { ...f.runtime, mentionTargets: mentions, assertCurrent: () => { mentions.push({ uid: "60162" }); } };
  assert.equal((await drafts.generate({ kind: "conversation", targets: "60162" }, runtime)).status, "denied");
  assert.equal(starts, 0);
});

test("queued conversation drafts retain immutable mention bounds and reject backend withdrawal or scope replacement", async t => {
  for (const change of [runtime => { runtime.mentionTargets = []; },
    runtime => { runtime.mentionTargets[0].uid = "60162"; },
    runtime => { runtime.mentionTargets[0].isAll = true; },
    runtime => { runtime.mentionTargets[0].isBot = true; },
    runtime => { runtime.scope = { ...scope, groupId: "50161" }; },
    runtime => { runtime.messageId = "70161"; }]) {
    const f = fixture(t); let entered, release, admitted;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: runtime => ({ generate: async () => {
      admitted = runtime.mentionTargets; entered(); await blocked; runtime.assertCurrent();
      return { ok: true, text: "不可见晚到结果", sent: false, persisted: false };
    } }) });
    t.after(() => drafts.stop({ drainMs: 0 }));
    const runtime = { ...f.runtime, mentionTargets: [{ uid: "60161" }] };
    const completion = drafts.generate({ kind: "conversation", targets: "60161" }, runtime);
    await started;
    assert.ok(Object.isFrozen(admitted)); assert.deepEqual(admitted, [scope.userId, "60161"]);
    change(runtime); release();
    assert.equal((await completion).status, "denied");
    assert.equal(drafts.snapshot().tasks[0].resultAvailable, false);
  }
});

test("conversation admission cannot replace the real scope even with both groups whitelisted", async t => {
  const f = fixture(t, { groupWhitelist: [50160, 50161], agentGroupWhitelist: [50160, 50161],
    agentDraftGroupWhitelist: [50160, 50161], conversationSummaryGroupWhitelist: [50160, 50161] });
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: () => assert.fail("scope replacement launched work") });
  t.after(() => drafts.stop({ drainMs: 0 }));
  const runtime = { ...f.runtime, mentionTargets: ["60161"], assertCurrent: () => {
    runtime.scope = { ...scope, groupId: "50161" };
  } };
  assert.equal((await drafts.generate({ kind: "conversation", targets: "60161" }, runtime)).status, "denied");
  assert.equal(drafts.snapshot().tasks.length, 0);
});

test("later backend additions do not appear in an already-admitted conversation runtime", async t => {
  const f = fixture(t); let entered, release, admitted;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const drafts = createDraftTaskService({ cfg: f.cfg, createAdapter: runtime => ({ generate: async () => {
    admitted = runtime.mentionTargets; entered(); await blocked; runtime.assertCurrent();
    return { ok: true, text: "仅原始范围草稿", sent: false, persisted: false };
  } }) });
  t.after(() => drafts.stop({ drainMs: 0 }));
  const runtime = { ...f.runtime, mentionTargets: ["60161"] };
  const completion = drafts.generate({ kind: "conversation", targets: "60161" }, runtime);
  await started; runtime.mentionTargets.push("60162"); release();
  assert.equal((await completion).status, "ok"); assert.deepEqual(admitted, [scope.userId, "60161"]);
});
