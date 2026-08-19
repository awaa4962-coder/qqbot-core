import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { CFG } from "../bridge/config.mjs";
import { VERSION } from "../bridge/version.mjs";
import {
  buildCommandCatalog,
  buildCapabilityCatalog,
  buildRuntimeStatus,
  handleAdminApiRequest,
  isAuthorizedAdminRequest,
  isLoopbackAddress,
  isPrivateAddress,
  isTrustedManagementAddress,
  readLogTail,
  redactLogLine,
} from "../bridge/admin-api/index.mjs";

test("admin api auth only allows loopback by default", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.2"), false);

  assert.equal(isAuthorizedAdminRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }, { requiredToken: "" }), true);
  assert.equal(isAuthorizedAdminRequest({ socket: { remoteAddress: "8.8.8.8" }, headers: {} }, { requiredToken: "" }), false);
});

test("admin api auth honors optional token", () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-qqfriend-admin-token": "token-a" },
  };
  assert.equal(isAuthorizedAdminRequest(req, { requiredToken: "token-a" }), true);
  assert.equal(isAuthorizedAdminRequest(req, { requiredToken: "token-b" }), false);
  assert.equal(isAuthorizedAdminRequest({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: "Bearer token-a" },
  }, { requiredToken: "token-a" }), true);
});

test("container management trusts private gateways only with explicit mode and token", () => {
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("172.18.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("::ffff:172.18.0.1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);

  assert.equal(isTrustedManagementAddress("172.18.0.1", { containerized: false }), false);
  assert.equal(isTrustedManagementAddress("172.18.0.1", { containerized: true }), true);
  assert.equal(isTrustedManagementAddress("8.8.8.8", { containerized: true }), false);

  const req = {
    socket: { remoteAddress: "172.18.0.1" },
    headers: { "x-qqfriend-admin-token": "token-a" },
  };
  assert.equal(isAuthorizedAdminRequest(req, {
    containerized: true,
    requiredToken: "token-a",
  }), true);
  assert.equal(isAuthorizedAdminRequest(req, {
    containerized: true,
    requiredToken: "token-b",
  }), false);
  assert.equal(isAuthorizedAdminRequest(req, {
    containerized: true,
    requiredToken: "",
  }), false);
});

test("command catalog is generated from manifest as plain JSON data", () => {
  const catalog = buildCommandCatalog();
  assert.ok(catalog.count >= 1);
  assert.equal(catalog.count, catalog.commands.length);
  assert.ok(catalog.commands.some(command => command.id === "runtime"));
  assert.ok(catalog.commands.every(command => typeof command.id === "string"));
  assert.equal(JSON.stringify(catalog).includes("function"), false);
});

test("capability catalog exposes sanitized dynamic discovery data", () => {
  const catalog = buildCapabilityCatalog({ surface: "console" });
  assert.equal(catalog.categories.length, 6);
  assert.ok(catalog.capabilities.some(item => item.id === "resources.jm"));
  assert.ok(catalog.capabilities.every(item => ["available", "limited", "unavailable", "reserved"].includes(item.status)));
  assert.equal(JSON.stringify(catalog).includes(CFG.mimoKey), false);
});

test("runtime status is sanitized and does not expose raw model keys", () => {
  const status = buildRuntimeStatus({ now: new Date("2026-07-03T00:00:00.000Z") });
  assert.equal(status.status, "ok");
  assert.equal(status.version, VERSION);
  assert.equal(status.modules.cognition.enabled, true);
  assert.equal(status.modules.cognition.privatePersistence, false);
  assert.equal(typeof status.modelKeys.mimo, "boolean");
  assert.equal(status.modules.imageContext.storesImages, false);
  assert.equal(status.modules.imageContext.storesChatText, false);
  assert.equal(status.modules.memeKnowledge.enabled, true);
  assert.equal(typeof status.modules.memeKnowledge.entries, "number");
  const serialized = JSON.stringify(status);
  for (const key of [CFG.mimoKey, CFG.dsKey, CFG.tavilyKey, CFG.doubaoKey]) {
    if (key && key.length >= 8) {
      assert.equal(serialized.includes(key), false);
    }
  }
});

test("log reader tails only safe log files and redacts secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-admin-log-"));
  fs.writeFileSync(path.join(dir, "bridge-2026-07-03.log"), [
    "[00:00:01] normal line",
    "[00:00:02] Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "[00:00:03] api_key=super-secret-value",
  ].join("\n"));

  const result = readLogTail({ logDir: dir, file: "bridge-2026-07-03.log", tail: 10 });
  assert.equal(result.count, 3);
  assert.equal(result.lines.join("\n").includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(result.lines.join("\n").includes("super-secret-value"), false);
  assert.ok(result.lines.some(line => line.includes("***")));
  assert.throws(() => readLogTail({ logDir: dir, file: "../bridge-2026-07-03.log" }), /invalid log file/);
});

test("redactLogLine masks common secret shapes", () => {
  assert.equal(redactLogLine("token: abcdefghijklmnop"), "token: ***");
  assert.equal(redactLogLine("Authorization=Bearer abcdefghijklmnop").includes("abcdefghijklmnop"), false);
  assert.equal(redactLogLine("sk-abcdefghijklmnop"), "sk-***");
});

test("admin route returns 403 for non-local requests", async () => {
  const writes = [];
  const req = {
    method: "GET",
    url: "/admin/status",
    socket: { remoteAddress: "10.0.0.8" },
    headers: {},
  };
  const res = {};
  const handled = await handleAdminApiRequest(req, res, {
    pathname: "/admin/status",
    url: new URL("http://localhost/admin/status"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });
  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 403);
});

test("container gateway admin route still requires the configured token", async () => {
  const writes = [];
  const req = {
    method: "GET",
    url: "/admin/status",
    socket: { remoteAddress: "172.18.0.1" },
    headers: { "x-qqfriend-admin-token": "token-a" },
  };
  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/status",
    url: new URL("http://localhost/admin/status"),
    containerized: true,
    requiredToken: "token-b",
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });
  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 403);
});

test("local sticker preview route streams an image by opaque catalog id", async () => {
  const response = { statusCode: 0, headers: {}, body: null };
  const req = {
    method: "GET",
    url: "/admin/stickers/image?id=sticker-a",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  };
  const res = {
    writeHead(statusCode, headers) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(body) {
      response.body = body;
    },
  };
  const handled = await handleAdminApiRequest(req, res, {
    pathname: "/admin/stickers/image",
    url: new URL("http://localhost/admin/stickers/image?id=sticker-a"),
    sendJson() {
      assert.fail("image response should not use JSON");
    },
    loadStickerPreview: async id => {
      assert.equal(id, "sticker-a");
      return { ok: true, buffer: Buffer.from("image"), mimeType: "image/png" };
    },
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "image/png");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.body.toString(), "image");
});

test("sticker preview route rejects non-local requests before loading the catalog", async () => {
  const writes = [];
  let loads = 0;
  const handled = await handleAdminApiRequest({
    method: "GET",
    url: "/admin/stickers/image?id=sticker-a",
    socket: { remoteAddress: "10.0.0.8" },
    headers: {},
  }, {}, {
    pathname: "/admin/stickers/image",
    url: new URL("http://localhost/admin/stickers/image?id=sticker-a"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
    loadStickerPreview: async () => {
      loads++;
      return { ok: false };
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 403);
  assert.equal(loads, 0);
});
