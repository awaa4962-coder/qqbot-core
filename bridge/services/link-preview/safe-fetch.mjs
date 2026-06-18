// bridge/services/link-preview/safe-fetch.mjs — SSRF 安全 + 大小限制的 fetch 封装
import { logE } from "../../logger.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * 安全 fetch：拒绝内网地址 + 限制响应大小
 */
export async function safeFetch(url, { timeoutMs = 6000, maxBytes = MAX_BODY_BYTES } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;

  const hostname = parsed.hostname;
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" ||
    hostname.startsWith("192.168.") || hostname.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
    return null;
  }

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; QQbot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cl = parseInt(r.headers.get("content-length") || "0");
    if (cl > maxBytes) return null;
    const text = await r.text();
    if (text.length > maxBytes) return null;
    return text;
  } catch (e) {
    logE("safeFetch error:", e.message);
    return null;
  }
}
