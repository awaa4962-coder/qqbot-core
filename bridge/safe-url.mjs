import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const IPV4_BLOCK_RULES = [
  ([a]) => a === 0 || a === 10 || a === 127 || a >= 224,
  ([a, b]) => a === 169 && b === 254,
  ([a, b]) => a === 172 && b >= 16 && b <= 31,
  ([a, b]) => a === 192 && b === 168,
  ([a, b]) => a === 100 && b >= 64 && b <= 127,
  ([a, b, c]) => a === 192 && b === 0 && (c === 0 || c === 2),
  ([a, b, c]) => a === 192 && b === 88 && c === 99,
  ([a, b]) => a === 198 && (b === 18 || b === 19),
  ([a, b, c]) => a === 198 && b === 51 && c === 100,
  ([a, b, c]) => a === 203 && b === 0 && c === 113,
];

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIpv4(hostname) {
  const parts = normalizeHostname(hostname).split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIpv4(hostname) {
  const ip = parseIpv4(hostname);
  if (!ip) return false;
  return IPV4_BLOCK_RULES.some(rule => rule(ip));
}

function isPrivateIpv6(hostname) {
  const host = normalizeHostname(hostname);
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(host)) return true;
  if (host.startsWith("fec") || host.startsWith("fed") || host.startsWith("fee") || host.startsWith("fef")) return true;
  if (host.startsWith("ff")) return true;
  const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = parseIpv4MappedHex(host);
  return mappedHex ? isPrivateIpv4(mappedHex) : false;
}

function parseIpv4MappedHex(hostname) {
  const match = normalizeHostname(hostname).match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return null;
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const value = high * 65536 + low;
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

export function isPrivateHostname(hostname) {
  const host = normalizeHostname(hostname);
  return host === "localhost" ||
    host.endsWith(".localhost") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host);
}

export function validateSafeUrl(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url || ""));
  } catch {
    return { ok: false, reason: "invalid_url", url: null };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: "unsupported_protocol", url: parsed };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_not_allowed", url: parsed };
  }
  if (isPrivateHostname(parsed.hostname)) {
    return { ok: false, reason: "private_address", url: parsed };
  }
  return { ok: true, reason: "", url: parsed };
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function redirectMethod(method, status) {
  if (Number(status) === 303) return "GET";
  return method;
}

export async function fetchSafeResponse(url, options = {}) {
  const {
    headers = {},
    method = "GET",
    timeoutMs = 10000,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;

  let current = validateSafeUrl(url);
  if (!current.ok) return { ok: false, reason: current.reason, response: null, url: null };

  let currentMethod = method;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const resolved = await validateResolvedHost(current.url, options);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, response: null, url: null };
    const response = await fetch(current.url.href, {
      method: currentMethod,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!isRedirectStatus(response.status)) {
      return { ok: true, reason: "", response, url: current.url };
    }

    const location = response.headers.get("location");
    if (!location) return { ok: false, reason: "redirect_without_location", response: null, url: current.url };
    if (redirects >= maxRedirects) return { ok: false, reason: "too_many_redirects", response: null, url: current.url };

    current = validateSafeUrl(new URL(location, current.url));
    if (!current.ok) return { ok: false, reason: current.reason, response: null, url: null };
    currentMethod = redirectMethod(currentMethod, response.status);
  }

  return { ok: false, reason: "too_many_redirects", response: null, url: current.url };
}

async function validateResolvedHost(url, options) {
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname)) {
    return isPrivateHostname(hostname)
      ? { ok: false, reason: "private_address" }
      : { ok: true, reason: "" };
  }
  if (!options.lookup && process.env.NODE_ENV === "test") return { ok: true, reason: "" };
  const lookup = options.lookup || dnsLookup;
  try {
    const result = await lookup(hostname, { all: true, verbatim: true });
    const addresses = Array.isArray(result) ? result : [result];
    if (!addresses.length) return { ok: false, reason: "dns_lookup_failed" };
    const privateAddress = addresses.some(item => isPrivateHostname(item?.address || item));
    return privateAddress
      ? { ok: false, reason: "private_address" }
      : { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: "dns_lookup_failed" };
  }
}

export async function fetchSafeText(url, options = {}) {
  const maxBytes = options.maxBytes || 2 * 1024 * 1024;
  const result = await fetchSafeResponse(url, options);
  if (!result.ok || !result.response?.ok) return null;

  const contentLength = parseInt(result.response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) return null;
  const text = await result.response.text();
  return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
}

export async function fetchSafeBuffer(url, options = {}) {
  const maxBytes = options.maxBytes || 10 * 1024 * 1024;
  const result = await fetchSafeResponse(url, options);
  if (!result.ok || !result.response?.ok) return null;

  const contentLength = parseInt(result.response.headers.get("content-length") || "0");
  if (contentLength > maxBytes) return null;
  const buffer = Buffer.from(await result.response.arrayBuffer());
  if (buffer.length > maxBytes) return null;
  return {
    buffer,
    mimeType: result.response.headers.get("content-type") || "application/octet-stream",
    url: result.url?.href || "",
  };
}
