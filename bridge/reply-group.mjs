// bridge/reply-group.mjs - group message pipeline.
import { CFG, LONG_GROUPS } from "./config.mjs";
import { log } from "./logger.mjs";
import { logGroupMsg, users, groupChats } from "./storage.mjs";
import { getLatestChangelog } from "./context/changelog.mjs";
import { describeFiles, getGroupMemberInfo, sendMsg } from "./napcat.mjs";
import { buildGroupCommandReplyAsync } from "./admin-commands.mjs";
import {
  resolveReplyContext,
  pullRecentImages,
  handleExplicitLinkPreviewCommand,
  handleLinkPreview,
  handleMiniApp,
  buildInterjectionDecision,
} from "./reply-handlers.mjs";
import { handleJmTransferCommand } from "./jm-provider.mjs";
import { handleResourceTransferCommand } from "./resource-transfer.mjs";
import { handleFeatureCommand } from "./features/index.mjs";
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

  const replyState = await buildReplyState(ctx);
  if (await handleJmTransferCommand(ctx, { replyToId: replyState.replyToId })) return;
  if (await handleResourceTransferCommand(ctx, { replyToId: replyState.replyToId })) return;
  if (await handleExplicitLinkPreviewCommand(ctx, { replyToId: replyState.replyToId })) return;
  if (await handleFeatureCommand(ctx, { replyToId: replyState.replyToId })) return;
  if (!ctx.isAtMe) observeGroupStickerCandidates(ctx);

  const previewSent = await handleGroupPreviews(ctx, rawMessage);

  if (previewSent && !ctx.isAtMe) return;
  if (await handleMentionedGroupMessage(ctx, replyState)) return;
  if (await handlePureFileMessage(ctx)) return;

  await handleRandomInterjection(ctx, previewSent, replyState);
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
  const { sent: biliSent } = await handleLinkPreview(ctx.group_id, ctx.rawText, isLong);
  return biliSent || await handleMiniApp(rawMessage, ctx.group_id, isLong);
}

async function handleMentionedGroupMessage(ctx, replyState) {
  if (!ctx.isAtMe) return false;
  pullRecentImagesIntoContext(ctx);

  if (await trySendGroupCommand(ctx, replyState.replyToId)) return true;
  if (await trySendChangelog(ctx, replyState.replyToId)) return true;

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

async function trySendGroupCommand(ctx, replyToId) {
  const reply = await buildGroupCommandReplyAsync(ctx, { selfUin: CFG.selfUin, users, groupChats });
  if (!reply) return false;
  await sendMsg(ctx.group_id, reply, replyToId);
  logGroupMsg(ctx.group_id, "夜星", "[command]", CFG.selfUin, "assistant");
  return true;
}

function pullRecentImagesIntoContext(ctx) {
  const recentImgs = pullRecentImages(ctx.group_id);
  if (recentImgs.length) ctx.images.push(...recentImgs);
}

async function trySendChangelog(ctx, replyToId) {
  if (!ctx.text.includes("更新日志") && !ctx.text.includes("更新记录") && ctx.text !== "changelog") return false;
  const cl = getLatestChangelog();
  await sendMsg(ctx.group_id, "📋 夜星更新日志喵～\n\n" + cl, replyToId);
  logGroupMsg(ctx.group_id, "夜星", "[changelog]", CFG.selfUin, "assistant");
  return true;
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

function requireLongGroup(groupId) {
  return LONG_GROUPS.includes(String(groupId));
}
