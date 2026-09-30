import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fetchSafeResponse, readBoundedResponseBuffer, validateSafeUrl } from "../safe-url.mjs";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { webSearchResults } from "../search.mjs";
import { authorizedSearchQuery, permitsPublicSearch, publicNetworkCancelled } from "./policy.mjs";
import { registeredTool } from "./registry.mjs";

const TTL_MS = 90000;
const READ_MS = registeredTool("read_public_page").timeoutMs;
const SEARCH_MS = registeredTool("web_search").timeoutMs;
const MAX_BYTES = 128 * 1024;
const MAX_REFS = 8;
const MAX_URL = 700;
const MAX_TEXT = 1600;
const MAX_RESULT = 1899;
const REF = /^src_[a-f0-9]{32}$/;
const SECRET_PARAMETER = /(?:token|secret|password|passwd|credential|authorization|session|signature|api.?key|access.?key|private.?key|^auth$|^key$|^code$|^sig$|^jwt$)/i;
const CONTENT_TYPES = new Set(["text/plain", "text/html", "text/markdown", "text/x-markdown", "application/json"]);

// read is fetchSafeResponse(url, options), including its per-hop pinned DNS contract.
export function createPublicSourceSession({ userMessage, task, signal, now = monotonicNow, search = webSearchResults, read = fetchSafeResponse } = {}) {
  const startedAt = Number(now());
  const deadline = startedAt + TTL_MS;
  const turnSignal = signal || globalThis.AbortSignal.timeout(TTL_MS);
  const references = new Map();
  const urls = new Map();
  const allowed = publicMessageAllowed(userMessage, task);
  const initial = [];
  for (const url of allowed ? requestedLinks(userMessage).slice(0, 3) : []) {
    const source = register(url, new URL(url).hostname);
    if (source && JSON.stringify([...initial, source]).length <= MAX_RESULT) initial.push(source);
    else if (source) { references.delete(source.source_ref); urls.delete(source.url); }
  }
  const available = allowed && (initial.length > 0 || permitsPublicSearch(userMessage, task));
  let pageFetches = 0;
  let invalid = "";

  function rejection() {
    const time = Number(now());
    if (!available) return "not_allowed";
    if (invalid) return invalid;
    if (turnSignal.aborted) return invalid = "cancelled";
    if (!Number.isFinite(time) || time < startedAt || time >= deadline) return invalid = "expired";
    return "";
  }

  function register(value, title) {
    const url = publicUrl(value);
    if (!url) return null;
    if (urls.has(url)) return references.get(urls.get(url));
    if (references.size >= MAX_REFS) return null;
    const source = Object.freeze({ source_ref: "src_" + randomBytes(16).toString("hex"), title: cleanText(title, 80) || new URL(url).hostname, url });
    references.set(source.source_ref, source);
    urls.set(url, source.source_ref);
    return source;
  }

  async function searchPublic(query) {
    const denied = rejection();
    if (denied) return failure("denied", denied);
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 160) return failure("invalid_arguments", "query");
    // Require the current-message substring even when this session is called outside the parent handler.
    if (sensitive(query) || unsafeQueryUrl(query)) return failure("denied", "sensitive_query");
    const authorized = authorizedSearchQuery(query, userMessage, task);
    if (!authorized) return failure("denied", "query_not_in_current_message");
    try {
      const operation = operationSignal(SEARCH_MS);
      const result = await abortable(() => search(authorized, { signal: operation }), operation);
      const stale = rejection();
      if (stale) return failure("denied", stale);
      return searchEvidence(result, register);
    } catch { return failure(rejection() ? "denied" : "unavailable", rejection() || "search_failed"); }
  }

  async function readPublic(sourceRef) {
    const denied = rejection();
    if (denied) return failure("denied", denied);
    if (typeof sourceRef !== "string" || !REF.test(sourceRef)) return failure("invalid_arguments", "source_ref");
    const source = references.get(sourceRef);
    if (!source) return failure("denied", "unknown_source");
    if (pageFetches >= 2) return failure("denied", "page_budget");
    pageFetches++;
    const operation = operationSignal();
    try {
      const result = await pageContent(source.url, read, {
        method: "GET", signal: operation, timeoutMs: Math.min(READ_MS, Math.max(1, deadline - Number(now()))),
        maxBytes: MAX_BYTES, maxRedirects: 3,
        requestImpl: publicPinnedRequest,
        headers: { Accept: "text/html, text/plain, text/markdown, application/json" },
      }, rejection);
      const stale = rejection();
      if (stale) return failure("denied", stale);
      return result.status ? result : boundedResult("ok", result.text, [source], "excerpt");
    } catch { return failure(rejection() ? "denied" : "unavailable", rejection() || "read_failed"); }
  }

  function operationSignal(maxMs = READ_MS) {
    return globalThis.AbortSignal.any([turnSignal, globalThis.AbortSignal.timeout(Math.min(maxMs, Math.max(1, Math.floor(deadline - Number(now())))))]);
  }

  return { available, initialSources: () => rejection() ? [] : initial.map(source => ({ ...source })), search: searchPublic, read: readPublic };
}

function publicMessageAllowed(message, task) {
  return ["group_chat", "private_chat"].includes(task) && typeof message === "string" && message.length <= 1000 &&
    !sensitive(message) && !publicNetworkCancelled(message);
}

