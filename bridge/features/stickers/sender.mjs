import { classifyOutboundDelivery } from "../../cognition/outcome.mjs";
import { assertChatRunCurrent, checkChatSendDestination } from "../../cognition/chat-run.mjs";
import { sendMsg, sendPrivateMsg } from "../../napcat.mjs";
import { createStickerPrivacyGuard } from "./privacy.mjs";
import { getStickerSendMaterials } from "./schema.mjs";
import { normalizeStickerReplyReason } from "./reply-status.mjs";

export async function sendStickerDecision(decision, context = {}, options = {}) {
  const privacyGuard = createStickerPrivacyGuard(context.userId);
  const check = () => {
    assertChatRunCurrent();
    privacyGuard();
    if (options.signal?.aborted) throw Object.assign(new Error("task_cancelled"), { code: "CHAT_CANCELLED", name: "AbortError" });
    options.assertCurrent?.();
    const allowed = options.ensureAllowed?.();
    if (allowed === false || typeof allowed === "string" && allowed) throw Object.assign(new Error("task_cancelled"), { code: "CHAT_CANCELLED" });
    if (options.stopReason?.()) throw Object.assign(new Error("task_cancelled"), { code: "CHAT_CANCELLED" });
    const destination = checkChatSendDestination(context.private ? "private" : "group", context.private ? context.userId : context.groupId);
    if (destination.reason) throw Object.assign(new Error(destination.reason), { code: "CHAT_CANCELLED" });
  };
  check();
  if (decision?.action !== "send" || !decision.sticker) {
    return { ok: false, skipped: true, error: "no_match", result: null, status: "skipped", reasonCode: "no_match" };
  }
  const sticker = decision.sticker;
  const segment = buildStickerSegment(sticker);
  if (!segment) return { ok: false, skipped: true, error: "invalid_sticker", result: null, status: "skipped", reasonCode: "invalid_sticker" };
  const sendGroup = options.sendGroup || sendMsg;
  const sendPrivate = options.sendPrivate || sendPrivateMsg;
  const sendOptions = { maxAttempts: 1, stopReason: () => {
    try { check(); return ""; }
    catch (error) { return stickerGuardStopReason(error); }
  } };
  const send = async part => {
    check();
    let result;
    try {
      result = context.private
        ? await sendPrivate(context.userId, [part], sendOptions)
        : await sendGroup(context.groupId, [part], undefined, sendOptions);
    } catch {
      // A thrown transport error can follow acceptance. It is not a rejection receipt.
      result = { status: "unknown", delivery: "unconfirmed" };
    }
    // Preserve the physical receipt even when permission or privacy changed in flight.
    let guardStopped = false;
    try { check(); } catch { guardStopped = true; }
    return { result, guardStopped };
  };
  let outcome = await send(segment);
  let status = classifyOutboundDelivery(outcome.result);
  if (!outcome.guardStopped && segment.type === "mface" && status === "failed") {
    try {
      check();
      const image = buildStickerSegment({ ...sticker, key: "" });
      if (image?.type === "image") {
        outcome = await send(image);
        status = classifyOutboundDelivery(outcome.result);
      }
    } catch { outcome.guardStopped = true; }
  }
  return stickerSendOutcome(outcome, status);
}

function stickerSendOutcome(outcome, status) {
  const reasonCode = ({ sent: "sent", partial: "send_partial", failed: "send_failed", cancelled: "send_cancelled" })[status] || "send_unknown";
  return { ok: status === "sent", skipped: false, error: status === "sent" ? "" : reasonCode,
    result: outcome.result, status, reasonCode, guardStopped: outcome.guardStopped };
}

function stickerGuardStopReason(error) {
  if (error?.code === "STICKER_PRIVACY_CHANGED") return "privacy_changed";
  const reason = normalizeStickerReplyReason(error?.reasonCode ?? error?.code);
  if (reason !== "unknown_reason") return reason;
  const messageReason = normalizeStickerReplyReason(error?.message);
  return messageReason !== "unknown_reason" ? messageReason : "task_cancelled";
}

export function buildStickerSegment(sticker = {}) {
  const materials = getStickerSendMaterials(sticker);
  if (materials?.mface) {
    const mface = materials.mface;
    return {
      type: "mface",
      data: {
        emoji_id: mface.emojiId,
        emoji_package_id: mface.packageId,
        key: mface.key,
        summary: mface.summary,
      },
    };
  }
  if (!materials?.url) return null;
  return {
    type: "image",
    data: {
      file: materials.url,
      summary: materials.summary,
    },
  };
}
