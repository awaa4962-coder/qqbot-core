// bridge/clients/llm-client.mjs — 统一 LLM 调用客户端
// 所有模型调用通过此层，统一 timeout、错误处理、返回结构
import { log, logE } from "../logger.mjs";

/**
 * 调用 LLM API
 * @param {Object} opts
 * @param {string} opts.provider - 提供商标识 (mimo|deepseek)
 * @param {string} opts.apiKey - API Key
 * @param {string} opts.endpoint - API endpoint URL
 * @param {string} opts.model - 模型名
 * @param {Array} opts.messages - 消息数组 [{role,content}]
 * @param {Object} [opts.extra] - 额外 body 字段 (tools, tool_choice 等)
 * @param {number} [opts.maxTokens=1024]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ok:boolean, text:string|null, raw:Object, provider:string}>}
 */
export async function llmCall(opts) {
  const {
    provider,
    apiKey,
    endpoint,
    model,
    messages,
    extra = {},
    maxTokens = 1024,
    temperature = 0.7,
    timeoutMs = 30000,
  } = opts;

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": "***" + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...extra,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!r.ok) {
      logE(`llmCall [${provider}] HTTP ${r.status}: ${r.statusText}`);
      return { ok: false, text: null, raw: null, provider, error: `HTTP ${r.status}` };
    }

    const d = await r.json();
    const choice = d?.choices?.[0];
    const text = choice?.message?.content || null;

    return { ok: true, text, raw: d, provider };
  } catch (e) {
    logE(`llmCall [${provider}] error:`, e.message);
    return { ok: false, text: null, raw: null, provider, error: e.message };
  }
}

/**
 * 简化版：单个消息调用
 */
export async function llmChat(provider, apiKey, endpoint, model, systemPrompt, userMessage, opts = {}) {
  return llmCall({
    provider,
    apiKey,
    endpoint,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    ...opts,
  });
}
