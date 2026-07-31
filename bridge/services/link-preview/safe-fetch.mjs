import { logE } from "../../logger.mjs";
import { fetchSafeText } from "../../safe-url.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

export async function safeFetch(url, { timeoutMs = 6000, maxBytes = MAX_BODY_BYTES } = {}) {
  try {
    return await fetchSafeText(url, {
      timeoutMs,
      maxBytes,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; QQbot/1.0)" },
    });
  } catch (e) {
    logE("safeFetch error:", e.message);
    return null;
  }
}
