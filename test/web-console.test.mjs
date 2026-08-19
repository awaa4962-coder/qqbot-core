import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleWebConsoleRequest } from "../bridge/web-console.mjs";

test("web console serves allowlisted assets only to loopback clients", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-console-test-"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>QQFriend</h1>", "utf8");
  try {
    const response = createResponse();
    const handled = await handleWebConsoleRequest(
      createRequest("127.0.0.1"),
      response,
      { enabled: true, pathname: "/console/", root }
    );
    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString("utf8"), "<h1>QQFriend</h1>");
    assert.match(response.headers["Content-Security-Policy"], /default-src 'self'/);
    assert.equal(response.headers["X-Frame-Options"], "DENY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web console is hidden from non-loopback clients", async () => {
  const response = createResponse();
  const handled = await handleWebConsoleRequest(
    createRequest("192.0.2.10"),
    response,
    { enabled: true, pathname: "/console/" }
  );
  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
});

test("web console accepts a private Docker gateway only in container mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-console-docker-test-"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>Container</h1>", "utf8");
  try {
    const denied = createResponse();
    await handleWebConsoleRequest(createRequest("172.18.0.1"), denied, {
      enabled: true,
      pathname: "/console/",
      root,
      containerized: false,
    });
    assert.equal(denied.statusCode, 404);

    const allowed = createResponse();
    await handleWebConsoleRequest(createRequest("172.18.0.1"), allowed, {
      enabled: true,
      pathname: "/console/",
      root,
      containerized: true,
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.toString("utf8"), "<h1>Container</h1>");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web console rejects unknown and traversal-like asset paths", async () => {
  for (const pathname of ["/console/../package.json", "/console/secrets", "/console/app.js.map"]) {
    const response = createResponse();
    const handled = await handleWebConsoleRequest(
      createRequest("::1"),
      response,
      { enabled: true, pathname }
    );
    assert.equal(handled, true);
    assert.equal(response.statusCode, 404);
  }
});

function createRequest(remoteAddress, method = "GET") {
  return { method, socket: { remoteAddress } };
}

function createResponse() {
  return {
    body: Buffer.alloc(0),
    headers: {},
    statusCode: 0,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(value) {
      this.body = value === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    },
  };
}
