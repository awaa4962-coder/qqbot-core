import { buildBearerAuth } from "../clients/auth.mjs";
import { validateProviderEndpoint } from "./store.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { setTimeout as delay } from "node:timers/promises";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function postProviderJson(provider, key, body, options = {}) {
  const endpoint = validateProviderEndpoint(provider);
  const headers = buildProviderHeaders(provider, key);
  const startedAt = monotonicNow();
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts || 2)));
  let outcome = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    outcome = await postProviderJsonOnce(endpoint, headers, body, provider, options);
    if (outcome.ok || !shouldRetry(outcome, attempt, maxAttempts)) break;
    await delay(Math.max(0, Number(options.retryDelayMs ?? 400)) * attempt);
  }
  return { ...outcome, durationMs: Math.max(0, monotonicNow() - startedAt) };
}

async function postProviderJsonOnce(endpoint, headers, body, provider, options) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    });
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
      status: 0,
      error: safeTransportError(error),
      durationMs: 0,
    };
  }
}

function shouldRetry(outcome, attempt, maxAttempts) {
  if (attempt >= maxAttempts) return false;
  return Number(outcome?.status || 0) === 0 || RETRYABLE_STATUS.has(Number(outcome.status));
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
  if (typeof response.text !== "function" && typeof response.json === "function") {
    return await response.json();
  }
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: "接口返回的不是 JSON" } };
  }
}

function formatErrorSuffix(data) {
  const message = data?.error?.message || data?.message || "";
  const clean = String(message).replace(/[\r\n]+/g, " ").slice(0, 180);
  return clean ? ": " + clean : "";
}

function safeTransportError(error) {
  const message = String(error?.message || error || "request failed");
  if (/redirect/i.test(message)) return "API 拒绝重定向，防止 Key 被转发到其他地址";
  if (/timeout|aborted/i.test(message)) return "API 请求超时";
  return message.replace(/[\r\n]+/g, " ").slice(0, 180);
}
