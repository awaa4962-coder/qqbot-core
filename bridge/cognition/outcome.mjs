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
