import { CFG } from "../../../config.mjs";
import { fetchSafeResponse } from "../../../safe-url.mjs";

const PLATFORMS = Object.freeze(["weibo", "bilibili", "zhihu", "douyin", "tieba"]);
const DIRECT_SOURCES = Object.freeze({
  weibo: {
    url: "https://weibo.com/ajax/side/hotSearch",
    parse: payload => payload?.data?.realtime || [],
  },
  bilibili: {
    url: "https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1",
    parse: payload => payload?.data?.list || [],
  },
  zhihu: {
    url: "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=30",
    parse: payload => payload?.data || [],
  },
});

export async function collectDailyHotTerms(options = {}) {
  const baseUrl = String(options.baseUrl ?? CFG.memeTrendApiBase ?? "").replace(/\/+$/, "");
  const limit = Math.max(1, Number(options.limit || 30));
  const fetchJson = options.fetchJson || fetchJsonResponse;
  const platforms = options.platforms || PLATFORMS;
  const results = await Promise.all(platforms.map(platform =>
    collectPlatform(platform, { baseUrl, fetchJson, limit })
  ));

  return {
    items: results.flatMap(result => result.items),
    statuses: Object.fromEntries(results.map(result => [result.platform, result.status])),
  };
}

async function collectPlatform(platform, options) {
  const fetchedAt = new Date().toISOString();
  const aggregateUrl = options.baseUrl ? `${options.baseUrl}/${platform}` : "";
  let error = "";

  if (aggregateUrl) {
    try {
      const payload = await options.fetchJson(aggregateUrl);
      const items = normalizeItems(platform, payload?.data || payload, options.limit, fetchedAt);
      if (items.length) return success(platform, items, fetchedAt, "daily-hot");
      error = "empty aggregate response";
    } catch (caught) {
      error = String(caught?.message || caught);
    }
  }

  const direct = DIRECT_SOURCES[platform];
  if (direct) {
    try {
      const payload = await options.fetchJson(direct.url);
      const items = normalizeItems(platform, direct.parse(payload), options.limit, fetchedAt);
      if (items.length) return success(platform, items, fetchedAt, "direct");
      error = "empty direct response";
    } catch (caught) {
      error = String(caught?.message || caught);
    }
  }

  return {
    platform,
    items: [],
    status: {
      ok: false,
      count: 0,
      fetchedAt,
      error: error.slice(0, 160) || "source unavailable",
    },
  };
}

function success(platform, items, fetchedAt, mode) {
  return {
    platform,
    items,
    status: {
      ok: true,
      count: items.length,
      fetchedAt,
      error: "",
      mode,
    },
  };
}

function normalizeItems(platform, raw, limit, fetchedAt) {
  const items = Array.isArray(raw) ? raw : [];
  return items
    .map((item, index) => normalizeItem(platform, item, index, fetchedAt))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeItem(platform, item, index, fetchedAt) {
  const source = targetObject(item);
  const term = trendTerm(source, item);
  if (!term) return null;
  return {
    term,
    platform,
    rank: index + 1,
    hot: trendHot(source, item),
    url: trendUrl(source, item),
    title: term,
    sourceId: trendSourceId(source, platform, index),
    observedAt: fetchedAt,
  };
}

function trendTerm(source, item) {
  return cleanText(firstValue(
    source?.title,
    source?.word,
    source?.word_scheme,
    source?.name,
    source?.desc,
    item?.title,
    item?.word,
    item?.desc,
  ), 100);
}

function trendUrl(source, item) {
  return cleanUrl(firstValue(
    source?.url,
    source?.link,
    source?.mobileUrl,
    source?.short_link_v2,
    source?.short_link,
    item?.url,
    item?.link,
  ));
}

function trendHot(source, item) {
  return finiteNumber(firstValue(source?.hot, source?.heat, item?.hot));
}

function trendSourceId(source, platform, index) {
  return cleanText(firstValue(
    source?.id,
    source?.mid,
    source?.bvid,
    source?.question?.id,
    `${platform}-${index + 1}`,
  ), 100);
}

function targetObject(item) {
  return item?.target && typeof item.target === "object" ? item.target : item;
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "") ?? "";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function fetchJsonResponse(url) {
  const result = await fetchSafeResponse(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 QQFriend-MemeUpdater/1.0",
      Referer: "https://www.bilibili.com/",
    },
    timeoutMs: 12000,
  });
  if (!result.ok || !result.response?.ok) {
    throw new Error(result.reason || `HTTP ${result.response?.status || 0}`);
  }
  return await result.response.json();
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
