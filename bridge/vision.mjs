import { callVisionText } from "./vision-provider.mjs";
import { prepareVisionImages } from "./vision/images.mjs";
import { visionDescriptionCache, visionDescriptionIdentityKey } from "./vision/description-cache.mjs";
import { visionDescriptionFlights } from "./vision/description-flight.mjs";
import { getTaskRoute, getProvider, loadApiConfig } from "./api-providers/store.mjs";
import { createModelTaskBudget } from "./api-providers/task-budget.mjs";
import { assertChatRunCurrent, chatRunSignal, currentChatScope, runWithoutChatContext } from "./cognition/chat-run.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "./memory-profile/generation.mjs";
import { createHash } from "node:crypto";
import { VISION_PROMPT_VERSION, buildObjectiveVisionMessages } from "./system-prompts/vision.mjs";

export { VISION_PROMPT_VERSION };

// Compatibility entry point; chat uses one prepared session shared by both slots.
export async function tryMiMoVision(imageUrls, options = {}) {
  if (!imageUrls?.length) return null;
  const prepared = await prepareVisionImages(imageUrls, { signal: chatRunSignal(), assertCurrent: assertChatRunCurrent });
  const result = await describeVisionImages(prepared, options);
  return result.text || null;
}

export async function describeVisionImages(prepared, options = {}) {
  const check = options.assertCurrent || assertChatRunCurrent;
  check();
  if (!prepared.images.length) return { ok: false, text: "", cached: false, reason: "no_images" };
  const config = options.config || loadApiConfig();
  const route = getTaskRoute("vision", { config });
  const positions = ["primary", "fallback"].filter(position => {
    const provider = getProvider(route[position], { config });
    return provider && provider.enabled !== false && provider.capabilities.includes("vision");
  });
  const identities = snapshotIdentities(prepared, options.scope || currentChatScope(), config, route, positions);
  const identity = position => identities.get(position);
  const signal = globalThis.AbortSignal.any([options.signal, chatRunSignal()].filter(Boolean));
  const budget = createModelTaskBudget("vision", { now: options.budgetClock, signal, assertCurrent: check });
  const privacy = getMemoryPrivacyGeneration();
  const scope = options.scope || currentChatScope();
  const revision = getUserMemoryGeneration(scope?.userId);
  const keys = positions.map(position => visionDescriptionIdentityKey(identity(position)));
  const key = descriptionFlightKey(keys, privacy, revision);
  const settings = { config, positions, identity, options };
  try {
    budget.assertCurrent();
    const cached = readPrimaryCache(positions, identity, budget.assertCurrent);
    if (cached) return cached;
    if (!key) return await generateObjectiveDescription(prepared, settings, budget);
    const snapshot = { ...prepared, images: prepared.images.map(image => ({ ...image,
      content: { type: image.content.type, image_url: { ...image.content.image_url } } })) };
    const result = await visionDescriptionFlights.run(key, (sharedSignal, requireWaiter) => runWithoutChatContext(() => {
      const sharedBudget = createModelTaskBudget("vision", { now: options.budgetClock, signal: sharedSignal,
        assertCurrent: () => {
          requireWaiter();
          if (privacy !== getMemoryPrivacyGeneration() || revision !== getUserMemoryGeneration(scope?.userId)) {
            throw Object.assign(new Error("privacy_changed"), { code: "VISION_SHARED_STOPPED" });
          }
        },
      });
      return generateObjectiveDescription(snapshot, settings, sharedBudget);
    }), { signal, assertCurrent: budget.assertCurrent });
    budget.assertCurrent();
    return result.shared ? { ...result.value, shared: true } : result.value;
  } catch (error) {
    if (!["MODEL_TASK_BUDGET", "VISION_SHARED_STOPPED"].includes(error?.code)) throw error;
    return { ok: false, text: "", cached: false, reason: error.message };
  }
}

function snapshotIdentities(prepared, scope, config, route, positions) {
  return new Map(positions.map(position => {
    try {
      return [position, globalThis.structuredClone({ scope, digests: prepared.images.map(image => image.digest),
        provider: { ...getProvider(route[position], { config }), reasoning: route.reasoning,
          imageLayout: prepared.images.map(({ index, width, height, animated }) => ({ index, width, height, animated })) },
        promptVersion: VISION_PROMPT_VERSION })];
    } catch { return [position, null]; }
  }));
}

function descriptionFlightKey(keys, privacy, revision) {
  return keys.length && keys.every(Boolean) ? createHash("sha256").update(JSON.stringify([keys, privacy, revision])).digest("hex") : "";
}

function readPrimaryCache(positions, identity, check) {
  if (!positions.length || !visionDescriptionCache.peek(identity(positions[0]))) return null;
  check();
  const text = visionDescriptionCache.get(identity(positions[0]));
  check();
  return text ? { ok: true, text, cached: true, reason: "ready" } : null;
}

async function generateObjectiveDescription(prepared, { config, positions, identity, options }, budget) {
  const result = await callVisionText({
    messages: buildObjectiveVisionMessages(prepared),
    maxTokens: 512, temperature: 0.2, timeoutMs: 20000, maxAttempts: 1, maxResponseBytes: 262144,
    usageContext: options.usageContext, promptMetadata: { promptVersion: VISION_PROMPT_VERSION },
  }, { config, positions, callSlot: options.callSlot, prepareRequest: budget.prepare, assertCurrent: budget.assertCurrent, cache: {
    get: position => visionDescriptionCache.get(identity(position)),
    set: (position, text) => { budget.assertCurrent(); visionDescriptionCache.set(identity(position), text); },
  } });
  budget.assertCurrent();
  return { ok: result.ok, text: result.ok ? result.text : "", cached: result.cached === true,
    reason: result.ok ? "ready" : result.reason || "vision_unavailable" };
}
