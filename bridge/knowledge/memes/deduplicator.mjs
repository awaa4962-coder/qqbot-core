import { normalizeMemeKey } from "./schema.mjs";

const DEFAULT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function deduplicateTrendItems(items = []) {
  const groups = [];
  for (const raw of items) {
    const item = normalizeTrendItem(raw);
    if (!item) continue;
    const existing = groups.find(group => sameTrend(group, item));
    if (existing) mergeTrend(existing, item);
    else groups.push(createTrendGroup(item));
  }
  return groups.sort((left, right) => trendScore(right) - trendScore(left));
}

export function selectTrendCandidates(items, entries, options = {}) {
  const now = Number(options.now || Date.now());
  const limit = Math.max(1, Number(options.limit || 15));
  const refreshAfterMs = Number(options.refreshAfterMs || DEFAULT_REFRESH_MS);
  const known = new Map(
    (entries || []).map(entry => [normalizeMemeKey(entry.name), entry]),
  );
  return items
    .filter(item => shouldRefresh(item, known.get(item.key), now, refreshAfterMs))
    .slice(0, limit);
}

export function normalizeTrendTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^#+|#+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTrendItem(raw) {
  const term = normalizeTrendTerm(firstText(raw?.term, raw?.title));
  const key = normalizeMemeKey(term);
  const length = [...term].length;
  if (!key || length < 2 || length > 36) return null;
  if (/^\d+$/.test(key) || /^https?\/\//i.test(term)) return null;
  return {
    ...raw,
    term,
    title: normalizeTrendTerm(firstText(raw?.title, term)),
    key,
    platform: normalizePlatform(raw?.platform),
    rank: normalizeRank(raw?.rank),
  };
}

function normalizePlatform(value) {
  return String(value || "web").trim().slice(0, 40) || "web";
}

function normalizeRank(value) {
  const number = Number(value);
  return Math.max(1, Number.isFinite(number) ? number : 999);
}

function firstText(...values) {
  return values.find(value => String(value || "").trim()) || "";
}

function sameTrend(left, right) {
  if (left.key === right.key) return true;
  if (left.key.length < 6 || right.key.length < 6) return false;
  return bigramSimilarity(left.key, right.key) >= 0.88;
}

function createTrendGroup(item) {
  return {
    ...item,
    platforms: [item.platform],
    trendSources: [sourceRecord(item)],
    bestRank: item.rank,
  };
}

function mergeTrend(target, item) {
  target.platforms = [...new Set([...(target.platforms || []), item.platform])];
  target.trendSources = mergeSourceRecords(target.trendSources, sourceRecord(item));
  target.bestRank = Math.min(Number(target.bestRank || 999), item.rank);
  target.hot = Math.max(Number(target.hot || 0), Number(item.hot || 0));
  if (item.term.length < target.term.length) {
    target.term = item.term;
    target.key = item.key;
  }
}

function sourceRecord(item) {
  return {
    platform: item.platform,
    url: item.url || "",
    title: item.title || item.term,
    snippet: item.snippet || "",
    fetchedAt: item.observedAt || new Date().toISOString(),
    kind: "web",
  };
}

function mergeSourceRecords(items = [], added) {
  const map = new Map(items.map(item => [item.url || `${item.platform}:${item.title}`, item]));
  const key = added.url || `${added.platform}:${added.title}`;
  map.set(key, added);
  return [...map.values()].slice(0, 12);
}

function shouldRefresh(item, existing, now, refreshAfterMs) {
  if (!existing) return true;
  if (!["web-verified", "china-meme-dictionary", "auto"].includes(existing.source)) return false;
  const verifiedAt = Date.parse(existing.lastVerifiedAt || "");
  return !Number.isFinite(verifiedAt) || now - verifiedAt >= refreshAfterMs;
}

function trendScore(item) {
  const crossPlatform = Math.min(4, (item.platforms || []).length) * 100;
  const rankScore = Math.max(0, 100 - Number(item.bestRank || item.rank || 100));
  return crossPlatform + rankScore + Math.min(50, Math.log10(Number(item.hot || 0) + 1) * 10);
}

function bigramSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(value) {
  const result = new Set();
  for (let index = 0; index < value.length - 1; index++) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}
