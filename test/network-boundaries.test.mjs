import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { setTimeout, clearTimeout } from "node:timers";
import { fetchSafeBuffer, fetchSafeResponse, fetchSafeText, validateSafeUrl } from "../bridge/safe-url.mjs";
import { fetchReplyData } from "../bridge/napcat.mjs";
import { sendTextToGroup, sendTextToPrivate, splitLongText } from "../bridge/outbound-message.mjs";
const { ReadableStream, Response, Headers } = globalThis;

async function mockedFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test("safe downloads cancel an undeclared oversized streaming body early", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const value = await mockedFetch(async () => new Response(body), () => fetchSafeBuffer("https://public.example/a", { maxBytes: 16 }));
  assert.equal(value, null);
  assert.equal(cancelled, true);
  assert.equal(pulls, 3);
});

test("redirects cancel the previous body and drop cross-origin credentials", async () => {
  let cancelled = false, calls = 0;
  const value = await mockedFetch(async (_url, options) => {
    if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "https://other.example/a" } });
    assert.equal(new Headers(options.headers).has("authorization"), false);
    assert.equal(new Headers(options.headers).has("cookie"), false);
    return new Response("ok");
  }, () => fetchSafeText("https://public.example/a", { headers: { Authorization: "Bearer synthetic", Cookie: "synthetic" } }));
  assert.equal(value, "ok");
  assert.equal(cancelled, true);
});

test("native transport pins validated DNS and keeps original hostname and decompression", async () => {
  let lookups = 0;
  const result = await fetchSafeText("https://public.example/path", {
    lookup: async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; },
    requestImpl(url, options, callback) {
      assert.equal(url.hostname, "public.example");
      assert.equal(options.agent, false);
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
      });
      const req = new EventEmitter();
      req.end = () => {
        const response = new PassThrough();
        response.rawHeaders = ["content-encoding", "gzip"];
        response.statusCode = 200;
        callback(response);
        response.end(gzipSync("decompressed"));
      };
      return req;
    },
  });
  assert.equal(lookups, 1);
  assert.equal(result, "decompressed");
});

test("each redirect revalidates DNS including mixed public/private results", async () => {
  let calls = 0;
  const result = await mockedFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://internal.example/" } }); }, () => fetchSafeResponse("https://public.example/", {
    lookup: async hostname => hostname === "public.example" ? [{ address: "8.8.8.8" }] : [{ address: "8.8.8.8" }, { address: "127.0.0.1" }],
  }));
  assert.equal(result.reason, "private_address");
  assert.equal(calls, 1);
  for (const host of ["[0:0:0:0:0:0:0:1]", "[::ffff:7f00:1]", "[2002:7f00:1::]", "[64:ff9b::7f00:1]"]) assert.equal(validateSafeUrl(`http://${host}/`).ok, false);
});

test("outbound timeout or malformed acknowledgement never blindly retries", async () => {
  for (const sender of [() => sendTextToGroup({ groupId: 1, text: "test", retryDelayMs: 0 }), () => sendTextToPrivate({ userId: 1, text: "test", retryDelayMs: 0 })]) {
    let calls = 0;
    const result = await mockedFetch(async () => { calls++; throw new Error("accepted but connection lost"); }, sender);
    assert.equal(calls, 1);
    assert.equal(result.delivery, "unconfirmed");
  }
});

test("split boundary cannot exceed limit when punctuation is at limit+1", () => {
  for (const delimiter of ["。", "!", "\n\n"]) {
    const chunks = splitLongText("a".repeat(900) + delimiter + "b".repeat(200), 900);
    assert.ok(chunks.every(chunk => chunk.length <= 900));
  }
});

test("quoted message download has a deadline and fails closed", async () => {
  const result = await mockedFetch(async (_url, options) => {
    assert.ok(options.signal);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
  }, () => fetchReplyData({ id: 1 }, { timeoutMs: 10 }));
  assert.deepEqual(result, { text: "", images: [] });
});
