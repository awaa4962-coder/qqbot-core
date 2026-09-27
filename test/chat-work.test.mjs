import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CFG } from "../bridge/config.mjs";
import { createChatWorkScheduler } from "../bridge/cognition/chat-work.mjs";
import { createTraceRecorder, listMessageTraces, traceStage, withMessageTrace } from "../bridge/diagnostics/message-trace.mjs";
import { createOneBotLinkManager } from "../bridge/onebot-link.mjs";
import { processEvent } from "../bridge/reply.mjs";
import { getPipelineStatus, resetPipelineStatusForTest } from "../bridge/pipeline-state.mjs";
import { inspectChatEvent } from "../bridge/cognition/delivery-ledger.mjs";
import { parseIncomingEvent } from "../bridge/reply-handlers.mjs";
import { chatRunStopReason, noteChatOutcome, withChatRun } from "../bridge/cognition/chat-run.mjs";
import { logGroupMsg } from "../bridge/storage.mjs";
import { invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";
import { sendMsg } from "../bridge/napcat.mjs";
import { getConversationThread } from "../bridge/cognition/index.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  return Promise.race([promise, delay(1500).then(() => { throw new Error("queue remained blocked"); })]);
}

function groupAtEvent(messageId, userId = 601101, content = "今天天气怎么样") {
  return { kind: "chat", post_type: "message", message_type: "group", group_id: CFG.groupWhitelist[0],
    user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户" },
    message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: content } }],
    raw_message: `[CQ:at,qq=${CFG.selfUin}] ${content}` };
}

function groupPassiveEvent(messageId, userId = 601109, content = `这段合成群聊说得挺有意思 ${messageId}`) {
  return { kind: "chat", post_type: "message", message_type: "group", group_id: CFG.groupWhitelist[0],
    user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成群友" },
    message: [{ type: "text", data: { text: content } }], raw_message: content };
}

const triggerInterjection = () => ({ ok: true, kind: "question", reason: "triggered", probability: 1 });

test("chat scheduler bounds global, group and speaker slots without queuing excess work", async () => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 1, speaker: 1 } });
  const hold = deferred();
  let entered = false;
  const first = scheduler.start({ groupId: 1, userId: 11 }, () => { entered = true; return hold.promise; });
  assert.equal(first.ok, true);
  assert.equal(entered, true, "current-turn context starts before the ingress queue is released");
  assert.equal(scheduler.status().active, 1);
  assert.equal(scheduler.start({ groupId: 1, userId: 12 }, () => assert.fail()).reason, "reply_capacity");
  const second = scheduler.start({ groupId: 2, userId: 22 }, () => hold.promise);
  assert.equal(second.ok, true);
  assert.equal(scheduler.start({ groupId: 3, userId: 33 }, () => assert.fail()).reason, "reply_capacity");
  assert.equal(await scheduler.stop({ drainMs: 15 }), false);
  assert.equal(scheduler.start({ groupId: 3, userId: 33 }, () => assert.fail()).reason, "bridge_stopping");
  hold.resolve(); await Promise.all([first.completion, second.completion]);
  assert.equal(scheduler.status().active, 0);
});

test("passive chat has a separate cap and cannot exhaust explicit mention slots", async () => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 3,
    passiveGlobal: 1, passiveGroup: 1 } });
  const hold = deferred();
  const passive = scheduler.start({ groupId: 1, userId: 11, kind: "interjection" }, () => hold.promise);
  assert.equal(passive.ok, true);
  assert.equal(scheduler.status().passiveActive, 1);
  assert.equal(scheduler.start({ groupId: 2, userId: 22, kind: "interjection" }, () => assert.fail()).reason, "reply_capacity");
  const mentioned = scheduler.start({ groupId: 1, userId: 11 }, () => hold.promise);
  assert.equal(mentioned.ok, true);
  hold.resolve(); await Promise.all([passive.completion, mentioned.completion]);
  await Promise.resolve();
  assert.equal(scheduler.status().passiveActive, 0);
  await scheduler.stop({ drainMs: 1000 });
});

