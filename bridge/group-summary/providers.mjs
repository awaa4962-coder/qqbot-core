import { log, logE } from "../logger.mjs";
import { MODEL_TASKS, callTaskProviderResult } from "../model-router.mjs";
import { buildOutputPacket } from "../output-pipeline.mjs";
import { buildSummaryDigest } from "./digest.mjs";
import { formatDate } from "./date.mjs";
import { createSummaryPlan } from "./generation-plans.mjs";

const SLOT_SETTINGS = Object.freeze({
  primary: { maxTokens: 8192, hint: "deepseek" },
  fallback: { maxTokens: 3072, hint: "mimo", reasoningMode: "economy" },
});

async function callSummarySlot(position, prompt, plan) {
  const slot = SLOT_SETTINGS[position];
  return await callTaskProviderResult(MODEL_TASKS.GROUP_SUMMARY, position, {
    task: MODEL_TASKS.GROUP_SUMMARY, systemPrompt: plan.systemPrompt,
    messages: [{ role: "user", content: prompt }],
    maxTokens: slot.maxTokens, temperature: 0.3, timeoutMs: 120000,
  }, { reasoningMode: slot.reasoningMode });
}

export async function generateGroupSummaryResult(messages, options = {}) {
  if (!messages.length) return { text: null, provider: "none", digest: null };
  const normalized = { ...options, dateText: options.dateText || formatDate() };
  const digest = options.digest || buildSummaryDigest(messages, normalized);
  const plan = createSummaryPlan(messages, normalized, digest);
  let failureReason = "model_unavailable";
  options.onProgress?.("analyzing");
  if (plan.shouldGenerate) {
    const generated = await generateFromSlots(plan, options);
    if (generated.text) return { ...generated, digest };
    failureReason = generated.reason;
  }
  if (plan.structured && !plan.lowData) return { text: null, provider: "none", reason: failureReason, digest };
  return { ...plan.local(), provider: plan.lowData ? "local-low-data" : "local-fallback", digest };
}

async function generateFromSlots(plan, options) {
  const prompt = plan.prompt();
  let reason = "model_unavailable";
  for (const position of ["primary", "fallback"]) {
    options.onProgress?.(position === "primary" ? "analyzing" : "fallback");
    const injected = position === "primary" ? options.callPrimarySummary : options.callFallbackSummary;
    const call = injected || (value => callSummarySlot(position, value, plan));
    const result = await trySummarySlot(call, prompt, position, SLOT_SETTINGS[position].hint);
    if (!result) continue;
    const rendered = plan.parse(result.text);
    if (rendered.ok) return { ...rendered.value, provider: result.provider };
    reason = rendered.reason;
    log("group summary " + position + " validation rejected:", JSON.stringify({ provider: result.provider, reason }));
  }
  return { text: null, reason };
}

export async function generateGroupSummary(messages, options = {}) {
  return (await generateGroupSummaryResult(messages, options)).text;
}

async function trySummarySlot(call, prompt, position, providerHint) {
  try {
    const value = await call(prompt);
    const result = normalizeCallResult(value, providerHint);
    if (!result.raw) {
      logE("group summary " + position + " unavailable:", result.error || "empty response");
      return null;
    }
    const packet = buildOutputPacket(result.raw, { provider: result.provider });
    log("group summary " + position + " packet:", JSON.stringify({
      provider: result.provider, ok: packet.ok, finishReason: packet.finishReason, risks: packet.risks, lengths: packet.lengths,
    }));
    return packet.ok && !packet.wasTruncated ? { text: packet.text, provider: result.provider } : null;
  } catch (error) { logE("group summary " + position + " failed:", error.message); return null; }
}

function normalizeCallResult(value, providerHint) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "raw")) {
    return {
      raw: value.ok === false ? null : value.raw,
      provider: String(value.provider || value.raw?.provider || providerHint), error: value.error || "",
    };
  }
  return { raw: value || null, provider: String(value?.provider || providerHint), error: "" };
}
