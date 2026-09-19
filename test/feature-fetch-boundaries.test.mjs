import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { ReadableStream } from "node:stream/web";
import { test } from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import { fetchBilibiliInfo } from "../bridge/services/link-preview/bilibili.mjs";
import { fetchGitHubRepositoryInfo, resetGitHubPreviewCache } from "../bridge/services/link-preview/github.mjs";
import { safeFetchPage } from "../bridge/services/link-preview/safe-fetch.mjs";
import { collectDailyHotTerms } from "../bridge/knowledge/memes/sources/daily-hot.mjs";
import { collectRssHubTerms } from "../bridge/knowledge/memes/sources/rsshub.mjs";
import { searchMemeEvidence } from "../bridge/knowledge/memes/evidence-search.mjs";
import { downloadResourceToTemp } from "../bridge/resource-transfer.mjs";

test("Bilibili API requests carry an abort deadline and stop waiting on a slow response", async () => {
  let sawSignal = false;
  // Keep the event loop alive while the mock waits for AbortSignal.timeout.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await withFetch((_url, options) => new Promise((_resolve, reject) => {
      sawSignal = Boolean(options.signal);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }), async () => {
      assert.equal(await fetchBilibiliInfo("https://www.bilibili.com/video/BVtest123", { timeoutMs: 20 }), null);
    });
  } finally { clearTimeout(keepAlive); }
  assert.equal(sawSignal, true);
});

test("Bilibili short-link redirects use bounded safe HEAD requests", async () => {
  const requests = [];
  await withFetch(async (url, options) => {
    requests.push({ url, method: options.method, signal: options.signal });
    if (url.startsWith("https://b23.tv/")) {
      return new globalThis.Response(null, {
        status: 302, headers: { location: "https://www.bilibili.com/video/BVtest123" },
      });
    }
    return new globalThis.Response(JSON.stringify({ code: 0, data: { title: "synthetic", owner: {} } }));
  }, async () => {
    assert.equal((await fetchBilibiliInfo("https://b23.tv/test123")).bvid, "BVtest123");
  });
  assert.deepEqual(requests.map(item => item.method), ["HEAD", "HEAD", "GET"]);
  assert.ok(requests.every(item => item.signal));
});

test("external feature readers cancel oversized chunked bodies", async () => {
  const cases = [
    ["bilibili", 512 * 1024, () => fetchBilibiliInfo("https://www.bilibili.com/video/BVtest123")],
    ["github", 512 * 1024, () => fetchGitHubRepositoryInfo("https://github.com/test/oversized")],
    ["page", 2 * 1024 * 1024, () => safeFetchPage("https://example.com/page")],
    ["daily-hot", 2 * 1024 * 1024, () => collectDailyHotTerms({ baseUrl: "", platforms: ["weibo"] })],
    ["rsshub", 2 * 1024 * 1024, () => collectRssHubTerms({ baseUrl: "https://example.com/rss" })],
    ["bing", 2 * 1024 * 1024, () => searchMemeEvidence("synthetic", { tavilySearch: async () => [] })],
  ];
  resetGitHubPreviewCache();
  for (const [name, limit, run] of cases) {
    let cancelled = 0;
    await withFetch(async () => oversizedResponse(limit, () => { cancelled++; }, name === "page"), run);
    assert.ok(cancelled > 0, name + " must cancel its response");
  }
});

test("Tavily oversized responses are cancelled before falling back", async () => {
  let cancelled = false;
  const result = await searchMemeEvidence("synthetic", {
    tavilyKey: "synthetic-test-key",
    fetchImpl: async () => oversizedResponse(2 * 1024 * 1024, () => { cancelled = true; }),
    bingSearch: async () => [],
  });
  assert.deepEqual(result, []);
  assert.equal(cancelled, true);
});

test("resource content-length refusal cancels its body before creating a temp file", async () => {
  let cancelled = false;
  await withFetch(async () => new globalThis.Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "100" } }), async () => {
    await assert.rejects(downloadResourceToTemp("https://example.com/large.bin", { maxBytes: 10 }), /size_limit/);
  });
  assert.equal(cancelled, true);
});

function oversizedResponse(limit, cancel, html = false) {
  return new globalThis.Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(limit + 1)); },
    cancel,
  }), { headers: { "content-type": html ? "text/html" : "application/json" } });
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await run(); } finally { globalThis.fetch = original; }
}
