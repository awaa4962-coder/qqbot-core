import { callTaskApi } from "./api-providers/gateway.mjs";
import { createModelTaskBudget } from "./api-providers/task-budget.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { assertChatRunCurrent, chatRunSignal } from "./cognition/chat-run.mjs";
const NO_CACHE = Object.freeze({ get: () => "", set: () => {} });

export async function callVisionText(request, options = {}) {
  const callSlot = options.callSlot || callTaskApi;
  const positions = options.positions || ["primary", "fallback"];
  const failures = [];
  const cache = options.cache || NO_CACHE;
  const budget = options.prepareRequest ? null : createModelTaskBudget("sticker_vision", {
    now: options.budgetClock, signal: globalThis.AbortSignal.any([options.signal, request.signal, chatRunSignal()].filter(Boolean)),
    assertCurrent: options.assertCurrent,
  });
  const prepareRequest = options.prepareRequest || budget.prepare;
  const check = () => ensureCurrent(budget?.assertCurrent || options.assertCurrent);
  let currentPosition = "";
  try {
    for (const position of positions) {
      currentPosition = position;
      check();
      const result = await tryVisionSlot(request, position, { callSlot, cache, prepareRequest, check, config: options.config }, failures);
      check();
      if (result) return result;
    }
  } catch (error) {
    if (error?.code !== "MODEL_TASK_BUDGET") throw error;
    failures.push({ position: currentPosition, reason: error.message });
    return { ok: false, text: "", provider: "", position: "", failures, reason: error.message };
  }
  return { ok: false, text: "", provider: "", position: "", failures };
}

async function tryVisionSlot(request, position, hooks, failures) {
  const cached = hooks.cache.get(position);
  if (cached) {
    hooks.check();
    return { ok: true, text: cached, provider: "", position, failures, cached: true };
  }
  const slotRequest = hooks.prepareRequest(request, position);
  const result = await hooks.callSlot("vision", position, slotRequest, hooks.config ? { config: hooks.config } : {});
  hooks.check();
  if (!result?.ok) {
    failures.push({ position, reason: result?.error || "provider_unavailable" });
    return null;
  }
  const packet = buildOutputPacket(result.raw, { provider: result.provider, imagePayloads: requestImagePayloads(request) });
  hooks.check();
  if (!packet.ok) {
    failures.push({ position, reason: packet.risks?.[0] || "output_unusable" });
    return null;
  }
  hooks.cache.set(position, packet.text);
  return { ok: true, text: packet.text, provider: result.provider, position, failures };
}

function ensureCurrent(check) { assertChatRunCurrent(); check?.(); }

function requestImagePayloads(request) {
  return (request.messages || []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "image_url").map(part => part.image_url?.url).filter(Boolean) : []);
}
