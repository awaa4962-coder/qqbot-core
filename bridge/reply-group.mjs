// bridge/reply-group.mjs - group message pipeline.
import { CFG, LONG_GROUPS } from "./config.mjs";
import { log } from "./logger.mjs";
import { logGroupMsg } from "./storage.mjs";
import { describeFiles, getGroupMemberInfo, sendMsg } from "./napcat.mjs";
import {
  resolveReplyContext,
  pullRecentImages,
  handleLinkPreview,
  handleMiniApp,
  buildInterjectionDecision,
} from "./reply-handlers.mjs";
import { dispatchGroupCommand } from "./commands/action-dispatcher.mjs";
import { observeMemoryEvent, getActiveMemoryContext } from "./memory-profile.mjs";
import { observeMemeUsage } from "./knowledge/memes/index.mjs";
import { observeGroupDuplicate } from "./duplicate-message.mjs";
import { interjectionToleranceFactor } from "./context-retriever.mjs";
import { hydrateMentions } from "./mentions/index.mjs";
import { aiReply } from "./reply-ai.mjs";
import { observeGroupStickerCandidates } from "./features/stickers/index.mjs";

export async function handleGroupMessage(ctx, rawMessage) {
  if (shouldIgnoreGroupMessage(ctx)) return;

  await hydrateMentions(ctx.mentions, { groupId: ctx.group_id, getGroupMemberInfo });
  logGroupAttachments(ctx);
  ctx.duplicateInfo = logGroupMemberMessage(ctx);
  if (ctx.duplicateInfo?.duplicate && !ctx.isAtMe) return;

  const replyState = createPendingReplyState(ctx);
  if (await dispatchGroupCommand(ctx, { replyToId: replyState.replyToId })) return;
  if (!ctx.isAtMe) observeGroupStickerCandidates(ctx);

  const previewState = await handleGroupPreviews(ctx, rawMessage);

  if (previewState.sent && !ctx.isAtMe) return;
  if (await handleMentionedGroupMessage(ctx, replyState)) return;
  if (await handlePureFileMessage(ctx)) return;

  await handleRandomInterjection(ctx, previewState.suppressInterjection, replyState);
}

export async function buildReplyState(ctx, resolveContext = resolveReplyContext) {
  return {
    replyText: await resolveContext(ctx),
    replyToId: ctx.message_id,
  };
}

function shouldIgnoreGroupMessage(ctx) {
  if (ctx.user_id === CFG.selfUin) return true;
  if (CFG.groupWhitelist.includes(ctx.group_id)) return false;
  log("msg from non-whitelist group:", ctx.group_id);
  return true;
}

function logGroupAttachments(ctx) {
  if (!ctx.images.length) return;
  log("IMG detected in", ctx.group_id, ":", ctx.images.length,
    "urls:", JSON.stringify(ctx.images.map(function (u) { return u.slice(0, 80); })));
}

function logGroupMemberMessage(ctx) {
  const duplicateInfo = observeGroupDuplicate({
    uid: ctx.user_id,
    groupId: ctx.group_id,
    text: ctx.text,
    isAtMe: ctx.isAtMe,
    hasImages: ctx.images.length > 0,
    hasFiles: ctx.files.length > 0,
  });
  if (duplicateInfo.duplicate) {
    log("duplicate group text skipped:", ctx.group_id, ctx.user_id, duplicateInfo.reason, duplicateInfo.previousCount);
    return duplicateInfo;
  }
  logGroupMsg(ctx.group_id, ctx.nickname, ctx.text || "[非文本消息]",
    ctx.user_id, "member", ctx.images.length ? ctx.images : null, {
      mentions: ctx.mentions,
      messageId: ctx.message_id,
    });
  observeMemoryEvent({
    uid: ctx.user_id,
    groupId: ctx.group_id,
    nickname: ctx.nickname,
    text: ctx.text,
  });
  observeMemeUsage({
    uid: ctx.user_id,
    groupId: ctx.group_id,
    nickname: ctx.nickname,
    text: ctx.text,
  });
  return duplicateInfo;
}

async function handleGroupPreviews(ctx, rawMessage) {
  const isLong = requireLongGroup(ctx.group_id);
  const link = await handleLinkPreview(ctx.group_id, ctx.rawText, isLong, { isAtMe: ctx.isAtMe });
  const miniAppSent = !ctx.isAtMe && !link.sent
    ? await handleMiniApp(rawMessage, ctx.group_id, isLong)
    : false;
  return {
    sent: link.sent || miniAppSent,
    suppressInterjection: link.hadLink || miniAppSent,
  };
}

async function handleMentionedGroupMessage(ctx, replyState) {
  if (!ctx.isAtMe) return false;
  await ensureReplyState(ctx, replyState);
  pullRecentImagesIntoContext(ctx);

  log("at detected, processing AI reply...");
  await aiReply(
    ctx.group_id,
    ctx.user_id,
    ctx.text,
    ctx.nickname,
    ctx.images,
    replyState.replyToId,
    replyState.replyText,
    true,
    ctx.mentions,
    { messageId: ctx.message_id }
  );
  return true;
}

function pullRecentImagesIntoContext(ctx) {
  const recentImgs = pullRecentImages(ctx.group_id);
  if (recentImgs.length) ctx.images.push(...recentImgs);
}

async function handlePureFileMessage(ctx) {
  if (ctx.text || !ctx.files.length || ctx.images.length) return false;
  const fileDesc = describeFiles(ctx.files);
  await sendMsg(ctx.group_id, ctx.nickname + " 发了文件: " + fileDesc);
  return true;
}

async function handleRandomInterjection(ctx, previewSent, replyState = {}) {
  if (ctx.duplicateInfo?.duplicate) {
    log("random interjection skipped: duplicate", ctx.duplicateInfo.reason);
    return;
  }
  const memory = getActiveMemoryContext(ctx.user_id, ctx.group_id);
  const decision = buildInterjectionDecision(ctx.text, {
    isAtMe: ctx.isAtMe,
    previewSent,
    groupId: ctx.group_id,
    userId: ctx.user_id,
    messageId: ctx.message_id,
    hasImages: ctx.images.length > 0,
    probabilityFactor: interjectionToleranceFactor(memory.groupProfile),
  });
  if (!decision.ok) {
    if (decision.kind !== "ordinary" || ctx.images.length) {
      log("random interjection skipped:", decision.kind, decision.reason);
    }
    return;
  }
  log("random interjection triggered:", decision.kind);
  await ensureReplyState(ctx, replyState);
  const text = ctx.text || (ctx.images.length ? "[图片]" : "");
  await aiReply(
    ctx.group_id,
    ctx.user_id,
    text,
    ctx.nickname,
    ctx.images,
    null,
    replyState.replyText || "",
    false,
    ctx.mentions,
    { messageId: ctx.message_id }
  );
}

function createPendingReplyState(ctx) {
  return {
    replyText: "",
    replyToId: ctx.message_id,
    contextResolved: false,
  };
}

async function ensureReplyState(ctx, state) {
  if (state.contextResolved) return state;
  state.replyText = await resolveReplyContext(ctx);
  state.contextResolved = true;
  return state;
}

function requireLongGroup(groupId) {
  return LONG_GROUPS.includes(String(groupId));
}
