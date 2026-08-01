import { CFG } from "../config.mjs";
import { handleWordcloudCommand, parseWordcloudCommand } from "../features/wordcloud/index.mjs";
import { handleJmTransferCommand, parseJmCommand } from "../jm-provider.mjs";
import { sendMsg } from "../napcat.mjs";
import { handleExplicitLinkPreviewCommand, parseExplicitLinkPreviewCommand } from "../reply-handlers.mjs";
import { handleResourceTransferCommand, parseResourceTransferCommand } from "../resource-transfer.mjs";
import { groupChats, logGroupMsg, users } from "../storage.mjs";
import { buildCommandReplyAsync } from "./dispatcher.mjs";
import { prepareCommandText } from "./normalize.mjs";

const SPECIAL_GROUP_ACTIONS = Object.freeze([
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
  return await action.handle(ctx, {
    ...options,
    commandText,
    parsedCommand: action.parsed,
    replyToId: options.replyToId ?? ctx.message_id,
  });
}

async function dispatchCatalogCommand(ctx, commandText, options) {
  const reply = await buildCommandReplyAsync(commandText, {
    ...options,
    users: options.users || users,
    groupChats: options.groupChats || groupChats,
    userId: ctx.user_id,
    groupId: ctx.group_id,
    requireMention: false,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
    mentions: ctx.mentions || [],
    mentionedUsers: ctx.mentionedUsers || [],
  });
  if (!reply) return false;

  const sender = options.sender || sendMsg;
  await sender(ctx.group_id, reply, options.replyToId ?? ctx.message_id);
  const recordCommand = options.recordCommand || logGroupMsg;
  recordCommand(ctx.group_id, "夜星", "[command]", CFG.selfUin, "assistant");
  return true;
}
