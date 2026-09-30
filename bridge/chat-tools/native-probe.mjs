import { CFG } from "../config.mjs";
import { loadApiConfig, getProvider, getTaskRoute, readProviderSecret } from "../api-providers/store.mjs";
import { callApiProvider } from "../api-providers/gateway.mjs";
import { applyReasoningPolicy } from "../api-providers/reasoning-policy.mjs";
import { normalizeProviderUsage } from "../api-providers/usage-values.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { parseChatOutcome } from "../chat-outcome.mjs";
import { measureVisionRequest } from "../vision/request-budget.mjs";
import { CHAT_TOOL_LIMITS, parseToolArguments, safeToolBatch, validToolCallEnvelope } from "./policy.mjs";
import { CHAT_TOOL_REGISTRY } from "./registry.mjs";
import { calculate } from "./calculate.mjs";
import { assistantToolMessage } from "./runner.mjs";
import { buildNativeToolCompatibilitySnapshot, nativeToolIdentity, NATIVE_PROBE_MESSAGES, toolCompatibilityStore } from "./compatibility.mjs";

const POSITIONS = ["primary", "fallback"];
const EXPECTED = 56;

// Explicit administration only. Never called from ordinary chat or a model-selected tool.
export async function probeNativeChatTools(payload = {}, runtime = {}) {
  if (Object.keys(payload).some(key => key !== "action") || payload.action !== "probe") throw new Error("工具验证参数无效");
  const cfg = runtime.cfg || CFG;
  const root = cfg.configRoot;
  const config = runtime.config || loadApiConfig({ root });
  const store = runtime.store || toolCompatibilityStore(cfg);
  const clock = runtime.clock || monotonicNow;
  const started = clock();
  const timer = globalThis.AbortSignal.timeout(CHAT_TOOL_LIMITS.durationMs);
  const signal = globalThis.AbortSignal.any([timer, runtime.signal].filter(Boolean));
  const context = { cfg, root, config, store, clock, started, signal, runtime, attempts: 0 };
  context.provenance = runtime.callProvider || process.env.NODE_ENV === "test" ? "qa" : "live";
  const slots = [];
  for (const position of POSITIONS) {
    runtime.onProgress?.("running");
    slots.push(await probeSlot(position, context));
  }
  const snapshot = buildNativeToolCompatibilitySnapshot({ cfg, store,
    config: runtime.currentConfig ? runtime.currentConfig() : loadApiConfig({ root }), provenance: context.provenance });
  return { ok: slots.every(slot => slot.status === "verified"), slots, snapshot,
    attempts: context.attempts, requestLimit: 4, sendsMessages: false, provenance: context.provenance };
}

async function probeSlot(position, context) {
  if (context.signal.aborted) return { position, status: "unknown", reason: "cancelled" };
  if (context.clock() - context.started >= CHAT_TOOL_LIMITS.durationMs) return { position, status: "unknown", reason: "probe_deadline" };
  const route = getTaskRoute("group_chat", { config: context.config });
  const provider = getProvider(route[position], { config: context.config });
  if (!provider) return { position, status: "unknown", reason: "provider_not_configured" };
  const identity = identityFor(provider, context);
  const claim = context.store.claim(identity);
  if (!claim.ok) return { position, ...publicProof(claim.record || context.store.read(identity)),
    ...(claim.record ? {} : { reason: claim.reason || "claim_busy" }) };
  const state = { position, provider, identity, claimId: claim.claimId, route, context, usage: [], calls: 0, started: context.clock() };
  let result;
  try {
    assertCurrent(state);
    const unsupported = providerRejection(provider, context);
    result = unsupported ? { status: "unsupported", reason: unsupported } : await roundtrip(state);
  } catch (error) {
    result = { status: "failed", reason: error?.code === "NATIVE_PROBE_STOPPED" ? error.message : "transport_unavailable" };
  }
  const durationMs = Math.max(0, Math.round(context.clock() - state.started));
  const saved = context.store.finish(identity, claim.claimId, { ...result, durationMs, usage: mergeUsage(state.usage) });
  return { position, ...publicProof(context.store.read(identity)),
    ...(saved ? {} : { status: "failed", reason: "proof_persistence_failed" }) };
}

function providerRejection(provider, context) {
  if (!provider.enabled || !provider.capabilities.includes("tools")) return "native_tools_not_declared";
  if (provider.protocol === "gemini-native") return "protocol_not_supported";
  if (provider.auth !== "none" && !readProviderSecret(provider, { root: context.root })) return "provider_not_configured";
  return "";
}

async function roundtrip(state) {
  const messages = NATIVE_PROBE_MESSAGES.map(message => ({ ...message }));
  const first = await modelRound(state, messages, 0);
  if (!first.ok) return { status: "failed", reason: "transport_unavailable" };
  const continuation = probeContinuation(first.raw, state.provider);
  if (continuation.error) return { status: "failed", reason: continuation.error };
  messages.push(...continuation.messages);
  const final = await modelRound(state, messages, 1);
  if (!final.ok) return { status: "failed", reason: "transport_unavailable" };
  if (truncated(final.raw)) return { status: "failed", reason: "truncated_response" };
  if (final.raw?.choices?.[0]?.message?.tool_calls?.length) return { status: "failed", reason: "unexpected_tool" };
  const outcome = parseChatOutcome(final.raw, { provider: state.provider.id });
  if (outcome.kind !== "reply") return { status: "failed", reason: "reply_unusable" };
  return /^\s*56[\s。.!！]*$/u.test(outcome.text)
    ? { status: "verified", reason: "" } : { status: "failed", reason: "wrong_answer" };
}

