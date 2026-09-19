import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import { isAllowedBrowserOrigin, isAuthorizedOneBotRequest, readRequestJson } from "../bridge/http-ingress.mjs";

test("OneBot requires the configured token even from loopback", () => {
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isAuthorizedOneBotRequest(req, "test-token"), false);
  req.headers.authorization = "Bearer test-token";
  assert.equal(isAuthorizedOneBotRequest(req, "test-token"), true);
  assert.equal(isAuthorizedOneBotRequest(req, "different"), false);
  assert.equal(isAuthorizedOneBotRequest(req, ""), false);
  req.headers.origin = "http://localhost.evil.example";
  assert.equal(isAuthorizedOneBotRequest(req, "test-token"), false);
});

test("CORS validates the exact loopback hostname and origin", () => {
  for (const value of [undefined, "http://localhost:4000", "http://127.0.0.1:16789", "http://[::1]:8080"]) assert.equal(isAllowedBrowserOrigin(value), true);
  for (const value of ["null", "http://localhost.evil", "http://127.0.0.1.evil", "http://localhost@evil.example", "http://localhost/path"]) assert.equal(isAllowedBrowserOrigin(value), false);
});

test("request body rejects oversized, empty, scalar and aborted input without hanging", async () => {
  for (const text of ["", "[]", "null", "0", "not-json"]) {
    const req = new PassThrough();
    const result = readRequestJson(req);
    req.end(text);
    await assert.rejects(result, { statusCode: 400 });
  }
  const big = new PassThrough();
  const result = readRequestJson(big, { maxBytes: 2 });
  big.write("123");
  await assert.rejects(result, { statusCode: 413 });
  const aborted = new PassThrough();
  const abortResult = readRequestJson(aborted);
  aborted.emit("aborted");
  assert.doesNotThrow(() => aborted.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })));
  await assert.rejects(abortResult, { statusCode: 400 });
  const errored = new PassThrough();
  const errorResult = readRequestJson(errored);
  errored.emit("error", new Error("synthetic"));
  await assert.rejects(errorResult, { statusCode: 400 });
});

test("request body has a deadline and decodes split UTF8 buffers correctly", async () => {
  await assert.rejects(readRequestJson(new PassThrough(), { timeoutMs: 10 }), { statusCode: 408 });
  const req = new PassThrough();
  const result = readRequestJson(req);
  const bytes = Buffer.from(JSON.stringify({ message: "中文" }));
  for (const byte of bytes) req.write(Buffer.from([byte]));
  req.end();
  assert.deepEqual(await result, { message: "中文" });
});
