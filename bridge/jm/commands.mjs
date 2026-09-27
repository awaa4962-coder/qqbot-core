import { CFG } from "../config.mjs";
import path from "node:path";
import { isResourceGroupAllowed } from "../resource-transfer.mjs";
import { createTaskRunner, taskEventKey } from "../tasks/runner.mjs";
import { prepareCommandText } from "../commands/normalize.mjs";
import { runJmDownload } from "./runtime.mjs";
import { sendMsg, sendPrivateMsg, uploadGroupFile, uploadPrivateFile } from "../napcat.mjs";
import { transferJmToGroup, transferJmToPrivate } from "./transfer.mjs";
import { zipDirectory } from "./archive.mjs";

export const JM_RE = /^jm\s*([0-9]{3,})$/i;

export let activeJmTask = null;
const jmTasks = createTaskRunner({ filename: path.join(CFG.dataRoot, ".qqfriend", "tasks",
  process.env.NODE_ENV === "test" ? `jm-${process.pid}.json` : "jm.json"),
  maxConcurrent: 1, historyLimit: 256, busyMessage: "已有 JM 下载任务在运行，请稍后再试。" });

export function waitJmTasks() { return jmTasks.wait(); }
export function listJmTasks() { return jmTasks.list(); }

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

  return startJmTask({ jmId: parsed.jmId, kind: "group", eventKey: taskEventKey("group", ctx.group_id, ctx.message_id),
    acknowledge: () => sender(ctx.group_id, "JM " + parsed.jmId + " 已开始下载，完成后会转发到群。", options.replyToId),
    busy: () => sender(ctx.group_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。", options.replyToId),
    unavailable: () => sender(ctx.group_id, "JM 任务没能启动，请稍后检查运行状态。", options.replyToId),
    duplicate: () => sender(ctx.group_id, "这条 JM 任务已经受理过，请先核实原任务结果，不会自动重做。", options.replyToId),
    transfer: signal => transferJmToGroup({
      jmId: parsed.jmId,
      groupId: ctx.group_id,
      replyToId: options.replyToId,
      startedNotice: false,
      signal,
      assertAllowed: () => {
        signal.throwIfAborted();
        if (!isResourceGroupAllowed(ctx.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist)) throw new Error("permission_changed");
      },
      sender,
      uploader: options.uploader || uploadGroupFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    }) });
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

  return startJmTask({ jmId: parsed.jmId, kind: "private", eventKey: taskEventKey("private", ctx.user_id, ctx.message_id),
    acknowledge: () => sender(ctx.user_id, "JM " + parsed.jmId + " 已开始下载，完成后会私聊发给你。"),
    busy: () => sender(ctx.user_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。"),
    unavailable: () => sender(ctx.user_id, "JM 任务没能启动，请稍后检查运行状态。"),
    duplicate: () => sender(ctx.user_id, "这条 JM 任务已经受理过，请先核实原任务结果，不会自动重做。"),
    transfer: signal => transferJmToPrivate({
      jmId: parsed.jmId,
      userId: ctx.user_id,
      startedNotice: false,
      signal,
      assertAllowed: () => {
        signal.throwIfAborted();
        if (!isJmUserAllowed(ctx.user_id, options.userWhitelist || CFG.jmUserWhitelist)) throw new Error("permission_changed");
      },
      sender,
      uploader: options.uploader || uploadPrivateFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    }) });
}

async function startJmTask({ jmId, kind, eventKey, acknowledge, busy, unavailable, duplicate, transfer }) {
  try { if (jmTasks.hasEvent(eventKey)) { await notify(duplicate); return true; } }
  catch { await notify(unavailable); return true; }
  if (activeJmTask) { await notify(busy); return true; }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  activeJmTask = jmId;
  try {
    jmTasks.start({ scope: "jm", action: "transfer", meta: { kind, eventKey },
      timeoutMs: Math.min(2_000_000_000, Math.max(300000, Number(CFG.jmTimeoutMs) || 1800000) + 900000), run: async ({ signal }) => {
      await gate;
      try { return await transfer(signal); }
      finally { activeJmTask = null; }
    } });
  } catch (error) {
    activeJmTask = null;
    await notify(error.message === "后台任务已满，请稍后再试" || error.message === "已有 JM 下载任务在运行，请稍后再试。" ? busy : unavailable);
    return true;
  }
  try { await notify(acknowledge); }
  finally { release(); }
  return true;
}

async function notify(send) { try { await send(); } catch {} }

export function parsePrivateJmCommand(ctx, options) {
  const text = ctx?.text || ctx?.rawText;
  return parseJmCommand(text, { requireMention: false }) || parseJmCommand(text, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
}
