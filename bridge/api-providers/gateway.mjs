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
    const prepared = withBotSelfContext(request, provider, options);
    if (request.promptMetadata) traceStage("context", { status: "ok", ...request.promptMetadata,
      inputTextChars: measurePromptText(prepared.request.messages) });
    if (prepared.snapshot) traceStage("model", { provider: provider.id, task: options.usageTask,
      position: options.usagePosition, selfFactsVersion: prepared.snapshot.version,
      capabilityCount: prepared.snapshot.capabilityCount, model: prepared.snapshot.model });
    const result = await adapter(provider, key, prepared.request);
    if (!result.ok) {
      logE("api-provider", provider.id, "failed:", result.error);
      return { ...result, provider: provider.id, raw: null };
    }
    recordSuccessfulUsage(provider, request, result, options);
    log("api-provider", provider.id, "ok", result.durationMs + "ms");
    return { ...result, provider: provider.id };
  } catch (error) {
    logE("api-provider", providerId, "error:", error.message);
    return failed(providerId, error.message);
  }
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

function recordSuccessfulUsage(provider, request, result, options) {
  recordApiUsage({
    provider: provider.id,
    task: options.usageTask || request.usageContext?.task || "direct",
    position: options.usagePosition || request.usageContext?.position || "direct",
    // Keep actual cost without restoring the forgotten user's usage association.
    userId: chatRunPrivacyChanged() ? undefined : request.usageContext?.userId,
    usage: result.raw?.usage || result.data?.usage || result.usage,
    durationMs: result.durationMs,
  }, {
    dir: options.usageMetricsDir,
    salt: options.usageMetricsSalt,
  });
}
