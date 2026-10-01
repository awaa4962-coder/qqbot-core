// bridge/reply-group.mjs - group message pipeline.
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { captureSummaryMessage } from "./group-summary/journal.mjs";
import { logGroupMsg } from "./storage.mjs";
import { describeFiles, getGroupMemberInfo, sendMsg } from "./napcat.mjs";
import {
  resolveReplyContext,
  pullRecentImages,
  handleLinkPreview,
  handleMiniAppResult,
  hasMiniAppPayload,
  buildInterjectionDecision,
} from "./reply-handlers.mjs";
import { inspectAutoPreview } from "./services/link-preview/index.mjs";
import { dispatchGroupCommand, matchSpecialGroupAction } from "./commands/action-dispatcher.mjs";
import { observeMemoryEvent, getActiveMemoryContext } from "./memory-profile.mjs";
import { observeGroupDuplicate } from "./duplicate-message.mjs";
import { interjectionToleranceFactor } from "./context-retriever.mjs";
import { hydrateMentions } from "./mentions/index.mjs";
import { aiReply } from "./reply-ai.mjs";
import { observeGroupStickerCandidates } from "./features/stickers/index.mjs";
import { traceStage } from "./diagnostics/message-trace.mjs";
import { getMemoryPrivacyGeneration } from "./memory-profile/generation.mjs";
import { messageRouteRejection } from "./event-admission.mjs";
import { isSelfMemoryCommand } from "./commands/modules/memory.mjs";
import { normalizeCommand, prepareCommandText } from "./commands/normalize.mjs";
import { isRelationshipCommand } from "./relationship-commands.mjs";
import { memoryCorrectionSnapshot } from "./memory-profile/notes.mjs";
import { storedScopeSourceLinks } from "./memory-profile/retention.mjs";
import { collectSourceMessageIds } from "./memory-profile/source-exclusions.mjs";
import { chatWorkScheduler } from "./cognition/chat-work.mjs";
import { withChatRun, noteChatOutcome } from "./cognition/chat-run.mjs";

export async function handleGroupMessage(ctx, rawMessage, options = {}) {
  ctx.contextPrivacyGeneration ??= getMemoryPrivacyGeneration();
  if (!await prepareGroupMessage(ctx)) return null;

  const replyState = createPendingReplyState(ctx);
  const command = await handleGroupCommand(ctx, replyState, options);
  if (command) return command;
  if (stopStaleGroupContext(ctx)) return null;
  if (!ctx.isAtMe) observeGroupStickerCandidates(ctx);

  const detachedPreview = startDetachedGroupPreview(ctx, rawMessage, options);
  if (detachedPreview) return detachedPreview;

  const previewState = await handleGroupPreviews(ctx, rawMessage, options.previewOptions);
  if (stopStaleGroupContext(ctx)) return null;

  if (previewState.sent && !ctx.isAtMe) {
    traceStage("route", { status: "ok", route: "preview" });
    return null;
  }
  const mentioned = await handleMentionedGroupMessage(ctx, replyState, options);
  if (mentioned) return mentioned === true ? null : mentioned;
  if (await handlePureFileMessage(ctx)) return null;

  return await handleRandomInterjection(ctx, previewState.suppressInterjection, replyState, options);
}

async function handleGroupCommand(ctx, replyState, options) {
  const detachedCommand = await startDetachedSlowCommand(ctx, replyState, options);
  if (detachedCommand) return detachedCommand;
  return await dispatchGroupCommand(ctx, { replyToId: replyState.replyToId }) ? {} : null;
}

function slowCommandKind(ctx) {
  const commandText = prepareCommandText(ctx.text || ctx.rawText, { requireMention: true });
  const special = matchSpecialGroupAction(commandText);
  if (special?.id === "link-preview") return "preview";
  if (special?.id === "wordcloud" || isRelationshipCommand(normalizeCommand(commandText))) return "command";
  return "";
}

async function startDetachedSlowCommand(ctx, replyState, options) {
  if (!options.detachChat || !ctx.isAtMe) return null;
  const kind = slowCommandKind(ctx);
  if (!kind) return null;
  const commandOptions = kind === "preview" ? options.previewOptions : options.commandOptions;
  const run = () => withChatRun({ surface: "group", lane: kind, groupId: ctx.group_id, userId: ctx.user_id,
    messageId: ctx.message_id, eventTime: ctx.eventTime,
    contextPrivacyGeneration: ctx.contextPrivacyGeneration }, async () => {
    await dispatchGroupCommand(ctx, { replyToId: replyState.replyToId, ...commandOptions });
    noteChatOutcome({ kind: "silence" });
  });
  const scheduled = (options.chatScheduler || chatWorkScheduler).start(
    { groupId: ctx.group_id, userId: ctx.user_id, kind }, run);
  if (scheduled.ok) return { completion: scheduled.completion };
  await sendChatCapacityNotice(ctx, replyState, scheduled.reason, kind);
  return {};
}

