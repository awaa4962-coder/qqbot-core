import { CFG } from "../config.mjs";
import { isResourceGroupAllowed } from "../resource-transfer.mjs";
import { prepareCommandText } from "../commands/normalize.mjs";
import { runJmDownload } from "./runtime.mjs";
import { sendMsg, sendPrivateMsg, uploadGroupFile, uploadPrivateFile } from "../napcat.mjs";
import { transferJmToGroup, transferJmToPrivate } from "./transfer.mjs";
import { zipDirectory } from "./archive.mjs";

export const JM_RE = /^jm\s*([0-9]{3,})$/i;

export let activeJmTask = null;

export function parseJmCommand(text, options = {}) {
  const normalized = prepareCommandText(text, options);
  const match = normalized.match(JM_RE);
  if (!match) return null;
  return { ok: true, jmId: match[1] };
}

export async function handleJmTransferCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = resolveGroupJmCommand(ctx, options);
  if (!parsed) return false;

  const sender = options.sender || sendMsg;
  if (!isResourceGroupAllowed(ctx.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist)) {
    await sender(ctx.group_id, "这个群没有开启资源转发白名单。", options.replyToId);
    return true;
  }

  if (activeJmTask) {
    await sender(ctx.group_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。", options.replyToId);
    return true;
  }

  activeJmTask = parsed.jmId;
  try {
    await transferJmToGroup({
      jmId: parsed.jmId,
      groupId: ctx.group_id,
      replyToId: options.replyToId,
      sender,
      uploader: options.uploader || uploadGroupFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    });
  } finally {
    activeJmTask = null;
  }
  return true;
}

export function resolveGroupJmCommand(ctx, options) {
  if (options.parsedCommand) return options.parsedCommand;
  return parseJmCommand(ctx.text || ctx.rawText, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
}

export function isJmUserAllowed(userId, whitelist = CFG.jmUserWhitelist) {
  return whitelist.map(Number).includes(Number(userId));
}

export async function handlePrivateJmTransferCommand(ctx, options = {}) {
  const parsed = parsePrivateJmCommand(ctx, options);
  if (!parsed) return false;

  const sender = options.sender || sendPrivateMsg;
  if (!isJmUserAllowed(ctx.user_id, options.userWhitelist || CFG.jmUserWhitelist)) {
    await sender(ctx.user_id, "你没有开启私聊 JM 下载权限。");
    return true;
  }

  if (activeJmTask) {
    await sender(ctx.user_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。");
    return true;
  }

  activeJmTask = parsed.jmId;
  try {
    await transferJmToPrivate({
      jmId: parsed.jmId,
      userId: ctx.user_id,
      sender,
      uploader: options.uploader || uploadPrivateFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    });
  } finally {
    activeJmTask = null;
  }
  return true;
}

export function parsePrivateJmCommand(ctx, options) {
  const text = ctx?.text || ctx?.rawText;
  return parseJmCommand(text, { requireMention: false }) || parseJmCommand(text, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
}
