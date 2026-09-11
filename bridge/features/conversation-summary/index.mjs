import { parseConversationSummaryCommand } from "./command.mjs";
import { conversationSummaryService } from "./service.mjs";

export { parseConversationSummaryCommand, isConversationSummaryCommand, conversationSummaryHelp } from "./command.mjs";

export async function handleConversationSummaryCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = options.parsedCommand || parseConversationSummaryCommand(ctx.text || ctx.rawText, options);
  if (!parsed) return false;
  return await (options.service || conversationSummaryService).handle(ctx, parsed);
}
