import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { after, test } from "node:test";
const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "qqfriend-p5-api-conflict-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") });
const { buildApiConfigSnapshot, saveApiProvider, saveApiRoutes, loadApiConfig, rollbackApiConfig } = await import("../bridge/api-providers/store.mjs");
const { applyApiProviderAction } = await import("../bridge/admin-api/api-provider-manager.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
after(() => { cleanupLogger(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
const configFile = directory => path.join(directory, ".qqfriend", "api-providers.json");
const previousFile = directory => path.join(directory, ".qqfriend", "api-providers.previous.json");
const conflict = error => error.code === "api_config_conflict" && !/synthetic-key/.test(error.message);

test("all API manager mutations reject stale byte revisions before keys, backup or config writes", async () => {
  const directory = path.join(root, "stale");
  saveApiProvider({ id: "idle-p5", presetId: "mimo-official", model: "synthetic-model", key: "synthetic-key-old" }, { root: directory });
  const stale = buildApiConfigSnapshot({ root: directory }).configurationRevision;
  saveApiRoutes({ private_chat: { primary: "mimo", fallback: null } }, { root: directory });
  const before = fs.readFileSync(configFile(directory), "utf8"), previous = fs.readFileSync(previousFile(directory), "utf8");
  const secretPath = path.join(directory, loadApiConfig({ root: directory }).providers["idle-p5"].secretFile);
  const secret = fs.readFileSync(secretPath, "utf8");
  const mutations = [
    { action: "save-provider", mode: "update", provider: { id: "idle-p5", name: "stale-name", key: "synthetic-key-new" } },
    { action: "save-routes", routes: { private_chat: { primary: "deepseek", fallback: null } } },
    { action: "delete-provider", providerId: "idle-p5" }, { action: "rollback" },
  ];
  for (const mutation of mutations) await assert.rejects(() => applyApiProviderAction({ ...mutation, configurationRevision: stale },
    { root: directory, requireRevision: true }), conflict);
  assert.equal(fs.readFileSync(configFile(directory), "utf8"), before);
  assert.equal(fs.readFileSync(previousFile(directory), "utf8"), previous);
  assert.equal(fs.readFileSync(secretPath, "utf8"), secret);
});
test("one authoritative current revision can commit once, not twice after a preflight read", async () => {
  const directory = path.join(root, "once"), configurationRevision = buildApiConfigSnapshot({ root: directory }).configurationRevision;
  const payload = { action: "save-routes", configurationRevision, routes: { private_chat: { primary: "mimo", fallback: null } } };
  const result = await applyApiProviderAction(payload, { root: directory, requireRevision: true });
  assert.equal(result.ok, true); assert.notEqual(result.snapshot.configurationRevision, configurationRevision);
  await assert.rejects(() => applyApiProviderAction(payload, { root: directory, requireRevision: true }), conflict);
  assert.equal(loadApiConfig({ root: directory }).routes.private_chat.primary, "mimo");
});
test("rollback advances numeric revisions and its byte token cannot pass as the previous current config", () => {
  const directory = path.join(root, "rollback");
  saveApiRoutes({ private_chat: { primary: "mimo", fallback: null } }, { root: directory });
  saveApiRoutes({ private_chat: { primary: "deepseek", fallback: null } }, { root: directory });
  const before = buildApiConfigSnapshot({ root: directory });
  const afterRollback = rollbackApiConfig({ root: directory, expectedConfigurationRevision: before.configurationRevision });
  assert.ok(afterRollback.revision > before.revision);
  assert.notEqual(afterRollback.configurationRevision, before.configurationRevision);
  assert.equal(afterRollback.routes.private_chat.primary, "mimo");
  assert.throws(() => saveApiRoutes({}, { root: directory, expectedConfigurationRevision: before.configurationRevision }), conflict);
});
test("invalid config recovery still requires its exact byte token and preserves intervening corruption", async () => {
  const directory = path.join(root, "recovery");
  saveApiRoutes({ private_chat: { primary: "mimo", fallback: null } }, { root: directory });
  saveApiRoutes({ private_chat: { primary: "deepseek", fallback: null } }, { root: directory });
  fs.writeFileSync(configFile(directory), '{"broken-first":');
  const oldView = buildApiConfigSnapshot({ root: directory });
  fs.writeFileSync(configFile(directory), '{"broken-second":');
  await assert.rejects(() => applyApiProviderAction({ action: "rollback", configurationRevision: oldView.configurationRevision },
    { root: directory, requireRevision: true }), conflict);
  assert.equal(fs.readFileSync(configFile(directory), "utf8"), '{"broken-second":');
  const fresh = buildApiConfigSnapshot({ root: directory });
  assert.equal(fresh.revision, 0); assert.match(fresh.configurationRevision, /^[a-f0-9]{64}$/);
  const recovered = await applyApiProviderAction({ action: "rollback", configurationRevision: fresh.configurationRevision },
    { root: directory, requireRevision: true });
  assert.equal(recovered.ok, true); assert.equal(recovered.snapshot.configurationError, null);
});
test("revision exhaustion rejects before sidecar or backup mutation", () => {
  const directory = path.join(root, "exhausted");
  saveApiProvider({ id: "idle-p5", presetId: "mimo-official", model: "synthetic-model", key: "synthetic-key-old" }, { root: directory });
  const config = loadApiConfig({ root: directory }); config.revision = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(configFile(directory), JSON.stringify(config));
  const before = fs.readFileSync(configFile(directory), "utf8"), previous = fs.existsSync(previousFile(directory)) ? fs.readFileSync(previousFile(directory), "utf8") : null;
  const secretPath = path.join(directory, config.providers["idle-p5"].secretFile), secret = fs.readFileSync(secretPath, "utf8");
  assert.throws(() => saveApiProvider({ id: "idle-p5", key: "synthetic-key-new" }, { root: directory }), /版本已达到上限/);
  assert.throws(() => saveApiRoutes({}, { root: directory }), /版本已达到上限/);
  assert.equal(fs.readFileSync(configFile(directory), "utf8"), before);
  assert.equal(fs.existsSync(previousFile(directory)) ? fs.readFileSync(previousFile(directory), "utf8") : null, previous);
  assert.equal(fs.readFileSync(secretPath, "utf8"), secret);
});
async function post(payload) {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
  Object.assign(request, { method: "POST", url: "/admin/api-providers", socket: { remoteAddress: "127.0.0.1" }, headers: {} });
  let response;
  await handleAdminApiRequest(request, {}, { pathname: request.url, sendJson: (_res, status, body) => { response = { status, body }; } });
  return response;
}
test("actual HTTP mutation endpoint requires revision and returns 409 on stale write", async () => {
  const initial = buildApiConfigSnapshot({ root });
  assert.equal((await post({ action: "save-routes", routes: {} })).status, 409);
  const payload = { action: "save-routes", routes: {}, configurationRevision: initial.configurationRevision };
  assert.equal((await post(payload)).status, 200);
  const stale = await post(payload); assert.equal(stale.status, 409);
  assert.doesNotMatch(JSON.stringify(stale.body), /synthetic-key|api-providers\.json|\/config/);
});
