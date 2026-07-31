import { log, logE } from "../logger.mjs";
import { callAnthropicMessages } from "./adapters/anthropic-messages.mjs";
import { callGeminiNative } from "./adapters/gemini-native.mjs";
import { callOpenAiChat } from "./adapters/openai-chat.mjs";
import { callOpenAiResponses } from "./adapters/openai-responses.mjs";
import {
  getProvider,
  getTaskRoute,
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
  const provider = options.provider || getProvider(providerId, options);
  if (!provider || provider.enabled === false) return failed(providerId, "API 实例不存在或已停用");
  const adapter = ADAPTERS[provider.protocol];
  if (!adapter) return failed(provider.id, "没有可用的协议适配器");
  try {
    validateProviderEndpoint(provider);
    const key = options.key !== undefined ? String(options.key || "").trim() : readProviderSecret(provider, options);
    const result = await adapter(provider, key, request);
    if (!result.ok) {
      logE("api-provider", provider.id, "failed:", result.error);
      return { ...result, provider: provider.id, raw: null };
    }
    log("api-provider", provider.id, "ok", result.durationMs + "ms");
    return { ...result, provider: provider.id };
  } catch (error) {
    logE("api-provider", provider.id, "error:", error.message);
    return failed(provider.id, error.message);
  }
}

export async function callTaskApi(task, position, request = {}, options = {}) {
  const route = getTaskRoute(task, options);
  const slot = position === "fallback" ? "fallback" : "primary";
  const providerId = route[slot];
  if (!providerId) return failed("", "任务插槽未配置");
  return await callApiProvider(providerId, request, options);
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
