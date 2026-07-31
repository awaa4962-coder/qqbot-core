import { CFG } from "../../config.mjs";
import { fetchSafeResponse, validateSafeUrl } from "../../safe-url.mjs";

const TAVILY_URL = "https://api.tavily.com/search";

export async function searchMemeEvidence(term, options = {}) {
  const query = buildEvidenceQuery(term);
  const tavilySearch = options.tavilySearch || searchTavily;
  const bingSearch = options.bingSearch || searchBing;
  let results = [];

  if (options.preloaded) {
    results = options.preloaded;
  } else if (CFG.tavilyKey || options.tavilyKey) {
    try {
      results = await tavilySearch(query, {
        key: options.tavilyKey || CFG.tavilyKey,
        fetchImpl: options.fetchImpl,
      });
    } catch {
      results = [];
    }
  }

  if (!results.length) {
    try {
      results = await bingSearch(query, options);
    } catch {
      results = [];
    }
  }

  return filterRelevantMemeEvidence(term, results)
    .slice(0, Number(options.limit || 8));
}

export function evidenceDomainCount(items = []) {
  return new Set(items.map(item => domainOf(item.url)).filter(Boolean)).size;
}

export function isUsableMemeEvidence(item) {
  return Boolean(
    item &&
    item.url &&
    item.title &&
    String(item.snippet || "").trim().length >= 20
  );
}

export function filterRelevantMemeEvidence(term, items = []) {
  return normalizeEvidence(items).filter(item =>
    evidenceRelevanceScore(term, item) >= 0.8
  );
}

export function evidenceRelevanceScore(term, item) {
  const needle = comparableText(term);
  if (needle.length < 2 || !isUsableMemeEvidence(item)) return 0;
  const title = comparableText(item.title);
  const content = comparableText(`${item.title} ${item.snippet || ""}`);
  if (title.includes(needle) || content.includes(needle)) return 1;
  if (needle.length < 5) return 0;
  return Math.max(ngramCoverage(needle, title), ngramCoverage(needle, content));
}

async function searchTavily(query, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: options.key,
      query,
      max_results: 8,
      include_answer: false,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
  const payload = await response.json();
  return (payload?.results || []).map(item => ({
    platform: domainOf(item.url) || "web",
    url: item.url,
    title: item.title,
    snippet: item.content,
    fetchedAt: new Date().toISOString(),
    kind: "web",
  }));
}

async function searchBing(query, _options = {}) {
  const url = "https://cn.bing.com/search?q=" + encodeURIComponent(query) + "&form=QBLH&mkt=zh-CN";
  const result = await fetchSafeResponse(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 QQFriend-MemeUpdater/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    timeoutMs: 12000,
  });
  if (!result.ok || !result.response?.ok) {
    throw new Error(result.reason || `Bing HTTP ${result.response?.status || 0}`);
  }
  return parseBingResults(await result.response.text());
}

function parseBingResults(html) {
  const results = [];
  const pattern = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null && results.length < 8) {
    results.push({
      platform: domainOf(match[1]) || "web",
      url: match[1],
      title: decodeHtml(stripHtml(match[2])),
      snippet: decodeHtml(stripHtml(match[3])),
      fetchedAt: new Date().toISOString(),
      kind: "web",
    });
  }
  return results;
}

function normalizeEvidence(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeEvidenceItem(item);
    if (!normalized) continue;
    const { url } = normalized;
    map.set(url, normalized);
  }
  return [...map.values()].filter(isUsableMemeEvidence);
}

function normalizeEvidenceItem(item) {
  const url = safePublicUrl(item?.url);
  const title = cleanText(item?.title, 160);
  const snippet = cleanText(firstText(item?.snippet, item?.content), 280);
  if (!url || !title || !snippet) return null;
  return {
    platform: cleanText(firstText(item?.platform, domainOf(url), "web"), 40),
    url,
    title,
    snippet,
    fetchedAt: validIso(item?.fetchedAt) || new Date().toISOString(),
    publishedAt: validIso(item?.publishedAt),
    kind: item?.kind === "manual" ? "manual" : "web",
  };
}

function buildEvidenceQuery(term) {
  const value = String(term || "").replace(/["\r\n]/g, " ").trim().slice(0, 60);
  return `"${value}" 梗 出处 什么意思 用法`;
}

function safePublicUrl(value) {
  const checked = validateSafeUrl(value);
  return checked.ok ? checked.url.href : "";
}

function domainOf(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function ngramCoverage(needle, haystack) {
  const grams = characterNgrams(needle, needle.length >= 8 ? 3 : 2);
  if (!grams.size || !haystack) return 0;
  let matched = 0;
  for (const gram of grams) {
    if (haystack.includes(gram)) matched += 1;
  }
  return matched / grams.size;
}

function characterNgrams(value, size) {
  const chars = [...value];
  const output = new Set();
  for (let index = 0; index <= chars.length - size; index += 1) {
    output.add(chars.slice(index, index + size).join(""));
  }
  return output;
}

function validIso(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function firstText(...values) {
  return values.find(value => String(value || "").trim()) || "";
}
