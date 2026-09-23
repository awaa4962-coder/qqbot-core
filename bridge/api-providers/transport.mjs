import { buildBearerAuth } from "../clients/auth.mjs";
import { validateProviderEndpoint } from "./store.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { redactProviderPayload } from "./request-privacy.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { chatRunSignal, chatRunStopReason } from "../cognition/chat-run.mjs";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function postProviderJson(provider, key, body, options = {}) {
  const endpoint = validateProviderEndpoint(provider);
  const headers = buildProviderHeaders(provider, key);
  const startedAt = monotonicNow();
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 2)));
  const safeBody = redactProviderPayload(body);
  let outcome = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reason = chatRunStopReason();
    if (reason) return { ok: false, cancelled: true, error: reason, status: 0, durationMs: Math.max(0, monotonicNow() - startedAt) };
    outcome = await postProviderJsonOnce(endpoint, headers, safeBody, provider, options);
    if (outcome.ok || !shouldRetry(outcome, attempt, maxAttempts)) break;
    await delay(Math.max(0, Number(options.retryDelayMs ?? 400)) * attempt);
  }
  return { ...outcome, durationMs: Math.max(0, monotonicNow() - startedAt) };
}

async function postProviderJsonOnce(endpoint, headers, body, provider, options) {
  let status = 0;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestSignal(options.timeoutMs || 30000),
    });
    status = Number(response.status || 0);
    const data = await readResponseJson(response);
    if (response.ok === false) {
      return {
        ok: false,
        status: response.status,
        error: provider.name + " HTTP " + response.status + formatErrorSuffix(data),
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
      durationMs: 0,
    };
  }
}

function requestSignal(timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const chatSignal = chatRunSignal();
  return chatSignal ? AbortSignal.any([timeout, chatSignal]) : timeout;
}

function shouldRetry(outcome, attempt, maxAttempts) {
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

async function readResponseJson(response) {
  try {
    const data = typeof response.text !== "function" && typeof response.json === "function"
      ? await response.json()
      : JSON.parse(await response.text());
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid response shape");
    return data;
  } catch {
    const error = new Error("接口未返回有效 JSON 对象");
    error.code = "INVALID_PROVIDER_JSON";
    throw error;
  }
}

function formatErrorSuffix(data) {
  const message = data?.error?.message || data?.message || "";
  const clean = redactSensitiveText(message).replace(/[\r\n]+/g, " ").slice(0, 180);
  return clean ? ": " + clean : "";
}

function safeTransportError(error) {
  const message = String(error?.message || error || "request failed");
  if (/redirect/i.test(message)) return "API 拒绝重定向，防止 Key 被转发到其他地址";
  if (/timeout|aborted/i.test(message)) return "API 请求超时";
  return redactSensitiveText(message).replace(/[\r\n]+/g, " ").slice(0, 180);
}
