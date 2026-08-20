// bridge/reply.mjs - thin event router for group/private reply modules.
import { admitMessageContext } from "./event-admission.mjs";
import { incProcessingCount, decProcessingCount } from "./logger.mjs";
import { markEventFailed, markEventProcessed } from "./pipeline-state.mjs";
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
  if (!ev) return { ok: false, reason: "empty_event" };

  const ctx = parseIncomingEvent(ev);
  if (!isMessageEvent(ctx)) return { ok: false, reason: "not_message_event" };
  const admission = admitMessageContext(ctx);
  if (!admission.ok) return admission;

  incProcessingCount();
  try {
    // ── 私聊 ──
    if (ctx.message_type === "private") {
      await handlePrivateMessage(ctx);
      markEventProcessed();
      return { ...admission, route: "private" };
    }

    // ── 群消息 ──
    if (ctx.message_type === "group") {
      await handleGroupMessage(ctx, ev.message);
      markEventProcessed();
      return { ...admission, route: "group" };
    }
  } catch (error) {
    markEventFailed();
    throw error;
  } finally {
    decProcessingCount();
  }
  return { ok: false, reason: "unsupported_message_type" };
}

// ── 私聊处理 ──
export function isMessageEvent(ctx) {
  return ctx?.message_type === "private" || ctx?.message_type === "group";
}
