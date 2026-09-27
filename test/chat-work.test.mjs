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
import { chatRunStopReason, withChatRun } from "../bridge/cognition/chat-run.mjs";
import { logGroupMsg } from "../bridge/storage.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise) {
  return Promise.race([promise, delay(1500).then(() => { throw new Error("queue remained blocked"); })]);
}

function groupAtEvent(messageId, userId = 601101) {
  return { kind: "chat", post_type: "message", message_type: "group", group_id: CFG.groupWhitelist[0],
    user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户" },
    message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: "今天天气怎么样" } }],
    raw_message: `[CQ:at,qq=${CFG.selfUin}] 今天天气怎么样` };
}

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

test("real detached group reply records only a confirmed synthetic model answer", async t => {
  const scheduler = createChatWorkScheduler({ limits: { global: 2, group: 2, speaker: 2 } });
  const event = groupAtEvent(901107, 601107);
  let modelCalls = 0; let sends = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).includes("/send_group_msg")) {
      sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
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
    assert.equal(listMessageTraces({ messageId: String(event.message_id) }).items[0].status, "sent");
  } finally { await scheduler.stop({ drainMs: 1000 }); }
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
