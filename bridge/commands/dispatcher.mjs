import { CFG } from "../config.mjs";
import {
  buildGroupSummaryCommandReply,
  isGroupSummaryCommand,
} from "../group-summary/commands.mjs";
import {
  isRelationshipCommand,
} from "../relationship-commands.mjs";
import { normalizeCommand } from "./normalize.mjs";
import { isAdminUser } from "./permissions.mjs";
import { isKnownCommand } from "./registry.mjs";
import { buildAdminCommandReply } from "./modules/admin.mjs";
import { buildUserCommandReply } from "./modules/basic.mjs";
import {
  buildRelationshipCommandReply,
  buildRelationshipCommandReplyAsync,
} from "./modules/relationship.mjs";
import { buildUnknownCommandSuggestion } from "../capabilities/catalog.mjs";

export function buildCommandReply(commandText, options = {}) {
  const cmd = normalizeCommand(commandText, options);
  if (!cmd) return null;
  if (!isKnownCommand(cmd)) return buildUnknownCommandSuggestion(cmd, capabilityOptions(options));

  const adminReply = buildAdminCommandReply(cmd, { ...options, rawCommandText: commandText });
  if (adminReply) return adminReply;

  if (isGroupSummaryCommand(cmd)) return buildGroupSummarySyncReply(options);

  const userReply = buildUserCommandReply(cmd, { ...options, rawCommandText: commandText });
  if (userReply) return userReply;

  if (isRelationshipCommand(cmd)) return buildRelationshipCommandReply(cmd, options);
  return null;
}

export async function buildCommandReplyAsync(commandText, options = {}) {
  const cmd = normalizeCommand(commandText, options);
  if (!cmd) return null;
  if (!isKnownCommand(cmd)) return buildUnknownCommandSuggestion(cmd, capabilityOptions(options));

  const adminReply = buildAdminCommandReply(cmd, { ...options, rawCommandText: commandText });
  if (adminReply) return adminReply;

  if (isGroupSummaryCommand(cmd)) {
    if (!isAdminUser(options.userId, options.admins)) return "这个命令需要管理员权限。";
    return await buildGroupSummaryCommandReply(cmd, options);
  }

  const userReply = buildUserCommandReply(cmd, { ...options, rawCommandText: commandText });
  if (userReply) return userReply;

  if (isRelationshipCommand(cmd)) return await buildRelationshipCommandReplyAsync(cmd, options);
  return null;
}

export function buildGroupCommandReply(ctx, options = {}) {
  if (!ctx?.isAtMe) return null;
  return buildCommandReply(ctx.text || ctx.rawText, withGroupOptions(ctx, options));
}

export async function buildGroupCommandReplyAsync(ctx, options = {}) {
  if (!ctx?.isAtMe) return null;
  return await buildCommandReplyAsync(ctx.text || ctx.rawText, withGroupOptions(ctx, options));
}

export function buildPrivateCommandReply(ctx, options = {}) {
  return buildCommandReply(ctx?.text || "", {
    ...options,
    userId: ctx?.user_id,
  });
}

export async function buildPrivateCommandReplyAsync(ctx, options = {}) {
  return await buildCommandReplyAsync(ctx?.text || "", {
    ...options,
    userId: ctx?.user_id,
  });
}

function buildGroupSummarySyncReply(options) {
  if (!isAdminUser(options.userId, options.admins)) return "这个命令需要管理员权限。";
  return "日报命令需要异步处理，请在群聊或私聊中直接发送命令。";
}

function withGroupOptions(ctx, options) {
  return {
    ...options,
    userId: ctx.user_id,
    groupId: ctx.group_id,
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
    mentions: ctx.mentions || [],
    mentionedUsers: ctx.mentionedUsers || [],
  };
}

function capabilityOptions(options) {
  return {
    ...options,
    surface: options.groupId ? "group" : "private",
  };
}
