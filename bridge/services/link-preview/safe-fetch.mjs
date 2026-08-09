import { logE } from "../../logger.mjs";
import { fetchSafeResponse } from "../../safe-url.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const PAGE_MIME_RE = /^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/i;

export async function safeFetch(url, { timeoutMs = 6000, maxBytes = MAX_BODY_BYTES } = {}) {
  const page = await safeFetchPage(url, { timeoutMs, maxBytes });
  return page?.html || null;
}

export async function safeFetchPage(url, { timeoutMs = 6000, maxBytes = MAX_BODY_BYTES } = {}) {
  try {
    const result = await fetchSafeResponse(url, {
      timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; QQbot/1.0)" },
    });
    if (!result.ok || !result.response?.ok) return null;

    const contentType = result.response.headers.get("content-type") || "";
    if (contentType && !PAGE_MIME_RE.test(contentType)) return null;
    const html = await readBoundedText(result.response, maxBytes);
    if (html === null) return null;
    return {
      html,
      url: result.url?.href || String(url || ""),
      contentType,
    };
  } catch (e) {
    logE("safeFetch error:", e.message);
    return null;
  }
}

async function readBoundedText(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) return null;
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
