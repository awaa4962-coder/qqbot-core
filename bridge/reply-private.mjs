// bridge/reply-private.mjs - private message command and AI handling.
import { log } from "./logger.mjs";
import { getUser, users, groupChats } from "./storage.mjs";
import { sendPrivateMsg } from "./napcat.mjs";
import { executePrivateChatTask, MODEL_TASKS } from "./model-router.mjs";
import { buildPrivateCommandReplyAsync, isAdminUser } from "./admin-commands.mjs";
import { buildReplyContextPacket } from "./context/index.mjs";
import { prepareAttachmentEvidence } from "./context/attachments.mjs";
import { handlePrivateJmTransferCommand } from "./jm-provider.mjs";
import { getPreferredDisplayName } from "./user-preferences.mjs";
import { isSuccessfulOutbound, recordConversationTurn } from "./cognition/index.mjs";
import { maybeSendStickerAfterReply } from "./features/stickers/index.mjs";
import { traceStage } from "./diagnostics/message-trace.mjs";
import { canUsePrivateChat } from "./commands/permissions.mjs";
import { MODEL_FAILURE_NOTICE } from "./chat-outcome.mjs";
import { assertChatRunCurrent, chatRunSignal, chatRunStopReason, withChatRun } from "./cognition/chat-run.mjs";
import { getMemoryPrivacyGeneration } from "./memory-profile/generation.mjs";
import { createMemoryCommandGuard, isSelfMemoryCommand } from "./commands/modules/memory.mjs";
import { normalizeCommand } from "./commands/normalize.mjs";

export async function handlePrivateMessage(ctx, runtime = {}) {
  ctx.contextPrivacyGeneration ??= getMemoryPrivacyGeneration();
  if (await handlePrivateJmTransferCommand(ctx)) {
    traceStage("route", { status: "ok", route: "jm" });
    return;
  }
  if (isAdminUser(ctx.user_id) && await trySendPrivateCommand(ctx)) return;

  if (!canUsePrivateChat(ctx.user_id)) {
    traceStage("route", { status: "skipped", reason: "private_not_whitelisted" });
    log("private msg from non-whitelist:", ctx.user_id);
    return;
  }

  if (await trySendPrivateCommand(ctx)) return;
  if (ctx.files.length) {
    await withChatRun(privateRunScope(ctx), () => handlePrivateFileMessage(ctx, runtime));
    return;
  }

  if (ctx.text || ctx.images.length) await withChatRun(privateRunScope(ctx), () => handlePrivateChatMessage(ctx));
}

function privateRunScope(ctx) {
  return { surface: "private", userId: ctx.user_id, messageId: ctx.message_id, eventTime: ctx.eventTime, contextPrivacyGeneration: ctx.contextPrivacyGeneration };
}

export async function privateReply(userId, text) {
  return await withChatRun({ surface: "private", userId }, () => runPrivateReply(userId, text));
}

async function runPrivateReply(userId, text) {
  const uid = Number(userId);
  if (!canUsePrivateChat(uid)) {
    log("privateReply: user not in whitelist:", uid);
    return;
  }
  const context = buildPrivateReplyContext({ user_id: uid, nickname: "朋友" }, text);
  const outcome = await executePrivateChatTask({
    userMsg: text,
    userName: context.userName,
    history: context.history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: uid, currentInput: context.currentInput },
  });
  const reply = await privateReplyText(uid, outcome);
  if (reply) {
    const result = await sendPrivateMsg(uid, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn({ user_id: uid, message_id: null, memorySources: context.memorySources }, text, reply, outcome);
      log("privateReply sent to", uid);
      await maybeSendPrivateSticker(uid, text, reply, context.history);
    }
  }
}

export async function tryDeepSeekFriend(userId, userMsg) {
  const uid = Number(userId);
  const context = buildPrivateReplyContext({ user_id: uid, nickname: "朋友" }, userMsg);
  const { text: reply } = await executePrivateChatTask({
    userMsg,
    userName: context.userName,
    history: context.history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: uid, currentInput: context.currentInput },
  });
  return reply || MODEL_FAILURE_NOTICE;
}

async function handlePrivateFileMessage(ctx, runtime = {}) {
  traceStage("route", { status: "ok", route: "private_file" });
  const question = String(ctx.text || "");
  assertChatRunCurrent();
  const attachmentEvidence = await prepareAttachmentEvidence(ctx.files, { signal: chatRunSignal(), fetchEvidence: runtime.fetchEvidence });
  assertChatRunCurrent();
  const { history, userName, currentInput, attachmentCoverage } = buildPrivateReplyContext(ctx, question, {
    mode: "private-file", attachmentEvidence,
  });
  if (!validAttachmentCoverage(attachmentCoverage, attachmentEvidence)) throw new Error("attachment_coverage_unavailable");
  const coverage = attachmentCoverage;
  const outcome = await (runtime.executeChatTask || executePrivateChatTask)({
    task: MODEL_TASKS.FILE_CHAT,
    imageUrls: ctx.images,
    userMsg: question,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id, currentInput },
  });
  assertChatRunCurrent();
  const reply = await privateReplyText(ctx.user_id, outcome);
  assertChatRunCurrent();
  if (reply) {
    const sentText = withAttachmentNotice(reply, coverage);
    const result = await (runtime.sendPrivateMsg || sendPrivateMsg)(ctx.user_id, sentText);
    assertChatRunCurrent();
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, question + " [附件共" + coverage.total + "份，已提供" + coverage.included + "份]", sentText, outcome);
      log("private file reply sent to", ctx.user_id);
    }
  }
}

