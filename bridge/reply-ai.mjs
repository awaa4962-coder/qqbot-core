// bridge/reply-ai.mjs - AI reply orchestration and profile refresh throttling.
import { CFG } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { logGroupMsg, getUser, users, saveUsers } from "./storage.mjs";
import { sendMsg } from "./napcat.mjs";
import { generateProfile } from "./profile.mjs";
import {
  buildModelFallbackHistory,
  executeChatTask,
} from "./model-router.mjs";
import { buildReplyContextPacket } from "./context/index.mjs";
import { getPreferredDisplayName } from "./user-preferences.mjs";
import { isSuccessfulOutbound, recordConversationTurn } from "./cognition/index.mjs";
import { selectPersonaCue } from "./persona-style.mjs";
import { maybeSendStickerAfterReply } from "./features/stickers/index.mjs";
import { wallAgeMs } from "./runtime-clock.mjs";
import { traceStage } from "./diagnostics/message-trace.mjs";
import { MODEL_FAILURE_NOTICE, normalizeChatOutcome } from "./chat-outcome.mjs";
import { chatRunStopReason, withChatRun } from "./cognition/chat-run.mjs";

const PROFILE_REFRESH_MS = 6 * 60 * 60 * 1000;
const PROFILE_REFRESH_MESSAGES = 30;
const PROFILE_MIN_MESSAGES = 10;
const profileRefreshInFlight = new Map();

export async function aiReply(group_id, userId, userMsg, userName, imageUrls, replyTo, replyText, isAtMe, mentions = [], runtime = {}) {
  return await withChatRun({ surface: "group", groupId: group_id, userId, messageId: runtime.messageId,
    eventTime: runtime.eventTime, contextPrivacyGeneration: runtime.contextPrivacyGeneration }, () =>
    runAiReply(group_id, userId, userMsg, userName, imageUrls, replyTo, replyText, isAtMe, mentions, runtime));
}

async function runAiReply(group_id, userId, userMsg, userName, imageUrls, replyTo, replyText, isAtMe, mentions, runtime) {
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
    replyToMessageId: runtime.replyToMessageId,
    replySpeaker: runtime.replySpeaker,
    replyUserId: runtime.replyUserId,
    quoteEvidence: runtime.quoteEvidence,
    hasImages: Boolean(imageUrls?.length),
    imageCount: imageUrls?.length || 0,
    imageAnchor: runtime.imageAnchor,
  });

  const mimoOptions = { allowTools: !isPassiveInterjection, replyMode: isPassiveInterjection ? "interjection" : "chat",
    currentUserId: uid, personaCue, currentInput: contextPacket.currentInput, imageSources: runtime.imageSources };
  const outcome = await resolveAiReply({
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
  }, runtime);
  if (outcome.kind !== "reply") {
    await notifyGroupFailure(outcome, isPassiveInterjection, group_id, replyTo);
    return;
  }
  const reply = outcome.text;

  const sendResult = await sendMsg(group_id, reply, replyTo);
  if (chatRunStopReason()) return;
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
      memorySources: replyMemorySources(contextPacket, outcome),
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

  if (CFG.legacyProfileRefreshEnabled && !chatRunStopReason()) {
    maybeGenerateProfile(uid).catch(function (e) { logE("profile update failed for", uid, ":", e.message); });
  }
}

async function notifyGroupFailure(outcome, passive, groupId, replyTo) {
  if (outcome.kind === "error" && !passive) await sendMsg(groupId, MODEL_FAILURE_NOTICE, replyTo);
}

function replyMemorySources(packet, outcome) {
  return [...packet.retrieval.sources.filter(source => source.kind === "note"), ...(outcome.memorySources || [])];
}

export function shouldGenerateProfile(uid, now = Date.now()) {
  const u = users[String(uid)];
  const chatCount = Array.isArray(u?.chats) ? u.chats.length : 0;
  if (chatCount < PROFILE_MIN_MESSAGES) return false;

  const lastAt = Number(u.profileGeneratedAt || 0);
  const lastCount = Number(u.profileGeneratedChatCount || 0);
  if (!lastAt) return true;
  return wallAgeMs(lastAt, now) >= PROFILE_REFRESH_MS ||
    chatCount - lastCount >= PROFILE_REFRESH_MESSAGES;
}

export async function maybeGenerateProfile(uid, generator = generateProfile, now = Date.now()) {
  const key = String(uid);
  if (profileRefreshInFlight.has(key)) return await profileRefreshInFlight.get(key);
  if (!shouldGenerateProfile(key, now)) return "";
  const task = Promise.resolve(generator(key)).then(result => {
    if (result && !chatRunStopReason()) markProfileGenerated(key, now);
    return result;
  }).finally(() => profileRefreshInFlight.delete(key));
  profileRefreshInFlight.set(key, task);
  return await task;
}

function markProfileGenerated(uid, now) {
  const user = users[String(uid)];
  if (!user) return;
  user.profileGeneratedAt = now;
  user.profileGeneratedChatCount = Array.isArray(user.chats) ? user.chats.length : 0;
  saveUsers();
}

export async function resolveAiReply(ctx, runtime = {}) {
  const hasImages = Boolean(ctx.imageUrls?.length);
  const visionContext = hasImages && runtime.resolveVision
    ? await runtime.resolveVision(ctx.imageUrls, { userId: ctx.uid })
    : undefined;
  const modelResult = await (runtime.executeChatTask || executeChatTask)({
    userMsg: ctx.userMsg,
    userName: ctx.userName,
    history: ctx.fullHistory,
    imageUrls: ctx.imageUrls,
    groupId: ctx.group_id,
    isAtMe: ctx.isAtMe,
    mood: ctx.mood,
    options: {
      ...ctx.mimoOptions,
      ...(hasImages && runtime.resolveVision ? { visionContext } : {}),
    },
  });
  const outcome = normalizeChatOutcome(modelResult);
  traceStage("output", { status: outcome.kind === "reply" ? "ok" : outcome.kind === "error" ? "failed" : "skipped",
    position: modelResult.position, reason: outcome.kind === "reply" ? undefined : outcome.reason });
  return { ...outcome, position: modelResult.position };
}

export { buildModelFallbackHistory };
