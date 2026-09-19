import { logE } from "../../logger.mjs";
import { fetchSafeResponse, readBoundedResponseBuffer } from "../../safe-url.mjs";

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
    if (!result.ok || !result.response?.ok) {
      await discardResponse(result.response);
      return null;
    }

    const contentType = result.response.headers.get("content-type") || "";
    if (contentType && !PAGE_MIME_RE.test(contentType)) {
      await discardResponse(result.response);
      return null;
    }
    const buffer = await readBoundedResponseBuffer(result.response, maxBytes);
    if (buffer === null) return null;
    return {
      html: buffer.toString("utf8"),
      url: result.url?.href || String(url || ""),
      contentType,
    };
  } catch (e) {
    logE("safeFetch error:", e.message);
    return null;
  }
}

async function discardResponse(response) {
  try { await response?.body?.cancel(); } catch {}
}