function probeContinuation(raw, provider) {
  const selected = probeCall(raw);
  if (selected.error) return selected;
  const { call, message } = selected;
  if (call.function.name !== "calculate") return { error: "unexpected_tool" };
  const args = parseToolArguments(call);
  const calculation = calculate(args);
  if (calculation.status !== "ok") return { error: "invalid_arguments" };
  if (args.expression.replace(/[ \t\r\n]+/g, "") !== "17*3+5") return { error: "expression_mismatch" };
  if (calculation.result !== EXPECTED) return { error: "tool_result_wrong" };
  return { messages: [assistantToolMessage(message, provider), { role: "tool", tool_call_id: call.id, content: JSON.stringify(calculation) }] };
}

function probeCall(raw) {
  if (truncated(raw)) return { error: "truncated_response" };
  const message = raw?.choices?.[0]?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return { error: "invalid_response_envelope" };
  const supplied = message.tool_calls;
  if (supplied === undefined || supplied === null || Array.isArray(supplied) && supplied.length === 0) return { error: noNativeCallReason(message) };
  if (!Array.isArray(supplied)) return { error: "invalid_call_envelope" };
  if (supplied.length !== 1) return { error: "multiple_calls" };
  return singleProbeCall(message);
}

function singleProbeCall(message) {
  if (!validToolCallEnvelope(message.tool_calls[0])) return { error: "invalid_call_envelope" };
  const argumentsText = message.tool_calls[0]?.function?.arguments;
  if (typeof argumentsText !== "string" || argumentsText.length > 2048) return { error: "invalid_arguments" };
  const calls = safeToolBatch(message);
  if (!calls) return { error: "invalid_call_envelope" };
  return { call: calls[0], message };
}

function truncated(raw) { return raw?.choices?.[0]?.finish_reason === "length"; }

function noNativeCallReason(message) {
  return typeof message.content === "string" && /^\s*56[\s。.!！]*$/u.test(message.content)
    ? "direct_answer_expected" : "no_native_call";
}

async function modelRound(state, messages, stage) {
  assertCurrent(state);
  const { context, provider, route } = state;
  const request = { messages, tools: stage === 0 ? CHAT_TOOL_REGISTRY.map(entry => entry.definition) : [],
    toolChoice: stage === 0 ? "auto" : "none", maxTokens: 512, temperature: 0,
    maxAttempts: 1, maxResponseBytes: CHAT_TOOL_LIMITS.responseBytes, signal: context.signal,
    timeoutMs: Math.max(1, Math.min(30000, Math.floor(CHAT_TOOL_LIMITS.durationMs - (context.clock() - context.started)))),
    promptMetadata: { promptVersion: "tool-probe-v1" }, beforeAttempt: () => reservePhysicalAttempt(state, stage),
    validatePrepared: value => validateWire(state, value) };
  const resolved = applyReasoningPolicy(provider, request, { task: "group_chat", mode: route.reasoning });
  const result = await (context.runtime.callProvider || callApiProvider)(provider.id, resolved.request, {
    config: context.config, root: context.root, provider, reasoningPolicy: resolved.meta, usageTask: "agent_tool_probe", usagePosition: state.position,
    usageMetricsDir: context.runtime.usageDir });
  state.usage.push({ ...normalizeProviderUsage(result.raw?.usage || result.usage),
    transportAttempts: Number.isInteger(result.transportAttempts) ? result.transportAttempts : null });
  state.calls++;
  assertCurrent(state);
  return result;
}

function reservePhysicalAttempt(state, stage) {
  assertCurrent(state);
  if (state.context.attempts >= 4 || !state.context.store.reserveAttempt(state.identity, state.claimId, stage)) return "probe_budget";
  state.context.attempts++;
  return "";
}

function validateWire(state, request) {
  assertCurrent(state);
  if (measureVisionRequest(request).chars > CHAT_TOOL_LIMITS.requestChars) stop("result_budget");
}

function assertCurrent(state) {
  const { context } = state;
  if (context.signal.aborted) stop("cancelled");
  const elapsed = context.clock() - context.started;
  if (elapsed < 0 || elapsed >= CHAT_TOOL_LIMITS.durationMs) stop("probe_deadline");
  const config = context.runtime.currentConfig ? context.runtime.currentConfig() : loadApiConfig({ root: context.root });
  const route = getTaskRoute("group_chat", { config });
  const provider = getProvider(route[state.position], { config });
  if (nativeToolIdentity(provider, { config, root: context.root, provenance: context.provenance }) !== state.identity) stop("configuration_changed");
}

function identityFor(provider, context) {
  return nativeToolIdentity(provider, { config: context.config, root: context.root, provenance: context.provenance });
}

function publicProof(value) {
  return { status: value.status || "unknown", reason: value.reason || "", attempts: value.attempts || 0,
    checkedAt: value.checkedAt || null, expiresAt: value.expiresAt || null, usage: value.usage || {}, durationMs: value.durationMs || 0 };
}

function mergeUsage(items) {
  const values = {};
  for (const key of ["promptTokens", "cachedTokens", "completionTokens", "reasoningTokens", "totalTokens"]) {
    values[key] = items.reduce((sum, item) => sum + (item[key] || 0), 0);
  }
  for (const key of ["usageReported", "cacheReported", "reasoningReported"]) values[key] = items.length > 0 && items.every(item => item[key]);
  values.transportAttempts = items.length && items.every(item => Number.isInteger(item.transportAttempts))
    ? items.reduce((sum, item) => sum + item.transportAttempts, 0) : null;
  return values;
}

function stop(reason) { throw Object.assign(new Error(reason), { code: "NATIVE_PROBE_STOPPED" }); }
