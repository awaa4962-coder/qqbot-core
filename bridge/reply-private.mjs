// bridge/reply-private.mjs - private message command and AI handling.
import { log } from "./logger.mjs";
import { getUser, users, groupChats } from "./storage.mjs";
import { describeFiles, fetchFileContent, sendPrivateMsg } from "./napcat.mjs";
import { executePrivateChatTask, MODEL_TASKS } from "./model-router.mjs";
import { buildPrivateCommandReplyAsync, isAdminUser } from "./admin-commands.mjs";
import { buildReplyContextPacket } from "./context/index.mjs";
import { handlePrivateJmTransferCommand } from "./jm-provider.mjs";
import { getPreferredDisplayName } from "./user-preferences.mjs";
import { isSuccessfulOutbound, recordConversationTurn } from "./cognition/index.mjs";
import { maybeSendStickerAfterReply } from "./features/stickers/index.mjs";
import { traceStage } from "./diagnostics/message-trace.mjs";
import { canUsePrivateChat } from "./commands/permissions.mjs";
import { MODEL_FAILURE_NOTICE } from "./chat-outcome.mjs";
import { assertChatRunCurrent, chatRunStopReason, withChatRun } from "./cognition/chat-run.mjs";

export async function handlePrivateMessage(ctx) {
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
    await withChatRun({ surface: "private", userId: ctx.user_id }, () => handlePrivateFileMessage(ctx));
    return;
  }

  if (ctx.text || ctx.images.length) await withChatRun({ surface: "private", userId: ctx.user_id }, () => handlePrivateChatMessage(ctx));
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
    options: { currentUserId: uid },
  });
  const reply = await privateReplyText(uid, outcome);
  if (reply) {
    const result = await sendPrivateMsg(uid, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn({ user_id: uid, message_id: null }, text, reply);
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
    options: { currentUserId: uid },
  });
  return reply || MODEL_FAILURE_NOTICE;
}

async function handlePrivateFileMessage(ctx) {
  traceStage("route", { status: "ok", route: "private_file" });
  const fileDesc = describeFiles(ctx.files);
  let fileContent = "";
  for (const f of ctx.files) {
    assertChatRunCurrent();
    const content = await fetchFileContent(f);
    if (content) fileContent += content + "\n";
  }
  const fullMsg = ctx.text + " " + fileDesc + (fileContent ? "\n[文件内容]:\n" + fileContent : "");
  const { history, userName } = buildPrivateReplyContext(ctx, fullMsg);
  const outcome = await executePrivateChatTask({
    task: MODEL_TASKS.FILE_CHAT,
    imageUrls: ctx.images,
    userMsg: fullMsg,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id },
  });
  const reply = await privateReplyText(ctx.user_id, outcome);
  if (reply) {
    const result = await sendPrivateMsg(ctx.user_id, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, fullMsg, reply);
      log("private file reply sent to", ctx.user_id);
    }
  }
}

async function handlePrivateChatMessage(ctx) {
  traceStage("route", { status: "ok", route: "private_chat" });
  const fullMsg = ctx.text + (ctx.images.length ? " [图片" + ctx.images.length + "张]" : "");
  const { history, userName } = buildPrivateReplyContext(ctx, fullMsg);
  const outcome = await executePrivateChatTask({
    imageUrls: ctx.images,
    userMsg: fullMsg,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id },
  });
  const reply = await privateReplyText(ctx.user_id, outcome);
  if (reply) {
    const result = await sendPrivateMsg(ctx.user_id, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, fullMsg, reply);
      log("private reply sent to", ctx.user_id);
      await maybeSendPrivateSticker(ctx.user_id, fullMsg, reply, history);
    }
  }
}

async function privateReplyText(userId, outcome) {
  if (outcome.kind === "error") await sendPrivateMsg(userId, MODEL_FAILURE_NOTICE);
  return outcome.kind === "reply" ? outcome.text : null;
}

function buildPrivateReplyContext(ctx, userMsg) {
  const uid = String(ctx.user_id);
  getUser(uid, ctx.nickname);
  const userName = getPreferredDisplayName(uid, ctx.nickname);
  const contextPacket = buildReplyContextPacket({
    uid,
    groupId: "private",
    userName,
    userMsg,
    mode: "private",
    currentMessageId: ctx.message_id,
  });
  return { history: contextPacket.messages, userName };
}

function recordPrivateTurn(ctx, userText, assistantText) {
  if (chatRunStopReason()) return;
  recordConversationTurn({
    uid: ctx.user_id,
    groupId: "private",
    messageId: ctx.message_id,
    userText,
    assistantText,
    outcome: "sent",
  });
}

async function trySendPrivateCommand(ctx) {
  const reply = await buildPrivateCommandReplyAsync(ctx, { users, groupChats });
  if (!reply) return false;
  traceStage("route", { status: "ok", route: "command" });
  await sendPrivateMsg(ctx.user_id, reply);
  log("private command reply sent to", ctx.user_id);
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
