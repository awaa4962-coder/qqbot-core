import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";

import {
  buildBackupRestorePlan,
  buildCommandScaffold,
  buildPluginCatalog,
  createSafeBackup,
  handleAdminApiRequest,
  listSafeBackups,
  recordAdminAudit,
} from "../bridge/admin-api/index.mjs";

test("plugin catalog exposes readonly builtin module inventory", () => {
  const catalog = buildPluginCatalog();
  assert.equal(catalog.mode, "readonly-skeleton");
  assert.equal(catalog.count, catalog.plugins.length);
  const commands = catalog.plugins.find(plugin => plugin.id === "commands");
  assert.ok(commands);
  assert.equal(commands.actions.canInstall, false);
  assert.equal(commands.actions.canDisable, false);
});

test("command scaffold api previews and writes only safe template files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-scaffold-api-"));
  const preview = buildCommandScaffold({
    id: "hello-world",
    aliases: "hello,你好",
    helpLine: "hello-world help",
  }, { root });

  assert.equal(preview.write, false);
  assert.ok(preview.files.includes("bridge/commands/modules/hello-world.mjs"));
  assert.match(preview.manifestSnippet, /hello-world/);
  assert.equal(fs.existsSync(path.join(root, "bridge/commands/modules/hello-world.mjs")), false);

  const write = buildCommandScaffold({
    id: "hello-world",
    aliases: ["hello"],
    write: true,
  }, { root });
  assert.equal(write.write, true);
  assert.equal(fs.existsSync(path.join(root, "bridge/commands/modules/hello-world.mjs")), true);
});

test("safe backup excludes env files and raw chat memory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-backup-"));
  fs.mkdirSync(path.join(root, ".qqfriend"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"qqfriend\"}\n", "utf8");
  fs.writeFileSync(path.join(root, ".env_mimo"), "real-key", "utf8");
  fs.writeFileSync(path.join(root, "user_memory.json"), "{\"secret\":true}", "utf8");
  fs.writeFileSync(path.join(root, ".qqfriend", "index.json"), "{\"schemaVersion\":1}\n", "utf8");

  const backup = createSafeBackup({ root, name: "safe-test" });
  assert.ok(backup.included.includes("package.json"));
  assert.equal(backup.included.includes(".env_mimo"), false);
  assert.equal(backup.included.includes("user_memory.json"), false);
  assert.equal(fs.existsSync(path.join(root, "dist/admin-backups/safe-test/package.json")), true);
  assert.equal(fs.existsSync(path.join(root, "dist/admin-backups/safe-test/.env_mimo")), false);

  const backups = listSafeBackups(root);
  assert.equal(backups.backups.length, 1);
  const plan = buildBackupRestorePlan({ root, name: "safe-test" });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.executable, false);
});

test("admin command scaffold route supports isolated dry-run payloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-route-scaffold-"));
  const writes = [];
  const body = JSON.stringify({ id: "route-command", aliases: ["rc"], write: false });
  const req = Readable.from([body]);
  req.method = "POST";
  req.url = "/admin/command-scaffold";
  req.socket = { remoteAddress: "127.0.0.1" };
  req.headers = {};

  const handled = await handleAdminApiRequest(req, {}, {
    root,
    pathname: "/admin/command-scaffold",
    url: new URL("http://localhost/admin/command-scaffold"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 200);
  assert.equal(writes[0].payload.id, "route-command");
  assert.equal(fs.existsSync(path.join(root, "bridge/commands/modules/route-command.mjs")), false);
});

test("admin audit redacts secret-like values from action text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-audit-"));
  const auditFile = path.join(root, "admin-audit.log");
  const entry = recordAdminAudit({
    ts: "2026-07-04T00:00:00.000Z",
    action: "POST /admin/config sk-1234567890abcdef1234567890abcdef",
    method: "POST",
    pathname: "/admin/config",
    remoteAddress: "127.0.0.1",
    queryKeys: ["token", "file"],
  }, { file: auditFile });

  assert.equal(entry.action.includes("sk-123456"), false);
  assert.deepEqual(entry.queryKeys, ["token", "file"]);
  assert.equal(fs.existsSync(auditFile), true);
  fs.rmSync(root, { recursive: true, force: true });
});
