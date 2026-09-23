import { log, logE } from "../logger.mjs";
import { callAnthropicMessages } from "./adapters/anthropic-messages.mjs";
import { callGeminiNative } from "./adapters/gemini-native.mjs";
import { callOpenAiChat } from "./adapters/openai-chat.mjs";
import { callOpenAiResponses } from "./adapters/openai-responses.mjs";
import { applyReasoningPolicy } from "./reasoning-policy.mjs";
import { normalizeProviderUsage, recordApiUsage } from "./usage-metrics.mjs";
import { traceStage } from "../diagnostics/message-trace.mjs";
import { withBotSelfContext } from "../capabilities/self-context.mjs";
import { chatRunPrivacyChanged, chatRunStopReason } from "../cognition/chat-run.mjs";
import { measurePromptText } from "../system-prompts/compose.mjs";
import { usageDimensions } from "./usage-aggregate.mjs";
import { getMemoryPrivacyGeneration } from "../memory-profile/generation.mjs";
import {
  getProvider,
  getTaskRoute,
  loadApiConfig,
  readProviderSecret,
  validateProviderEndpoint,
} from "./store.mjs";

const ADAPTERS = Object.freeze({
  "openai-chat": callOpenAiChat,
  "openai-responses": callOpenAiResponses,
  "anthropic-messages": callAnthropicMessages,
  "gemini-native": callGeminiNative,
});

export async function callApiProvider(providerId, request = {}, options = {}) {
  const metadata = { provider: providerId, task: options.usageTask, position: options.usagePosition };
  traceStage("model", { ...metadata, status: "started" });
  const result = await invokeApiProvider(providerId, request, options);
  const usage = normalizeProviderUsage(result.raw?.usage || result.usage);
  traceStage("model", {
    ...metadata, status: result.ok ? "ok" : "failed", httpStatus: Number(result.status || 0),
    promptTokens: usage.promptTokens, cachedTokens: usage.cachedTokens, completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
    usageReported: usage.usageReported, cacheReported: usage.cacheReported, promptReported: usage.promptReported,
    completionReported: usage.completionReported, reasoningReported: usage.reasoningReported, totalReported: usage.totalReported,
    ...result.usageIdentity,
  });
  return result;
}

async function invokeApiProvider(providerId, request = {}, options = {}) {
  try {
    if (chatRunStopReason()) return { ...failed(providerId, chatRunStopReason()), cancelled: true };
    const provider = options.provider || getProvider(providerId, options);
    if (!provider || provider.enabled === false) return failed(providerId, "API 实例不存在或已停用");
    const adapter = ADAPTERS[provider.protocol];
    if (!adapter) return failed(provider.id, "没有可用的协议适配器");
    validateProviderEndpoint(provider);
    const key = options.key !== undefined ? String(options.key || "").trim() : readProviderSecret(provider, options);
    const prepared = prepareContext(request, provider, options);
    if (request.promptMetadata) traceStage("context", { status: "ok", ...request.promptMetadata,
      inputTextChars: measurePromptText(prepared.request.messages) });
    if (prepared.snapshot) traceStage("model", { provider: provider.id, task: options.usageTask,
      position: options.usagePosition, selfFactsVersion: prepared.snapshot.version,
      capabilityCount: prepared.snapshot.capabilityCount, model: prepared.snapshot.model });
    const usageIdentity = callUsageIdentity(provider, request, options);
    const privacy = getMemoryPrivacyGeneration();
    const result = await adapter(provider, key, { ...prepared.request,
      onUsageAttempt: attempt => recordAttemptUsage(usageIdentity, request, attempt, options, privacy) });
    if (!result.ok) {
      logE("api-provider", provider.id, "failed:", result.error);
      return { ...result, provider: provider.id, raw: null, usageIdentity };
    }
    log("api-provider", provider.id, "ok", result.durationMs + "ms");
    return { ...result, provider: provider.id, usageIdentity };
  } catch (error) {
    logE("api-provider", providerId, "error:", error.message);
    return failed(providerId, error.message);
  }
}

function prepareContext(request, provider, options) {
  if (request.fitPreparedContext && provider.tokenField && Object.hasOwn(request.extra || {}, provider.tokenField)) throw new Error("tool_context_override");
  const prepared = withBotSelfContext(request, provider, options);
  if (request.fitPreparedContext) prepared.request = { ...prepared.request, messages: request.fitPreparedContext(prepared.request) };
  if (!request.fitPreparedContext) request.validatePrepared?.(prepared.request);
  return prepared;
}

export async function callTaskApi(task, position, request = {}, options = {}) {
  let config;
  try {
    config = options.config || loadApiConfig(options);
  } catch (error) {
    traceStage("model", { task, position, status: "failed", reason: "invalid_api_config" });
    return failed("", error.message);
  }
  const sharedOptions = { ...options, config };
  const route = getTaskRoute(task, sharedOptions);
  const slot = position === "fallback" ? "fallback" : "primary";
  const providerId = route[slot];
  if (!providerId) return failed("", "任务插槽未配置");
  const provider = getProvider(providerId, sharedOptions);
  const resolved = applyReasoningPolicy(provider, request, {
    task,
    mode: options.reasoningMode ?? route.reasoning,
  });
  const result = await callApiProvider(providerId, resolved.request, {
    ...sharedOptions,
    provider,
    usageTask: task,
    usagePosition: slot,
    reasoningPolicy: resolved.meta,
  });
  return { ...result, reasoningPolicy: resolved.meta };
}

export function providerSupports(providerId, capability, options = {}) {
  const provider = getProvider(providerId, options);
  return Boolean(provider?.capabilities?.includes(capability));
}

function failed(provider, error) {
  return {
    ok: false,
    provider: String(provider || ""),
    raw: null,
    status: 0,
    error: String(error || "API 调用失败"),
    durationMs: 0,
  };
}

function recordAttemptUsage(identity, request, attempt, options, privacy) {
  recordApiUsage({
    ...identity,
    status: attempt.status,
    transportAttempts: 1,
    // Keep actual cost without restoring the forgotten user's usage association.
    userId: chatRunPrivacyChanged() || privacy !== getMemoryPrivacyGeneration() ? undefined : request.usageContext?.userId,
    usage: attempt.usage,
    durationMs: attempt.durationMs,
  }, {
    dir: options.usageMetricsDir,
    salt: options.usageMetricsSalt,
  });
}

function callUsageIdentity(provider, request, options) {
  const policy = options.reasoningPolicy || {};
  return usageDimensions({ provider: provider.id, model: provider.model,
    task: options.usageTask || request.usageContext?.task || "direct",
    position: options.usagePosition || request.usageContext?.position || "direct",
    promptVersion: request.promptMetadata?.promptVersion, promptFingerprint: request.promptMetadata?.promptFingerprint,
    configuredMode: policy.configuredMode, reasoningControl: policy.control,
    reasoningApplied: typeof policy.applied === "boolean" ? policy.applied ? "yes" : "no" : "unknown",
    effectiveMode: effectiveReasoningMode(policy),
  });
}

function effectiveReasoningMode(policy) {
  if (policy.applied) return policy.effectiveMode;
  if (policy.control === "provider-default") return "provider_default";
  if (policy.control === "none") return "not_supported";
  return "unknown";
}
