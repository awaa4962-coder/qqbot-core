import test from "node:test";
import assert from "node:assert/strict";
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
