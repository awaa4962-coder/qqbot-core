import { isOutboundPayloadSuccessful } from "../outbound-message.mjs";

export function isSuccessfulOutbound(result) {
  if (Array.isArray(result)) {
    return result.length > 0 && result.every(isSuccessfulOutbound);
  }
  return isOutboundPayloadSuccessful(result);
}
