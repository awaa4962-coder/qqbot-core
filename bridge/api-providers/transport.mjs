import { buildBearerAuth } from "../clients/auth.mjs";
import { validateProviderEndpoint } from "./store.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { redactProviderPayload } from "./request-privacy.mjs";
import { chatRunSignal, chatRunStopReason } from "../cognition/chat-run.mjs";
import { normalizeUsage } from "./usage-values.mjs";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function postProviderJson(provider, key, body, options = {}) {
  const endpoint = validateProviderEndpoint(provider);
  const headers = buildProviderHeaders(provider, key);
  const startedAt = monotonicNow();
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 2)));
  const safeBody = redactProviderPayload(body);
  let outcome = null;
  let transportAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reason = chatRunStopReason() || requestStopReason(options);
    if (reason) return { ok: false, cancelled: true, error: reason, status: 0, transportAttempts, durationMs: Math.max(0, monotonicNow() - startedAt) };
    const attemptStarted = monotonicNow();
    outcome = await postProviderJsonOnce(endpoint, headers, safeBody, provider, options);
    transportAttempts++;
    reportAttempt(options, outcome, monotonicNow() - attemptStarted);
    if (outcome.ok || !shouldRetry(outcome, attempt, maxAttempts)) break;
    await delay(Math.max(0, Number(options.retryDelayMs ?? 400)) * attempt);
  }
  return { ...outcome, transportAttempts, durationMs: Math.max(0, monotonicNow() - startedAt) };
}

function reportAttempt(options, outcome, durationMs) {
  try { options.onUsageAttempt?.({ status: outcome.ok ? "ok" : "error", durationMs,
    usage: normalizeUsage(outcome.data?.usage || outcome.data?.usageMetadata || outcome.usage) }); } catch { /* Metrics cannot break delivery. */ }
}

async function postProviderJsonOnce(endpoint, headers, body, provider, options) {
  let status = 0;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestSignal(options.timeoutMs || 30000, options.signal),
    });
    status = Number(response.status || 0);
    const data = await readResponseJson(response, options.maxResponseBytes);
    if (response.ok === false) {
      return {
        ok: false,
        status: response.status,
        error: provider.name + " HTTP " + response.status + formatErrorSuffix(data),
        usage: normalizeUsage(data?.usage || data?.usageMetadata),
        durationMs: 0,
      };
    }
    return {
      ok: true,
      status: response.status,
      data,
      durationMs: 0,
    };
  } catch (error) {
    return {
      ok: false,
      status,
      error: safeTransportError(error),
      invalidResponse: error?.code === "INVALID_PROVIDER_JSON",
      responseTooLarge: error?.code === "PROVIDER_RESPONSE_LIMIT",
      durationMs: 0,
    };
  }
}

function requestSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const chatSignal = chatRunSignal();
  return AbortSignal.any([timeout, chatSignal, external].filter(Boolean));
}

function requestStopReason(options) {
  try { return options.beforeAttempt?.() || ""; }
  catch { return "tool_budget"; }
}

function shouldRetry(outcome, attempt, maxAttempts) {
  if (outcome.responseTooLarge) return false;
  if (attempt >= maxAttempts) return false;
  const status = Number(outcome?.status || 0);
  return status === 0 || RETRYABLE_STATUS.has(status) ||
    (status >= 200 && status < 300 && outcome.invalidResponse === true);
}

export function buildProviderHeaders(provider, key) {
  const headers = { "Content-Type": "application/json" };
  if (provider.auth === "none") return headers;
  if (!key) throw new Error(provider.name + " 缺少 API Key");
  if (provider.auth === "bearer") headers.Authorization = buildBearerAuth(key);
  if (provider.auth === "x-api-key") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  }
  if (provider.auth === "x-goog-api-key") headers["x-goog-api-key"] = key;
  if (provider.auth === "api-key") headers["api-key"] = key;
  return headers;
}

async function readResponseJson(response, maxBytes) {
  try {
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    const data = await readResponseData(response, limit);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid response shape");
    return data;
  } catch (cause) {
    if (cause?.code === "PROVIDER_RESPONSE_LIMIT") throw cause;
    const error = new Error("接口未返回有效 JSON 对象");
    error.code = "INVALID_PROVIDER_JSON";
    throw error;
  }
}

async function readResponseData(response, limit) {
  if (limit && response.body?.getReader) return JSON.parse(await readBoundedStream(response.body, limit));
  if (typeof response.text === "function") {
    const text = await response.text();
    if (limit && Buffer.byteLength(text) > limit) throw responseLimit();
    return JSON.parse(text);
  }
  const data = await response.json();
  if (limit && Buffer.byteLength(JSON.stringify(data)) > limit) throw responseLimit();
  return data;
}

async function readBoundedStream(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        Promise.resolve(reader.cancel()).catch(() => {});
        throw responseLimit();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { reader.releaseLock(); }
}

function responseLimit() { return Object.assign(new Error("模型接口响应超过接收大小上限"), { code: "PROVIDER_RESPONSE_LIMIT" }); }

function formatErrorSuffix(data) {
  const categories = { invalid_api_key: "认证失败", rate_limit_exceeded: "请求频率超过限制", insufficient_quota: "额度不足",
    context_length_exceeded: "上下文超过上限", invalid_request_error: "请求参数无效", model_not_found: "模型不可用" };
  const code = data?.error?.code || data?.error?.type;
  return Object.hasOwn(categories, code) ? ": " + categories[code] : "";
}

function safeTransportError(error) {
  const message = String(error?.message || error || "request failed");
  if (/redirect/i.test(message)) return "API 拒绝重定向，防止 Key 被转发到其他地址";
  if (/timeout|aborted/i.test(message)) return "API 请求超时";
  if (error?.code === "INVALID_PROVIDER_JSON") return "接口未返回有效 JSON 对象";
  if (error?.code === "PROVIDER_RESPONSE_LIMIT") return "模型接口响应超过接收大小上限";
  return "API 网络请求失败";
}
