import { CFG } from "../../../config.mjs";
import { fetchSafeResponse } from "../../../safe-url.mjs";

const ROUTES = Object.freeze({
  weibo: "/weibo/search/hot",
  bilibili: "/bilibili/hot-search",
  zhihu: "/zhihu/hot",
});

export async function collectRssHubTerms(options = {}) {
  const baseUrl = String(options.baseUrl ?? CFG.memeRssHubBase ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    return {
      items: [],
      statuses: {
        rsshub: {
          ok: false,
          count: 0,
          fetchedAt: "",
          error: "not configured",
        },
      },
    };
  }

  const fetchJson = options.fetchJson || fetchJsonFeed;
  const limit = Math.max(1, Number(options.limit || 30));
  const results = await Promise.all(Object.entries(ROUTES).map(([platform, route]) =>
    collectRoute(platform, `${baseUrl}${route}`, fetchJson, limit)
  ));
  return {
    items: results.flatMap(result => result.items),
    statuses: Object.fromEntries(results.map(result => [`rsshub-${result.platform}`, result.status])),
  };
}

async function collectRoute(platform, routeUrl, fetchJson, limit) {
  const fetchedAt = new Date().toISOString();
  const url = routeUrl + (routeUrl.includes("?") ? "&" : "?") + "format=json";
  try {
    const payload = await fetchJson(url);
    const rawItems = payload?.items || payload?.data?.items || [];
    const items = rawItems
      .map((item, index) => normalizeItem(platform, item, index, fetchedAt))
      .filter(Boolean)
      .slice(0, limit);
    return {
      platform,
      items,
      status: {
        ok: items.length > 0,
        count: items.length,
        fetchedAt,
        error: items.length ? "" : "empty feed",
      },
    };
  } catch (error) {
    return {
      platform,
      items: [],
      status: {
        ok: false,
        count: 0,
        fetchedAt,
        error: String(error?.message || error).slice(0, 160),
      },
    };
  }
}

function normalizeItem(platform, item, index, fetchedAt) {
  const term = cleanText(item?.title, 100);
  if (!term) return null;
  return {
    term,
    platform,
    rank: index + 1,
    hot: 0,
    url: cleanUrl(item?.url || item?.external_url),
    title: term,
    sourceId: cleanText(item?.id || `${platform}-rss-${index + 1}`, 100),
    observedAt: fetchedAt,
    snippet: cleanText(item?.summary || item?.content_text || stripHtml(item?.content_html), 280),
  };
}

async function fetchJsonFeed(url) {
  const result = await fetchSafeResponse(url, {
    headers: {
      Accept: "application/feed+json, application/json",
      "User-Agent": "QQFriend-MemeUpdater/1.0",
    },
    timeoutMs: 15000,
  });
  if (!result.ok || !result.response?.ok) {
    throw new Error(result.reason || `HTTP ${result.response?.status || 0}`);
  }
  return await result.response.json();
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