test("preview work has a separate per-group cap and leaves explicit mention slots available", async () => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 3,
    previewGlobal: 1, previewGroup: 1 } });
  const hold = deferred();
  const preview = scheduler.start({ groupId: 1, userId: 11, kind: "preview" }, () => hold.promise);
  assert.equal(preview.ok, true);
  assert.equal(scheduler.start({ groupId: 1, userId: 12, kind: "preview" }, () => assert.fail()).reason, "reply_capacity");
  assert.equal(scheduler.start({ groupId: 2, userId: 22, kind: "preview" }, () => assert.fail()).reason, "reply_capacity");
  const mentioned = scheduler.start({ groupId: 1, userId: 11 }, () => hold.promise);
  assert.equal(mentioned.ok, true);
  hold.resolve(); await Promise.all([preview.completion, mentioned.completion]);
  await Promise.resolve();
  assert.equal(scheduler.status().previewActive, 0);
  await scheduler.stop({ drainMs: 1000 });
});

test("slow commands share a bounded category without exhausting explicit mention slots", async () => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 3,
    commandGlobal: 1, commandGroup: 1 } });
  const hold = deferred();
  const command = scheduler.start({ groupId: 1, userId: 11, kind: "command" }, () => hold.promise);
  assert.equal(command.ok, true);
  assert.equal(scheduler.start({ groupId: 1, userId: 12, kind: "command" }, () => assert.fail()).reason, "reply_capacity");
  assert.equal(scheduler.start({ groupId: 2, userId: 22, kind: "command" }, () => assert.fail()).reason, "reply_capacity");
  const mentioned = scheduler.start({ groupId: 1, userId: 11 }, () => hold.promise);
  assert.equal(mentioned.ok, true);
  hold.resolve(); await Promise.all([command.completion, mentioned.completion]);
  await Promise.resolve();
  assert.equal(scheduler.status().commandActive, 0);
  await scheduler.stop({ drainMs: 1000 });
});

test("passive model work releases same-group ingestion but keeps the trace pending", async () => {
  resetPipelineStatusForTest();
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupPassiveEvent(901109);
  let intake;
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      interjectionDecision: triggerInterjection,
      chatReply: async () => { started.resolve(); await hold.promise;
        traceStage("output", { status: "ok" }); traceStage("send", { status: "ok" }); } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(getPipelineStatus().counters.processed, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await intake.completion; await Promise.resolve();
    assert.equal(getPipelineStatus().counters.processed, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("passive capacity exhaustion is silent and makes no provider or QQ call", async t => {
  const event = groupPassiveEvent(901110, 601110);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network call"); });
  const scheduler = { start: () => ({ ok: false, reason: "reply_capacity" }) };
  const result = await processEvent(event, { detachChat: true, chatScheduler: scheduler,
    interjectionDecision: triggerInterjection });
  assert.equal(result.ok, true);
  assert.equal(result.pending, undefined);
  assert.equal(calls, 0);
  assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "cancelled");
});

test("real passive route completes only after its confirmed synthetic model send", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const event = groupPassiveEvent(901111, 601111);
  let modelCalls = 0; let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).includes("/send_group_msg")) {
      sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
    }
    modelCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"reply":"合成插话"}' } }] }) };
  });
  try {
    const accepted = await processEvent(event, { detachChat: true, chatScheduler: scheduler,
      interjectionDecision: triggerInterjection });
    assert.equal(accepted.pending, true);
    await accepted.completion;
    assert.equal(modelCalls, 1);
    assert.equal(sends, 1);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { await scheduler.stop({ drainMs: 1000 }); }
});

