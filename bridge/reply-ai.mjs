// bridge/reply-ai.mjs - AI reply orchestration and profile refresh throttling.
import { CFG } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { logGroupMsg, getUser, users, saveUsers } from "./storage.mjs";
import { sendMsg } from "./napcat.mjs";
import { generateProfile } from "./profile.mjs";
import {
  buildModelFallbackHistory,
  executeChatTask,
  resolveChatVisionContext,
} from "./model-router.mjs";
import { buildSafeInterjectionReply } from "./reply-handlers.mjs";
import { buildReplyContextPacket } from "./context/index.mjs";
import { getPreferredDisplayName } from "./user-preferences.mjs";
import { isSuccessfulOutbound, recordConversationTurn } from "./cognition/index.mjs";
import { selectPersonaCue } from "./persona-style.mjs";
import { maybeSendStickerAfterReply } from "./features/stickers/index.mjs";

const PROFILE_REFRESH_MS = 6 * 60 * 60 * 1000;
const PROFILE_REFRESH_MESSAGES = 30;
const PROFILE_MIN_MESSAGES = 10;

export async function aiReply(group_id, userId, userMsg, userName, imageUrls, replyTo, replyText, isAtMe, mentions = [], runtime = {}) {
  if (isAtMe === undefined) isAtMe = true;
  const gid = String(group_id);
  const uid = String(userId);
  const isPassiveInterjection = isAtMe === false;
  const personaCue = selectPersonaCue(userMsg, {
    replyMode: isPassiveInterjection ? "interjection" : "chat",
  });

  getUser(uid, userName);
  const preferredUserName = getPreferredDisplayName(uid, userName);

  const contextPacket = buildReplyContextPacket({
    uid,
    groupId: gid,
    userName: preferredUserName,
    userMsg,
    replyText,
    mentions,
    mode: isPassiveInterjection ? "interjection" : "group-at",
    currentMessageId: runtime.messageId,
    hasImages: Boolean(imageUrls?.length),
    imageCount: imageUrls?.length || 0,
  });

  const mimoOptions = isPassiveInterjection
    ? { allowTools: false, replyMode: "interjection", currentUserId: uid, personaCue }
    : { allowTools: true, replyMode: "chat", currentUserId: uid, personaCue };
  const reply = await resolveAiReply({
    userMsg,
    userName: preferredUserName,
    fullHistory: contextPacket.messages,
    imageUrls,
    group_id,
    isAtMe,
    mood: contextPacket.mood,
    mimoOptions,
    uid,
    isPassiveInterjection,
  });
  if (!reply) return;

  const sendResult = await sendMsg(group_id, reply, replyTo);
  if (!isSuccessfulOutbound(sendResult)) {
    logE("aiReply send failed for", preferredUserName, "in", gid);
    return;
  }
  logGroupMsg(group_id, "夜星", reply, CFG.selfUin, "assistant", null, {
    replyToMessageId: runtime.messageId || replyTo,
    turnId: runtime.messageId,
  });
  if (!isPassiveInterjection) {
    recordConversationTurn({
      uid,
      groupId: gid,
      messageId: runtime.messageId,
      userText: userMsg,
      assistantText: reply,
      outcome: "sent",
    });
  }
  log("aiReply done for", preferredUserName, "in", gid);
  await maybeSendStickerAfterReply({
    groupId: gid,
    userId: uid,
    userMessage: userMsg,
    assistantText: reply,
    contextMessages: contextPacket.messages,
    private: false,
    isPassive: isPassiveInterjection,
  });

  if (CFG.legacyProfileRefreshEnabled) {
    maybeGenerateProfile(uid).catch(function (e) { logE("profile update failed for", uid, ":", e.message); });
  }
}

export function shouldGenerateProfile(uid, now = Date.now()) {
  const u = users[String(uid)];
  const chatCount = Array.isArray(u?.chats) ? u.chats.length : 0;
  if (chatCount < PROFILE_MIN_MESSAGES) return false;

  const lastAt = Number(u.profileGeneratedAt || 0);
  const lastCount = Number(u.profileGeneratedChatCount || 0);
  if (!lastAt) return true;
  return now - lastAt >= PROFILE_REFRESH_MS ||
    chatCount - lastCount >= PROFILE_REFRESH_MESSAGES;
}

export async function maybeGenerateProfile(uid, generator = generateProfile, now = Date.now()) {
  if (!shouldGenerateProfile(uid, now)) return "";
  const u = users[String(uid)];
  if (u) {
    u.profileGeneratedAt = now;
    u.profileGeneratedChatCount = Array.isArray(u.chats) ? u.chats.length : 0;
    saveUsers();
  }
  return await generator(uid);
}

const LAST_RESORT_REPLIES = [
  "诶嘿～",
  "有意思喵",
  "ww",
  "确实确实",
  "好家伙",
  "原来如此",
];
const LAST_RESORT_MIN_LENGTH = 8;

function shouldLastResortInterject(userMsg) {
  const t = String(userMsg || '').trim();
  if (!t || t.length < LAST_RESORT_MIN_LENGTH) return false;
  if (/[?？]$/.test(t) || /^(?:怎么|为什么|咋办|如何|能不能)/.test(t)) return false;
  // skip pure emoji / single-word echo
  if (/^[\u{1F600}-\u{1F64F}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{200D}]+$/u.test(t)) return false;
  return true;
}

function pickLastResortReply() {
  return LAST_RESORT_REPLIES[Math.floor(Math.random() * LAST_RESORT_REPLIES.length)];
}

async function resolveAiReply(ctx) {
  const hasImages = Boolean(ctx.imageUrls?.length);
  const visionContext = hasImages
    ? await resolveChatVisionContext(ctx.imageUrls)
    : undefined;
  const modelResult = await executeChatTask({
    userMsg: ctx.userMsg,
    userName: ctx.userName,
    history: ctx.fullHistory,
    imageUrls: ctx.imageUrls,
    groupId: ctx.group_id,
    isAtMe: ctx.isAtMe,
    mood: ctx.mood,
    options: {
      ...ctx.mimoOptions,
      ...(hasImages ? { visionContext } : {}),
    },
  });
  let reply = modelResult.text;
  if (reply) log("aiReply route:", modelResult.position);

  if (!reply && ctx.isPassiveInterjection) {
    reply = buildSafeInterjectionReply(ctx.userMsg);
    if (!reply && !hasImages && shouldLastResortInterject(ctx.userMsg)) {
      reply = pickLastResortReply();
    }
    if (reply) log("random interjection safe fallback; route: local");
    else log("random interjection dropped after model failure");
    return reply;
  }

  return reply || "啊，我现在有点卡卡的，等我缓一下再回复你~ 🤔";
}

export { buildModelFallbackHistory };
