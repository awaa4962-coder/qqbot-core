// bridge/features/index.mjs - feature command entrypoint.

import { handleWordcloudCommand } from "./wordcloud/index.mjs";
import { handleConversationSummaryCommand } from "./conversation-summary/index.mjs";

export async function handleFeatureCommand(ctx, options = {}) {
  if (await handleConversationSummaryCommand(ctx, options)) return true;
  if (await handleWordcloudCommand(ctx, options)) return true;
  return false;
}