async function prepareGroupMessage(ctx) {
  if (stopStaleGroupContext(ctx)) return false;
  captureGroupSummary(ctx);

  await hydrateMentions(ctx.mentions, { groupId: ctx.group_id, getGroupMemberInfo });
  if (stopStaleGroupContext(ctx)) return false;
  logGroupAttachments(ctx);
  ctx.duplicateInfo = logGroupMemberMessage(ctx);
  if (ctx.duplicateInfo?.duplicate && !ctx.isAtMe) {
    traceStage("route", { status: "skipped", reason: "duplicate_text" });
    return false;
  }
  return true;
}

function captureGroupSummary(ctx) {
  try { captureSummaryMessage(ctx); } catch { logE("summary journal capture failed"); }
}

export async function buildReplyState(ctx, resolveContext = resolveReplyContext) {
  return {
    replyText: await resolveContext(ctx),
    replyToId: ctx.message_id,
  };
}

function logGroupAttachments(ctx) {
  if (!ctx.images.length) return;
  log("IMG detected in", ctx.group_id, ":", ctx.images.length);
}

function logGroupMemberMessage(ctx) {
  const source = inheritedSourceExclusion(ctx);
  ctx.memorySourceExcluded = source.retracted;
  ctx.memorySourceIds = source.ids;
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
      replyToMessageId: ctx.replyData?.id,
      memoryCommand: ctx.isAtMe && isSelfMemoryCommand(normalizeCommand(ctx.text)),
      retracted: ctx.memorySourceExcluded,
      memorySourceIds: ctx.memorySourceIds,
    });
  observeMemoryEvent({
    uid: ctx.user_id,
    groupId: ctx.group_id,
    nickname: ctx.nickname,
    text: ctx.text,
  });
  return duplicateInfo;
}

function inheritedSourceExclusion(ctx) {
  if (!ctx.replyData?.id) return { retracted: false, ids: [] };
  try {
    const scope = { userId: String(ctx.user_id), groupId: String(ctx.group_id) };
    const { excludedMessageIds } = memoryCorrectionSnapshot(scope);
    const ids = collectSourceMessageIds(storedScopeSourceLinks(scope), [String(ctx.replyData.id)]);
    return { retracted: !ids || ids.some(id => excludedMessageIds.has(id)), ids: ids || [] };
  } catch {
    // Unverifiable quote ancestry must not become evidence after its parent leaves the buffer.
    return { retracted: true, ids: [] };
  }
}

async function handleGroupPreviews(ctx, rawMessage, previewOptions = {}) {
  const isLong = requireLongGroup(ctx.group_id);
  const link = await handleLinkPreview(ctx.group_id, ctx.rawText, isLong, { ...previewOptions, isAtMe: ctx.isAtMe });
  const miniApp = !ctx.isAtMe && !link.sent && !link.reason.startsWith("send_")
    ? await handleMiniAppResult(rawMessage, ctx.group_id, isLong, previewOptions)
    : { found: false, delivery: "not_attempted" };
  return {
    sent: link.sent || miniApp.delivery === "sent",
    suppressInterjection: link.hadLink || miniApp.found,
  };
}

function startDetachedGroupPreview(ctx, rawMessage, options) {
  if (!options.detachChat || ctx.isAtMe) return null;
  const isLong = requireLongGroup(ctx.group_id);
  const link = inspectAutoPreview(ctx.rawText, { groupId: ctx.group_id, isLongGroup: isLong });
  if (!link.ok && (isLong || !hasMiniAppPayload(rawMessage))) return null;
  traceStage("route", { status: "ok", route: "preview" });
  const run = () => withChatRun({ surface: "group", lane: "preview", groupId: ctx.group_id, userId: ctx.user_id,
    messageId: ctx.message_id, eventTime: ctx.eventTime,
    contextPrivacyGeneration: ctx.contextPrivacyGeneration }, async () => {
    const result = await handleGroupPreviews(ctx, rawMessage, options.previewOptions);
    noteChatOutcome({ kind: result.sent ? "reply" : "silence" });
    return result;
  });
  const scheduled = (options.chatScheduler || chatWorkScheduler).start(
    { groupId: ctx.group_id, userId: ctx.user_id, kind: "preview" }, run);
  if (scheduled.ok) return { completion: scheduled.completion };
  traceStage("output", { status: "skipped", reason: scheduled.reason });
  return {};
}

async function handleMentionedGroupMessage(ctx, replyState, options = {}) {
  if (!ctx.isAtMe) return false;
  traceStage("route", { status: "ok", route: "group_at" });
  await ensureReplyState(ctx, replyState);
  if (stopStaleGroupContext(ctx)) return true;
  pullRecentImagesIntoContext(ctx);

  log("at detected, processing AI reply...");
  const run = () => (options.chatReply || aiReply)(
    ctx.group_id,
    ctx.user_id,
    ctx.text,
    ctx.nickname,
    ctx.images,
    replyState.replyToId,
    replyState.replyText,
    true,
    ctx.mentions,
    replyRuntime(ctx)
  );
  if (options.detachChat) {
    const scheduled = (options.chatScheduler || chatWorkScheduler).start({ groupId: ctx.group_id, userId: ctx.user_id }, run);
    if (scheduled.ok) return { completion: scheduled.completion };
    await sendChatCapacityNotice(ctx, replyState, scheduled.reason);
    return true;
  }
  await run();
  return true;
}

