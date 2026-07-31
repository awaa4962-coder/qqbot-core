// bridge/features/index.mjs - feature command entrypoint.

import { handleWordcloudCommand } from "./wordcloud/index.mjs";

export async function handleFeatureCommand(ctx, options = {}) {
  if (await handleWordcloudCommand(ctx, options)) return true;
  return false;
}