function validAttachmentCoverage(value, evidence) {
  if (!value || ![value.total, value.attempted, value.included, value.omitted, value.unreadable]
    .every(count => Number.isSafeInteger(count) && count >= 0)) return false;
  return value.total === evidence.total && value.attempted === evidence.attempted &&
    value.unreadable === evidence.unreadable &&
    value.included + value.omitted + value.unreadable === value.total;
}

function withAttachmentNotice(reply, coverage) {
  const missing = Math.max(0, coverage.total - coverage.included);
  if (!missing) return reply;
  const note = "\n\n[附件说明] 本轮共" + coverage.total + "份附件，已提供" + coverage.included + "份；另有" + missing + "份未读取或未提供。";
  if (note.length > 160) throw new Error("attachment_notice_limit");
  return note.trimStart() + "\n\n" + reply;
}

async function handlePrivateChatMessage(ctx) {
  traceStage("route", { status: "ok", route: "private_chat" });
  const fullMsg = ctx.text + (ctx.images.length ? " [图片" + ctx.images.length + "张]" : "");
  const { history, userName, currentInput } = buildPrivateReplyContext(ctx, fullMsg);
  const outcome = await executePrivateChatTask({
    imageUrls: ctx.images,
    userMsg: fullMsg,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id, currentInput },
  });
  const reply = await privateReplyText(ctx.user_id, outcome);
  if (reply) {
    const result = await sendPrivateMsg(ctx.user_id, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, fullMsg, reply, outcome);
      log("private reply sent to", ctx.user_id);
      await maybeSendPrivateSticker(ctx.user_id, fullMsg, reply, history);
    }
  }
}

async function privateReplyText(userId, outcome) {
  if (outcome.kind === "error") await sendPrivateMsg(userId, MODEL_FAILURE_NOTICE);
  return outcome.kind === "reply" ? outcome.text : null;
}

function buildPrivateReplyContext(ctx, userMsg, options = {}) {
  const uid = String(ctx.user_id);
  getUser(uid, ctx.nickname);
  const userName = getPreferredDisplayName(uid, ctx.nickname);
  const contextPacket = buildReplyContextPacket({
    uid,
    groupId: "private",
    userName,
    userMsg,
    mode: options.mode || "private",
    currentMessageId: ctx.message_id,
    ...(options.attachmentEvidence ? { attachmentEvidence: options.attachmentEvidence } : {}),
  });
  ctx.memorySources = contextPacket.memorySources;
  ctx.attachmentCoverage = contextPacket.attachmentCoverage;
  return { history: contextPacket.messages, userName, currentInput: contextPacket.currentInput,
    memorySources: ctx.memorySources, attachmentCoverage: ctx.attachmentCoverage };
}

function recordPrivateTurn(ctx, userText, assistantText, outcome = {}) {
  if (chatRunStopReason()) return;
  recordConversationTurn({
    uid: ctx.user_id,
    groupId: "private",
    messageId: ctx.message_id,
    userText,
    assistantText,
    outcome: "sent",
    memorySources: [...(ctx.memorySources || []), ...(outcome.memorySources || [])],
  });
}

async function trySendPrivateCommand(ctx) {
  const memoryGuard = isSelfMemoryCommand(normalizeCommand(ctx.text)) ? createMemoryCommandGuard({ userId: ctx.user_id,
    surface: "private", contextPrivacyGeneration: ctx.contextPrivacyGeneration }) : null;
  const reply = await buildPrivateCommandReplyAsync(ctx, { users, groupChats, memoryGuard });
  if (!reply) return false;
  traceStage("route", { status: "ok", route: "command" });
  if (memoryGuard?.stopReason()) return true;
  const receipt = await sendPrivateMsg(ctx.user_id, reply, { stopReason: memoryGuard?.stopReason });
  log(isSuccessfulOutbound(receipt) ? "private command reply sent to" : "private command reply not confirmed for", ctx.user_id);
  return true;
}

async function maybeSendPrivateSticker(userId, userMessage, assistantText, contextMessages) {
  await maybeSendStickerAfterReply({
    userId,
    userMessage,
    assistantText,
    contextMessages,
    private: true,
    isPassive: false,
  });
}