async function sendChatCapacityNotice(ctx, replyState, reason, lane = "chat") {
  traceStage("output", { status: "failed", reason });
  await withChatRun({ surface: "group", lane, groupId: ctx.group_id, userId: ctx.user_id, messageId: ctx.message_id,
    eventTime: ctx.eventTime, contextPrivacyGeneration: ctx.contextPrivacyGeneration }, async () => {
    noteChatOutcome({ kind: "error" });
    await sendMsg(ctx.group_id, "当前回复任务较多，请稍后再试。", replyState.replyToId);
  });
}

function pullRecentImagesIntoContext(ctx) {
  if (ctx.images.length || ctx.quoteEvidence?.state === "unavailable") return;
  const recentImgs = pullRecentImages(ctx.group_id, {
    uid: ctx.user_id, userMsg: ctx.text, mentions: ctx.mentions, replyToMessageId: ctx.replyData?.id,
    onSource: source => { ctx.imageSources = Array(3).fill(source); ctx.imageAnchor = source; },
  });
  if (recentImgs.length) ctx.images.push(...recentImgs);
}

async function handlePureFileMessage(ctx) {
  if (ctx.text || !ctx.files.length || ctx.images.length) return false;
  traceStage("route", { status: "ok", route: "file" });
  const fileDesc = describeFiles(ctx.files);
  await sendMsg(ctx.group_id, ctx.nickname + " 发了文件: " + fileDesc);
  return true;
}

async function handleRandomInterjection(ctx, previewSent, replyState = {}, options = {}) {
  if (ctx.duplicateInfo?.duplicate) {
    log("random interjection skipped: duplicate", ctx.duplicateInfo.reason);
    return null;
  }
  const memory = getActiveMemoryContext(ctx.user_id, ctx.group_id, { groupOnly: true });
  const decision = (options.interjectionDecision || buildInterjectionDecision)(ctx.text, {
    isAtMe: ctx.isAtMe,
    previewSent,
    groupId: ctx.group_id,
    userId: ctx.user_id,
    messageId: ctx.message_id,
    hasImages: ctx.images.length > 0,
    probabilityFactor: interjectionToleranceFactor(memory.groupProfile),
  });
  traceStage("route", {
    route: "interjection", status: decision.ok ? "ok" : "skipped",
    reason: decision.reason, probability: decision.probability,
  });
  if (!decision.ok) {
    if (decision.kind !== "ordinary" || ctx.images.length) {
      log("random interjection skipped:", decision.kind, decision.reason);
    }
    return null;
  }
  log("random interjection triggered:", decision.kind);
  await ensureReplyState(ctx, replyState);
  if (stopStaleGroupContext(ctx)) return null;
  const run = () => runInterjectionReply(ctx, replyState, options);
  if (options.detachChat) return startInterjectionWork(ctx, run, options);
  await run();
  return null;
}

function runInterjectionReply(ctx, replyState, options) {
  const text = ctx.text || (ctx.images.length ? "[图片]" : "");
  return (options.chatReply || aiReply)(
    ctx.group_id,
    ctx.user_id,
    text,
    ctx.nickname,
    ctx.images,
    null,
    replyState.replyText || "",
    false,
    ctx.mentions,
    replyRuntime(ctx)
  );
}

function startInterjectionWork(ctx, run, options) {
  const scheduled = (options.chatScheduler || chatWorkScheduler).start(
    { groupId: ctx.group_id, userId: ctx.user_id, kind: "interjection" }, run);
  if (scheduled.ok) return { completion: scheduled.completion };
  traceStage("output", { status: "skipped", reason: scheduled.reason });
  return null;
}

function createPendingReplyState(ctx) {
  return {
    replyText: "",
    replyToId: ctx.message_id,
    contextResolved: false,
  };
}

function replyRuntime(ctx) {
  return { messageId: ctx.message_id, eventTime: ctx.eventTime, replyToMessageId: ctx.replyData?.id,
    memorySourceExcluded: ctx.memorySourceExcluded === true,
    memorySourceIds: ctx.memorySourceIds,
    replySpeaker: ctx.replySpeaker, replyUserId: ctx.replyUserId, quoteEvidence: ctx.quoteEvidence, contextPrivacyGeneration: ctx.contextPrivacyGeneration,
    imageSources: ctx.imageSources, imageAnchor: ctx.imageAnchor, attachments: ctx.files, mentionTargets: ctx.mentions };
}

function stopStaleGroupContext(ctx) {
  const reason = ctx.contextPrivacyGeneration !== getMemoryPrivacyGeneration() ? "privacy_changed"
    : messageRouteRejection({ ...ctx, message_type: "group" }) ? "permission_changed" : "";
  if (!reason) return false;
  traceStage("output", { status: "skipped", reason });
  return true;
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
