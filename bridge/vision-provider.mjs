import { callTaskApi } from "./api-providers/gateway.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { assertChatRunCurrent } from "./cognition/chat-run.mjs";
const NO_CACHE = Object.freeze({ get: () => "", set: () => {} });

export async function callVisionText(request, options = {}) {
  const callSlot = options.callSlot || callTaskApi;
  const positions = options.positions || ["primary", "fallback"];
  const failures = [];
  const cache = options.cache || NO_CACHE;
  for (const position of positions) {
    ensureCurrent(options);
    const cached = cache.get(position);
    if (cached) return { ok: true, text: cached, provider: "", position, failures, cached: true };
    const result = await callSlot("vision", position, request, options.config ? { config: options.config } : {});
    ensureCurrent(options);
    if (!result?.ok) {
      failures.push({ position, reason: result?.error || "provider_unavailable" });
      continue;
    }
    const packet = buildOutputPacket(result.raw, { provider: result.provider, imagePayloads: requestImagePayloads(request) });
    if (!packet.ok) {
      failures.push({ position, reason: packet.risks?.[0] || "output_unusable" });
      continue;
    }
    cache.set(position, packet.text);
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

function ensureCurrent(options) { assertChatRunCurrent(); options.assertCurrent?.(); }

function requestImagePayloads(request) {
  return (request.messages || []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "image_url").map(part => part.image_url?.url).filter(Boolean) : []);
}
