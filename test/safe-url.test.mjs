import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchFileContent } from "../bridge/napcat.mjs";
import { fetchSafeBuffer, fetchSafeResponse, validateSafeUrl } from "../bridge/safe-url.mjs";
import { safeFetch } from "../bridge/services/link-preview/safe-fetch.mjs";
import { tryMiMoVision } from "../bridge/vision.mjs";

async function withMockFetch(mockFetch, fn) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

function redirectToPrivate() {
  return {
    ok: false,
    status: 302,
    headers: { get: name => name.toLowerCase() === "location" ? "http://127.0.0.1/private" : null },
  };
}

describe("safe url redirects", () => {
  it("rejects IPv4-mapped IPv6 loopback forms", () => {
    assert.equal(validateSafeUrl("http://[::ffff:127.0.0.1]/").ok, false);
    assert.equal(validateSafeUrl("http://[::ffff:7f00:1]/").ok, false);
  });

  it("rejects public-looking hostnames that resolve to private addresses", async () => {
    let fetchCalls = 0;
    const result = await withMockFetch(async () => {
      fetchCalls++;
      return new globalThis.Response("nope");
    }, () => fetchSafeResponse("https://public.example/path", {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }));

    assert.equal(result.ok, false);
    assert.equal(result.reason, "private_address");
    assert.equal(fetchCalls, 0);
  });

  it("safeFetch rejects public URL redirecting to loopback", async () => {
    let calls = 0;
    const result = await withMockFetch(async () => {
      calls++;
      return redirectToPrivate();
    }, () => safeFetch("https://example.com/redirect"));

    assert.equal(result, null);
    assert.equal(calls, 1);
  });

  it("fetchFileContent rejects public URL redirecting to loopback", async () => {
    let calls = 0;
    const result = await withMockFetch(async () => {
      calls++;
      return redirectToPrivate();
    }, () => fetchFileContent({ name: "note.txt", url: "https://example.com/file.txt" }));

    assert.match(result, /读取失败|blocked|failed/);
    assert.equal(calls, 1);
  });

  it("fetchSafeBuffer rejects public image URL redirecting to loopback", async () => {
    let calls = 0;
    const result = await withMockFetch(async () => {
      calls++;
      return redirectToPrivate();
    }, () => fetchSafeBuffer("https://example.com/image.jpg"));

    assert.equal(result, null);
    assert.equal(calls, 1);
  });

  it("vision download does not call model after private redirect", async () => {
    let calls = 0;
    const result = await withMockFetch(async () => {
      calls++;
      return redirectToPrivate();
    }, () => tryMiMoVision(["https://example.com/image.jpg"]));

    assert.equal(result, null);
    assert.equal(calls, 1);
  });
});
