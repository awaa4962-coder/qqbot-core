import { callTaskApi } from "./api-providers/gateway.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";

export async function callVisionText(request, options = {}) {
  const callSlot = options.callSlot || callTaskApi;
  const positions = options.positions || ["primary", "fallback"];
  const failures = [];
  for (const position of positions) {
    const result = await callSlot("vision", position, request);
    if (!result?.ok) {
      failures.push({ position, reason: result?.error || "provider_unavailable" });
      continue;
    }
    const packet = buildOutputPacket(result.raw, { provider: result.provider });
    if (!packet.ok) {
      failures.push({ position, reason: packet.risks?.[0] || "output_unusable" });
      continue;
    }
    return {
      ok: true,
      text: packet.text,
      provider: result.provider,
      position,
      failures,
    };
  }
  return { ok: false, text: "", provider: "", position: "", failures };
}
