import { isOutboundPayloadSuccessful } from "../outbound-message.mjs";
import { classifyOneBotReceipt } from "../onebot-receipt.mjs";

export function classifyOutboundDelivery(result) {
  if (!Array.isArray(result)) return classifyOneBotReceipt(result);
  if (!result.length) return "unknown";
  const states = result.map(receipt => classifyOneBotReceipt(receipt));
  if (states.every(state => state === "sent")) return "sent";
  if (states.includes("sent")) return "partial";
  if (states.includes("unknown")) return "unknown";
  if (states.includes("cancelled")) return "cancelled";
  return "failed";
}

export function isSuccessfulOutbound(result) {
  if (Array.isArray(result)) {
    return result.length > 0 && result.every(isSuccessfulOutbound);
  }
  return isOutboundPayloadSuccessful(result);
}

export function confirmedOutboundMessageIds(result) {
  if (!isSuccessfulOutbound(result)) return [];
  const receipts = Array.isArray(result) ? result : [result];
  const ids = new Set();
  for (const receipt of receipts.slice(0, 16)) {
    const value = receipt?.data?.message_id ?? receipt?.message_id;
    if (typeof value === "number" && !Number.isSafeInteger(value)) continue;
    if (!["number", "string"].includes(typeof value) || !/^-?\d{1,20}$/.test(String(value))) continue;
    ids.add(String(value));
  }
  return [...ids];
}