test("automatic link fetch releases group ingress but keeps one durable pending delivery", async t => {
  resetPipelineStatusForTest();
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 3 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupPassiveEvent(901112, 601112, "https://example.com/preview-901112");
  let sends = 0; let intake;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      previewOptions: { previewer: async () => { started.resolve(); await hold.promise;
        return { title: "合成页面", text: "网页：合成页面", description: "合成页面摘要" }; } } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    assert.equal(getPipelineStatus().counters.processed, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await intake.completion; await Promise.resolve();
    assert.equal(sends, 1);
    assert.equal(getPipelineStatus().counters.processed, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("a second same-group preview is skipped while the first fetch occupies its bounded slot", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 3,
    previewGlobal: 2, previewGroup: 1 } });
  const hold = deferred(); const started = deferred();
  const first = groupPassiveEvent(901113, 601113, "https://example.com/preview-901113");
  const second = groupPassiveEvent(901114, 601114, "https://example.com/preview-901114");
  let previewCalls = 0; let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const options = { detachChat: true, chatScheduler: scheduler,
    previewOptions: { previewer: async () => { previewCalls++; started.resolve(); await hold.promise;
      return { title: "合成页面", text: "网页：合成页面" }; } } };
  try {
    const pending = await processEvent(first, options);
    await bounded(started.promise);
    const skipped = await processEvent(second, options);
    assert.equal(pending.pending, true);
    assert.equal(skipped.pending, undefined);
    assert.equal(previewCalls, 1);
    assert.equal(sends, 0);
    hold.resolve(); await pending.completion;
    assert.equal(sends, 1);
    assert.equal(listMessageTraces({ messageId: String(second.message_id) }).items[0].status, "cancelled");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("group permission revocation during preview fetch prevents its eventual send", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const event = groupPassiveEvent(901115, 601115, "https://example.com/preview-901115");
  const originalWhitelist = CFG.groupWhitelist;
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("unexpected QQ send"); });
  try {
    const pending = await processEvent(event, { detachChat: true, chatScheduler: scheduler,
      previewOptions: { previewer: async () => { started.resolve(); await hold.promise;
        return { title: "合成页面", text: "网页：合成页面" }; } } });
    assert.equal(pending.pending, true);
    await bounded(started.promise);
    CFG.groupWhitelist = [];
    hold.resolve(); await pending.completion;
    assert.equal(sends, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "cancelled");
  } finally { CFG.groupWhitelist = originalWhitelist; hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("privacy invalidation during preview fetch prevents its eventual send", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const event = groupPassiveEvent(901120, 601120, "https://example.com/preview-901120");
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("unexpected QQ send"); });
  try {
    const pending = await processEvent(event, { detachChat: true, chatScheduler: scheduler,
      previewOptions: { previewer: async () => { started.resolve(); await hold.promise;
        return { title: "合成页面", text: "网页：合成页面" }; } } });
    assert.equal(pending.pending, true);
    await bounded(started.promise);
    invalidateMemoryPrivacyGeneration();
    hold.resolve(); await pending.completion;
    assert.equal(sends, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "cancelled");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("an uncertain link send does not dispatch a second mini-app preview", async () => {
  const event = groupPassiveEvent(901116, 601116, "https://example.com/preview-901116");
  event.message.push({ type: "json", data: { data: JSON.stringify({ app: "com.tencent.miniapp_01",
    meta: { detail_1: { title: "合成小程序", desc: "同一条消息" } } }) } });
  let sends = 0;
  const result = await processEvent(event, { previewOptions: {
    previewer: async () => ({ title: "合成页面", text: "网页：合成页面" }),
    sender: async () => { sends++; return { status: "ok", retcode: 1 }; },
  } });
  assert.equal(result.ok, true);
  assert.equal(sends, 1);
});

test("a mini-app preview uses the same detached receipt boundary", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const event = groupPassiveEvent(901117, 601117, "");
  event.message = [{ type: "json", data: { data: JSON.stringify({ app: "com.tencent.miniapp_01",
    meta: { detail_1: { title: "合成小程序", desc: "一条简介" } } }) } }];
  let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; started.resolve(); await hold.promise;
    return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  try {
    const pending = await processEvent(event, { detachChat: true, chatScheduler: scheduler });
    assert.equal(pending.pending, true);
    await bounded(started.promise);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await pending.completion;
    assert.equal(sends, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("explicit link-preview command releases the group queue during its fetch", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupAtEvent(901118, 601118, "预览 https://example.com/command-901118");
  let sends = 0; let intake;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      previewOptions: { previewer: async () => { started.resolve(); await hold.promise;
        return { title: "合成页面", text: "网页：合成页面" }; } } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    hold.resolve(); await intake.completion;
    assert.equal(sends, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("explicit preview capacity notice is durable and not sent twice on event replay", async t => {
  const event = groupAtEvent(901119, 601119, "预览 https://example.com/command-901119");
  let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const scheduler = { start: () => ({ ok: false, reason: "reply_capacity" }) };
  const options = { detachChat: true, chatScheduler: scheduler };
  assert.equal((await processEvent(event, options)).ok, true);
  assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
  assert.equal((await processEvent(event, options)).reason, "duplicate_event");
  assert.equal(sends, 1);
});

test("wordcloud rendering releases same-group ingress until its actual send", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 2 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupAtEvent(901123, 601123, "词云");
  let sends = 0; let intake;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      commandOptions: { featureGroupWhitelist: [event.group_id],
        chats: [{ group: String(event.group_id), role: "member", ts: Date.now(), text: "合成词云 合成词云" }],
        renderer: async () => { started.resolve(); await hold.promise; return null; } } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await intake.completion;
    assert.equal(sends, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("wordcloud render result is not sent after group permission is revoked", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const event = groupAtEvent(901127, 601127, "词云");
  const originalWhitelist = CFG.groupWhitelist;
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; throw new Error("unexpected QQ send"); });
  try {
    const pending = await processEvent(event, { detachChat: true, chatScheduler: scheduler,
      commandOptions: { featureGroupWhitelist: [event.group_id],
        chats: [{ group: String(event.group_id), role: "member", ts: Date.now(), text: "合成词云 合成词云" }],
        renderer: async () => { started.resolve(); await hold.promise; return null; } } });
    assert.equal(pending.pending, true);
    await bounded(started.promise);
    CFG.groupWhitelist = [];
    hold.resolve(); await pending.completion;
    assert.equal(sends, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "cancelled");
  } finally { CFG.groupWhitelist = originalWhitelist; hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("relationship short-comment generation releases same-group ingress", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 2 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupAtEvent(901124, 601124, "好感度");
  const now = Date.now();
  const user = { nicknames: ["合成用户"], firstSeen: new Date(now - 10 * 86400000).toISOString(),
    chats: ["上下文系统继续改", "自动回复日志看看"].map((text, index) => ({
      group: String(event.group_id), text, ts: now - index * 1000,
    })) };
  let sends = 0; let intake;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      commandOptions: { users: { [String(event.user_id)]: user }, groupChats: [], memoryContext: {},
        callMiMo: async () => { started.resolve(); await hold.promise; return "合成短评：有来有回。"; } } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await intake.completion;
    assert.equal(sends, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("preview capacity notice does not cancel an in-flight mention from the same speaker", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 2, previewGlobal: 0 } });
  const hold = deferred(); const started = deferred();
  const mentioned = groupAtEvent(901125, 601125);
  const preview = groupAtEvent(901126, 601125, "预览 https://example.com/preview-901126");
  let sends = 0; let mentionedSends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const chatReply = async (group, user, _text, _name, _images, replyTo, _quote, _at, _mentions, runtime) =>
    withChatRun({ surface: "group", groupId: group, userId: user, messageId: runtime.messageId,
      eventTime: runtime.eventTime, contextPrivacyGeneration: runtime.contextPrivacyGeneration }, async () => {
      started.resolve(); await hold.promise;
      if (chatRunStopReason()) return;
      traceStage("output", { status: "ok" });
      await sendMsg(group, "合成明确回复", replyTo);
      noteChatOutcome({ kind: "reply" });
      mentionedSends++;
    });
  try {
    const first = await processEvent(mentioned, { detachChat: true, chatScheduler: scheduler, chatReply });
    await bounded(started.promise);
    const second = await processEvent(preview, { detachChat: true, chatScheduler: scheduler });
    assert.equal(second.pending, undefined);
    assert.equal(sends, 1, "busy notice only");
    hold.resolve(); await first.completion;
    assert.equal(mentionedSends, 1);
    assert.equal(sends, 2);
    assert.equal(listMessageTraces({ messageId: String(mentioned.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("registered detached work keeps one trace open until its actual send settles", async () => {
  const recorder = createTraceRecorder();
  const hold = deferred();
  const result = await withMessageTrace({ message_type: "group", user_id: 601102, group_id: 2000000001, message_id: 901102, text: "synthetic" },
    () => ({ completion: hold.promise.then(() => traceStage("send", { status: "ok" })) }), recorder);
  assert.equal(recorder.list().items[0].status, "processing");
  hold.resolve(); await result.completion; await Promise.resolve();
  assert.equal(recorder.list().items[0].status, "sent");
  assert.equal(recorder.list().items[0].sends, 1);
});

test("a mentioned group chat releases OneBot ingestion while retaining completion accounting", async () => {
  resetPipelineStatusForTest();
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const event = groupAtEvent(901103);
  let intake;
  const link = createOneBotLinkManager({ processor: async value => {
    if (value.kind === "next") { nextMessage.resolve(); return; }
    intake = await processEvent(value, { detachChat: true, chatScheduler: scheduler,
      chatReply: async () => { started.resolve(); await hold.promise; traceStage("output", { status: "ok" }); traceStage("send", { status: "ok" }); } });
  } });
  try {
    assert.equal(link.enqueue(event), true);
    assert.equal(link.enqueue({ kind: "next", message_type: "group", group_id: event.group_id }), true);
    await bounded(started.promise);
    await bounded(nextMessage.promise);
    assert.equal(intake.pending, true);
    assert.equal(getPipelineStatus().counters.processed, 0);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "processing");
    hold.resolve(); await intake.completion; await Promise.resolve();
    assert.equal(getPipelineStatus().counters.processed, 1);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); await link.stop({ drainMs: 1000 }); }
});

test("capacity notice is recorded durably and duplicate admission cannot send it twice", async t => {
  resetPipelineStatusForTest();
  const event = groupAtEvent(901104, 601104);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const scheduler = { start: () => ({ ok: false, reason: "reply_capacity" }) };
  const first = await processEvent(event, { detachChat: true, chatScheduler: scheduler });
  assert.equal(first.ok, true);
  assert.equal(sends, 1);
  assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
  const repeat = await processEvent(event, { detachChat: true, chatScheduler: scheduler });
  assert.equal(repeat.reason, "duplicate_event");
  assert.equal(sends, 1);
});

test("a newer mention from the same speaker cancels the older detached reply", async () => {
  const scheduler = createChatWorkScheduler({ limits: { global: 4, group: 4, speaker: 2 } });
  const firstHold = deferred(); const firstStarted = deferred();
  const groupId = CFG.groupWhitelist[0];
  let oldSends = 0; let newSends = 0;
  const chatReply = async (group, user, _text, _name, _images, _replyTo, _quote, _at, _mentions, runtime) =>
    withChatRun({ surface: "group", groupId: group, userId: user, messageId: runtime.messageId,
      eventTime: runtime.eventTime, contextPrivacyGeneration: runtime.contextPrivacyGeneration }, async () => {
      if (runtime.messageId === 901105) { firstStarted.resolve(); await firstHold.promise; }
      if (chatRunStopReason()) return;
      if (runtime.messageId === 901105) oldSends++;
      else newSends++;
      traceStage("send", { status: "ok" });
    });
  try {
    const first = await processEvent(groupAtEvent(901105, 601105), { detachChat: true, chatScheduler: scheduler, chatReply });
    assert.equal(first.pending, true);
    await bounded(firstStarted.promise);
    const second = await processEvent(groupAtEvent(901106, 601105), { detachChat: true, chatScheduler: scheduler, chatReply });
    assert.equal(second.pending, true);
    await second.completion;
    firstHold.resolve(); await first.completion;
    assert.equal(oldSends, 0);
    assert.equal(newSends, 1);
    assert.equal(listMessageTraces({ messageId: "901105", groupId: String(groupId) }).items[0].status, "cancelled");
  } finally { firstHold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("a same-speaker preview cannot supersede an in-flight explicit mention reply", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const mentioned = groupAtEvent(901121, 601121);
  const preview = groupPassiveEvent(901122, 601121, "https://example.com/preview-901122");
  let sends = 0; let mentionedSends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(String(url).includes("/send_group_msg"));
    sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const chatReply = async (group, user, _text, _name, _images, replyTo, _quote, _at, _mentions, runtime) =>
    withChatRun({ surface: "group", groupId: group, userId: user, messageId: runtime.messageId,
      eventTime: runtime.eventTime, contextPrivacyGeneration: runtime.contextPrivacyGeneration }, async () => {
      started.resolve(); await hold.promise;
      if (chatRunStopReason()) return;
      traceStage("output", { status: "ok" });
      await sendMsg(group, "合成明确回复", replyTo);
      noteChatOutcome({ kind: "reply" });
      mentionedSends++;
    });
  try {
    const first = await processEvent(mentioned, { detachChat: true, chatScheduler: scheduler, chatReply });
    await bounded(started.promise);
    const second = await processEvent(preview, { detachChat: true, chatScheduler: scheduler,
      previewOptions: { previewer: async () => ({ title: "合成页面", text: "网页：合成页面" }) } });
    assert.equal(second.pending, true);
    await second.completion;
    hold.resolve(); await first.completion;
    assert.equal(mentionedSends, 1);
    assert.equal(sends, 2);
    assert.equal(listMessageTraces({ messageId: String(mentioned.message_id) }).items[0].status, "sent");
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("real detached group reply records only a confirmed synthetic model answer", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const event = groupAtEvent(901107, 601107);
  let modelCalls = 0; let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).includes("/send_group_msg")) {
      sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 1901107 } }) };
    }
    modelCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "合成答复" } }] }) };
  });
  try {
    const accepted = await processEvent(event, { detachChat: true, chatScheduler: scheduler });
    assert.equal(accepted.pending, true);
    await accepted.completion;
    assert.equal(modelCalls, 1);
    assert.equal(sends, 1);
    assert.equal(inspectChatEvent(parseIncomingEvent(event)), "reply_duplicate");
    assert.deepEqual(getConversationThread(event.user_id, event.group_id)?.turns.at(-1).assistantMessageIds, ["1901107"]);
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { await scheduler.stop({ drainMs: 1000 }); }
});

test("a superseded real group model result cannot send or create an old topic branch", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 3, group: 3, speaker: 2 } });
  const oldHold = deferred(); const oldStarted = deferred();
  const first = groupAtEvent(901128, 601128, "JM 压缩包怎么解压");
  const second = groupAtEvent(901129, 601128, "日报为什么没生成");
  let modelCalls = 0; let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).includes("/send_group_msg")) {
      sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0,
        data: { message_id: 1901129 } }) };
    }
    modelCalls++;
    if (modelCalls === 1) {
      oldStarted.resolve(); await oldHold.promise;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "旧 JM 回答" } }] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "日报定时任务回答" } }] }) };
  });
  try {
    const old = await processEvent(first, { detachChat: true, chatScheduler: scheduler });
    await bounded(oldStarted.promise);
    const current = await processEvent(second, { detachChat: true, chatScheduler: scheduler });
    assert.equal(old.pending, true);
    assert.equal(current.pending, true);
    await current.completion;
    oldHold.resolve(); await old.completion;
    assert.equal(modelCalls, 2);
    assert.equal(sends, 1);
    const thread = getConversationThread(second.user_id, second.group_id);
    assert.deepEqual(thread.turns.map(turn => turn.messageId), [String(second.message_id)]);
    assert.equal(thread.turns[0].assistantSummary, "日报定时任务回答");
    assert.equal(thread.turns[0].assistantMessageIds[0], "1901129");
    assert.equal(listMessageTraces({ messageId: String(first.message_id) }).items[0].status, "cancelled");
  } finally { oldHold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});

test("a later group message is not added to an already dispatched model request", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const hold = deferred(); const started = deferred();
  const event = groupAtEvent(901108, 601108);
  const laterText = "SYNTHETIC_FUTURE_CONTEXT_MARKER_901108";
  let modelBody = "";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("/send_group_msg")) return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
    modelBody = String(options.body || ""); started.resolve(); await hold.promise;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "合成答复" } }] }) };
  });
  try {
    const accepted = await processEvent(event, { detachChat: true, chatScheduler: scheduler });
    await bounded(started.promise);
    logGroupMsg(event.group_id, "后来的群友", laterText, 601109, "member", null, { messageId: 901109 });
    assert.equal(modelBody.includes(laterText), false);
    hold.resolve(); await accepted.completion;
  } finally { hold.resolve(); await scheduler.stop({ drainMs: 1000 }); }
});
