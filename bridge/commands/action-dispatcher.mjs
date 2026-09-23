import { CFG } from "../config.mjs";
import { handleWordcloudCommand, parseWordcloudCommand } from "../features/wordcloud/index.mjs";
import { handleJmTransferCommand, parseJmCommand } from "../jm-provider.mjs";
import { sendMsg } from "../napcat.mjs";
import { handleExplicitLinkPreviewCommand, parseExplicitLinkPreviewCommand } from "../reply-handlers.mjs";
import { handleResourceTransferCommand, parseResourceTransferCommand } from "../resource-transfer.mjs";
import { groupChats, logGroupMsg, users } from "../storage.mjs";
import { buildCommandReplyAsync } from "./dispatcher.mjs";
import { prepareCommandText } from "./normalize.mjs";
import { isKnownCommand } from "./registry.mjs";
import { isSuccessfulOutbound } from "../cognition/outcome.mjs";
import { traceStage } from "../diagnostics/message-trace.mjs";
import { handleConversationSummaryCommand, parseConversationSummaryCommand } from "../features/conversation-summary/index.mjs";
import { createMemoryCommandGuard, isSelfMemoryCommand } from "./modules/memory.mjs";

const SPECIAL_GROUP_ACTIONS = Object.freeze([
  { id: "conversation-summary", parse: parseConversationSummaryCommand, handle: handleConversationSummaryCommand },
  { id: "jm", parse: parseJmCommand, handle: handleJmTransferCommand },
  { id: "resource-transfer", parse: parseResourceTransferCommand, handle: handleResourceTransferCommand },
  { id: "link-preview", parse: parseExplicitLinkPreviewCommand, handle: handleExplicitLinkPreviewCommand },
  { id: "wordcloud", parse: parseWordcloudCommand, handle: handleWordcloudCommand },
]);

export function matchSpecialGroupAction(commandText) {
  for (const action of SPECIAL_GROUP_ACTIONS) {
    const parsed = action.parse(commandText, { requireMention: false });
    if (parsed) return { id: action.id, parsed, handle: action.handle };
  }
  return null;
}

// Classification only: actual dispatch retains its own permission checks.
export function isCommandContext(ctx) {
  if (ctx.message_type === "group" && !ctx.isAtMe) return false;
  const text = prepareCommandText(ctx.text || ctx.rawText, { requireMention: ctx.message_type === "group" });
  if (isKnownCommand(text)) return true;
  return ctx.message_type === "group" ? Boolean(matchSpecialGroupAction(text)) : Boolean(parseJmCommand(text, { requireMention: false }));
}

export async function dispatchGroupCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const commandText = commandTextFromContext(ctx, options);
  if (!commandText) return false;

  const action = matchSpecialGroupAction(commandText);
  if (action) return await executeSpecialGroupAction(action, ctx, commandText, options);
  return await dispatchCatalogCommand(ctx, commandText, options);
}

function commandTextFromContext(ctx, options) {
  return prepareCommandText(ctx.text || ctx.rawText, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
}

async function executeSpecialGroupAction(action, ctx, commandText, options) {
  traceStage("route", { status: "ok", route: action.id });
  return await action.handle(ctx, {
    ...options,
    commandText,
    parsedCommand: action.parsed,
    replyToId: options.replyToId ?? ctx.message_id,
  });
}

async function dispatchCatalogCommand(ctx, commandText, options) {
  const memoryGuard = catalogMemoryGuard(ctx, commandText, options);
  const reply = await buildCommandReplyAsync(commandText, {
    ...options,
    users: options.users || users,
    groupChats: options.groupChats || groupChats,
    userId: ctx.user_id,
    groupId: ctx.group_id,
    surface: "group",
    messageId: ctx.message_id,
    contextPrivacyGeneration: ctx.contextPrivacyGeneration,
    memoryGuard,
    requireMention: false,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
    mentions: ctx.mentions || [],
    mentionedUsers: ctx.mentionedUsers || [],
  });
  if (!reply) return false;
  traceStage("route", { status: "ok", route: "command" });

  const sender = options.sender || sendMsg;
  if (memoryGuard?.stopReason()) return true;
  const receipt = await sendCatalogReply(sender, ctx.group_id, reply, options.replyToId ?? ctx.message_id, memoryGuard);
  const recordCommand = options.recordCommand || logGroupMsg;
  if (isSuccessfulOutbound(receipt)) recordCommand(ctx.group_id, "夜星", "[command]", CFG.selfUin, "assistant");
  return true;
}

function catalogMemoryGuard(ctx, commandText, options) {
  return isSelfMemoryCommand(commandText) ? createMemoryCommandGuard({ ...options, userId: ctx.user_id,
    groupId: ctx.group_id, surface: "group", contextPrivacyGeneration: ctx.contextPrivacyGeneration }) : null;
}

function sendCatalogReply(sender, groupId, reply, replyTo, guard) {
  return guard ? sender(groupId, reply, replyTo, { stopReason: guard.stopReason }) : sender(groupId, reply, replyTo);
}
