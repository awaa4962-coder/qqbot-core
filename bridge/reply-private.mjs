// bridge/reply-private.mjs - private message command and AI handling.
import { CFG } from "./config.mjs";
import { log } from "./logger.mjs";
import { getUser, users, groupChats } from "./storage.mjs";
import { describeFiles, fetchFileContent, sendPrivateMsg } from "./napcat.mjs";
import { callFallbackChat } from "./model-router.mjs";
import { buildPrivateCommandReplyAsync, isAdminUser } from "./admin-commands.mjs";
import { buildReplyContextPacket } from "./context/index.mjs";
import { handlePrivateJmTransferCommand } from "./jm-provider.mjs";
import { getPreferredDisplayName } from "./user-preferences.mjs";
import { isSuccessfulOutbound, recordConversationTurn } from "./cognition/index.mjs";
import { maybeSendStickerAfterReply } from "./features/stickers/index.mjs";

export async function handlePrivateMessage(ctx) {
  if (await handlePrivateJmTransferCommand(ctx)) return;
  if (isAdminUser(ctx.user_id) && await trySendPrivateCommand(ctx)) return;

  if (!CFG.friendWhitelist.includes(ctx.user_id)) {
    log("private msg from non-whitelist:", ctx.user_id);
    return;
  }

  if (await trySendPrivateCommand(ctx)) return;
  if (ctx.files.length) {
    await handlePrivateFileMessage(ctx);
    return;
  }

  if (ctx.text || ctx.images.length) await handlePrivateChatMessage(ctx);
}

export async function privateReply(userId, text) {
  const uid = Number(userId);
  if (!CFG.friendWhitelist.includes(uid)) {
    log("privateReply: user not in whitelist:", uid);
    return;
  }
  const context = buildPrivateReplyContext({ user_id: uid, nickname: "朋友" }, text);
  const reply = await callFallbackChat({
    userMsg: text,
    userName: context.userName,
    history: context.history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: uid },
  });
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
  const reply = await callFallbackChat({
    userMsg,
    userName: context.userName,
    history: context.history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: uid },
  });
  return reply || "抱歉，我现在有点不在状态...";
}

async function handlePrivateFileMessage(ctx) {
  const fileDesc = describeFiles(ctx.files);
  let fileContent = "";
  for (const f of ctx.files) {
    const content = await fetchFileContent(f);
    if (content) fileContent += content + "\n";
  }
  const fullMsg = ctx.text + " " + fileDesc + (fileContent ? "\n[文件内容]:\n" + fileContent : "");
  const { history, userName } = buildPrivateReplyContext(ctx, fullMsg);
  const reply = await callFallbackChat({
    userMsg: fullMsg,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id },
  });
  if (reply) {
    const result = await sendPrivateMsg(ctx.user_id, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, fullMsg, reply);
      log("private file reply sent to", ctx.user_id);
    }
  }
}

async function handlePrivateChatMessage(ctx) {
  const fullMsg = ctx.text + (ctx.images.length ? " [图片" + ctx.images.length + "张]" : "");
  const { history, userName } = buildPrivateReplyContext(ctx, fullMsg);
  const reply = await callFallbackChat({
    userMsg: fullMsg,
    userName,
    history,
    groupId: null,
    isAtMe: true,
    mood: "",
    options: { currentUserId: ctx.user_id },
  });
  if (reply) {
    const result = await sendPrivateMsg(ctx.user_id, reply);
    if (isSuccessfulOutbound(result)) {
      recordPrivateTurn(ctx, fullMsg, reply);
      log("private reply sent to", ctx.user_id);
      await maybeSendPrivateSticker(ctx.user_id, fullMsg, reply, history);
    }
  }
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
