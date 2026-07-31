// bridge/reply.mjs - thin event router for group/private reply modules.
import { CFG } from "./config.mjs";
import { canProcessEvent, incProcessingCount, decProcessingCount } from "./logger.mjs";
import { parseIncomingEvent } from "./reply-handlers.mjs";
import { handleGroupMessage } from "./reply-group.mjs";
import { handlePrivateMessage } from "./reply-private.mjs";

export {
  aiReply,
  maybeGenerateProfile,
  shouldGenerateProfile,
} from "./reply-ai.mjs";
export {
  buildReplyState,
} from "./reply-group.mjs";
export {
  privateReply,
  tryDeepSeekFriend,
} from "./reply-private.mjs";

export async function processEvent(ev) {
  if (!ev) return;

  const ctx = parseIncomingEvent(ev);
  if (!isMessageEvent(ctx)) return;
  if (!canProcessEvent()) return;

  if (CFG.botBlacklist.includes(ctx.user_id)) return;

  incProcessingCount();
  try {
    // ── 私聊 ──
    if (ctx.message_type === "private") {
      await handlePrivateMessage(ctx);
      return;
    }

    // ── 群消息 ──
    if (ctx.message_type === "group") {
      await handleGroupMessage(ctx, ev.message);
      return;
    }
  } finally {
    decProcessingCount();
  }
}

// ── 私聊处理 ──
export function isMessageEvent(ctx) {
  return ctx?.message_type === "private" || ctx?.message_type === "group";
}
