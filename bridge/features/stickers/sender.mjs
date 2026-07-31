import { isSuccessfulOutbound } from "../../cognition/index.mjs";
import { sendMsg, sendPrivateMsg } from "../../napcat.mjs";

export async function sendStickerDecision(decision, context = {}, options = {}) {
  if (decision?.action !== "send" || !decision.sticker) {
    return { ok: false, skipped: true, error: "no_match", result: null };
  }
  const sticker = decision.sticker;
  const segment = buildStickerSegment(sticker);
  if (!segment) return { ok: false, skipped: true, error: "invalid_sticker", result: null };
  const sendGroup = options.sendGroup || sendMsg;
  const sendPrivate = options.sendPrivate || sendPrivateMsg;
  const result = context.private
    ? await sendPrivate(context.userId, [segment])
    : await sendGroup(context.groupId, [segment]);
  return {
    ok: isSuccessfulOutbound(result),
    skipped: false,
    error: isSuccessfulOutbound(result) ? "" : "send_failed",
    result,
  };
}

export function buildStickerSegment(sticker = {}) {
  if (sticker.emojiId && sticker.packageId && sticker.key && sticker.key !== "configured") {
    return {
      type: "mface",
      data: {
        emoji_id: String(sticker.emojiId),
        emoji_package_id: String(sticker.packageId),
        key: String(sticker.key),
        summary: sticker.summary || "[表情]",
      },
    };
  }
  if (!sticker.url) return null;
  return {
    type: "image",
    data: {
      file: sticker.url,
      summary: sticker.summary || sticker.description || "[表情]",
    },
  };
}