function searchEvidence(result, register) {
  if (!result || result.status !== "ok") return failure(result?.status === "empty" ? "empty" : "unavailable", "search_empty");
  const candidates = Array.isArray(result.sources) ? result.sources.slice(0, MAX_REFS) : [];
  const sources = candidates.flatMap(item => {
    const source = register(item?.url, item?.title);
    return source ? [source] : [];
  });
  const text = [cleanText(result.answer, 800), ...candidates.filter(item => sources.some(source => source.url === publicUrl(item?.url)))
    .map(item => cleanText(item.snippet, 300) || cleanText(item.title, 160))].filter(Boolean).join("\n");
  return boundedResult("ok", text || sources.map(source => source.title).join("\n"), sources);
}

async function pageContent(url, read, options, rejection) {
  let response;
  try {
    const result = await abortable(() => read(url, options), options.signal);
    response = result?.response;
    const stale = rejection();
    if (stale) return failure("denied", stale);
    if (!publicResponse(result)) return failure("unavailable", "unsafe_response");
    const type = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!CONTENT_TYPES.has(type)) return failure("unavailable", "content_type");
    const buffer = await abortable(() => readBoundedResponseBuffer(response, MAX_BYTES), options.signal);
    if (buffer === null) return failure("unavailable", "response_too_large");
    const body = buffer.toString("utf8");
    return { text: cleanText(type === "text/html" ? htmlText(body) : body, MAX_TEXT) };
  } finally { try { response?.body?.cancel()?.catch(() => {}); } catch {} }
}

function publicResponse(result) {
  return result?.ok && result.response?.ok && Boolean(publicUrl(result.url?.href || result.url));
}

function publicPinnedRequest(url, options, callback) {
  // fetchSafeResponse supplies the pinned lookup; reject lexical hazards before every hop is sent.
  if (!publicUrl(url.href)) throw new Error("unsafe_public_url");
  return (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, callback);
}

function sensitive(value) {
  return containsSensitiveText(value) || /\[redacted\]|<redacted>|\bredacted\b|已脱敏|已隐藏|私聊记录|聊天记录|密码|密钥|身份证|手机号|\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/i.test(value);
}

function publicUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL || /[\s\\]/.test(value)) return "";
  const safe = validateSafeUrl(value);
  if (!safe.ok) return "";
  const url = safe.url;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(host) || !host.includes(".") || /(?:^|\.)(?:localhost|localdomain|local|lan|internal|intranet|home|corp|test|invalid|onion|arpa)$/.test(host)) return "";
  for (const [name, content] of url.searchParams) {
    if (name.includes("%") || SECRET_PARAMETER.test(name) || sensitiveDecoded(content)) return "";
  }
  let decoded;
  try { decoded = decodeURIComponent(url.href); } catch { return ""; }
  if (sensitiveDecoded(decoded)) return "";
  url.hash = "";
  return url.href.length <= MAX_URL ? url.href : "";
}

function sensitiveDecoded(value) {
  for (let pass = 0; pass < 3; pass++) {
    if (sensitive(value)) return true;
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { return true; }
    if (decoded === value) return false;
    value = decoded;
  }
  return sensitive(value) || /%[\da-f]{2}/i.test(value);
}

function unsafeQueryUrl(query) {
  return [...query.matchAll(/https?:\/\/[^\s<>"']+/gi)].some(match => !publicUrl(match[0]));
}

function requestedLinks(message) {
  if (/(?:不|别|勿|禁止|取消|停止|无需).{0,16}(?:读|看|总结|分析)|\b(?:don't|do not|never|without|cancel)\b.{0,24}\b(?:read|summarize|analyse|analyze)\b/i.test(message)) return [];
  const links = [];
  for (const clause of message.split(/[，；;\n]/)) {
    if (!/^\s*(?:(?:请|麻烦|帮我|替我|为我|给我|你|please)\s*)*(?:读(?:一下)?|看看|总结|分析|read\b|summarize\b|analy[sz]e\b)/i.test(clause)) continue;
    for (const match of clause.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const url = publicUrl(match[0].replace(/[)\]},.。！？!，；]+$/u, ""));
      if (url && !links.includes(url)) links.push(url);
      if (links.length >= MAX_REFS) return links;
    }
  }
  return links;
}

function htmlText(value) {
  return value.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*(?:>|$)/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_entity, code) => {
      if (code[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[code.toLowerCase()];
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
    });
}

function cleanText(value, limit) {
  return redactSensitiveText(typeof value === "string" ? value : "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
}

function failure(status, reason) { return { status, text: reason, untrusted: true, sources: [] }; }

function boundedResult(status, text, sources, coverage) {
  const result = { status, text: cleanText(text, MAX_TEXT), untrusted: true, sources: [...new Map(sources.map(source => [source.source_ref, { ...source }])).values()] };
  if (coverage) result.coverage = coverage;
  if (!result.text) return failure("unavailable", "empty_content");
  while (JSON.stringify({ ...result, text: "" }).length > MAX_RESULT - 16) result.sources.pop();
  let low = 0;
  let high = result.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify({ ...result, text: result.text.slice(0, middle) }).length <= MAX_RESULT) low = middle;
    else high = middle - 1;
  }
  result.text = result.text.slice(0, low).replace(/[\uD800-\uDBFF]$/u, "").trim();
  return result.text ? result : failure("unavailable", "result_budget");
}

function abortable(run, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(run).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
