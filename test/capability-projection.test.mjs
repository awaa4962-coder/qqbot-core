import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-capability-projection-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: root, QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { COMMAND_DEFINITIONS } = await import("../bridge/commands/manifest.mjs");
const { buildCommandCatalog } = await import("../bridge/admin-api/command-catalog.mjs");
const { CAPABILITY_DEFINITIONS, buildCapabilityCatalog, commandCapabilityIds } = await import("../bridge/capabilities/catalog.mjs");
const { createDefaultApiConfig } = await import("../bridge/api-providers/store.mjs");
const { readApiProviderHealth } = await import("../bridge/api-providers/health.mjs");
const { buildBotSelfContext } = await import("../bridge/capabilities/self-context.mjs");
const { MODULE_DEFINITIONS } = await import("../bridge/modules/manifest.mjs");
const { buildCommandReplyAsync } = await import("../bridge/commands/dispatcher.mjs");
const { handleGroupMessage } = await import("../bridge/reply-group.mjs");

after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const cfg = { ...CFG, groupWhitelist: [100], friendWhitelist: [200], adminUins: [300],
    summaryGroupWhitelist: [100], resourceGroupWhitelist: [100], featureGroupWhitelist: [100],
    conversationSummaryGroupWhitelist: [100], jmUserWhitelist: [200], linkPreviewEnabled: true,
    stickerEnabled: false, ...overrides };
  const config = createDefaultApiConfig();
  const modelHealth = readApiProviderHealth({ config, readSecret: () => "synthetic-secret" });
  const options = { cfg, modelHealth, jmHealth: { dependencyReady: true, sevenZipReady: true }, stickerSettings: { mode: "off" } };
  return { cfg, config, modelHealth, options, find: (id, scope = {}) => buildCapabilityCatalog({ ...options, ...scope }).capabilities.find(item => item.id === id) };
}

test("every live command maps to a declared capability and uses its permission", () => {
  const ids = new Set(CAPABILITY_DEFINITIONS.map(item => item.id));
  const modules = new Set(MODULE_DEFINITIONS.map(item => item.id));
  assert.ok(CAPABILITY_DEFINITIONS.every(item => modules.has(item.moduleId)), "capability without a shipped module");
  const live = COMMAND_DEFINITIONS.filter(item => !item.retired && !["help-page-1", "help-page-2"].includes(item.id));
  assert.ok(live.every(item => item.capabilityId && ids.has(item.capabilityId)), "live command without a capability");
  assert.deepEqual(commandCapabilityIds(), new Set(live.map(item => item.capabilityId)));
  const commandCatalog = buildCommandCatalog().commands;
  for (const command of live) assert.equal(commandCatalog.find(item => item.id === command.id).capabilityId, command.capabilityId);
  for (const capability of CAPABILITY_DEFINITIONS) {
    const related = live.filter(item => item.capabilityId === capability.id);
    if (!related.length) continue;
    const visible = fixture().find(capability.id, { surface: "console" });
    assert.equal(visible.permission, related.some(item => item.permission === "admin") ? "admin" : "user");
  }
});

test("automatic capabilities remain visible without inventing a command alias", () => {
  const { options } = fixture();
  const catalog = buildCapabilityCatalog({ ...options, surface: "group", userId: 200, groupId: 100 });
  for (const id of ["chat.reply", "vision.context", "group.summary", "memes.stickers"]) {
    assert.ok(catalog.capabilities.some(item => item.id === id));
  }
  assert.ok(!COMMAND_DEFINITIONS.some(item => item.capabilityId === "vision.context"));
});

test("direct visual chat remains available when the separate description route is unavailable", () => {
  const f = fixture();
  f.config.providers.mimo.capabilities = ["text", "vision"];
  f.config.providers.deepseek.capabilities = ["text"];
  f.config.routes.vision = { primary: "deepseek", fallback: null };
  const modelHealth = readApiProviderHealth({ config: f.config, readSecret: () => "synthetic-secret" });
  assert.equal(modelHealth.tasks.group_chat.primary.ready, true);
  assert.equal(modelHealth.tasks.vision.ready, false);
  const view = buildCapabilityCatalog({ ...f.options, modelHealth, surface: "group", userId: 200, groupId: 100 });
  assert.equal(view.capabilities.find(item => item.id === "vision.context").status, "available");
  const facts = buildBotSelfContext({ surface: "group", userId: 200, groupId: 100 }, { model: "synthetic-model" },
    { ...f.options, modelHealth });
  assert.match(facts.content, /图片与表情包理解/);
  assert.doesNotMatch(facts.content, /synthetic-secret/);
});

test("configuration, module state, permission and unknown health are distinct facts", () => {
  const f = fixture({ summaryGroupWhitelist: [], linkPreviewEnabled: true });
  const none = f.find("group.summary", { surface: "group", userId: 200, groupId: 100 });
  assert.equal(none.state.enabled, false);
  assert.equal(none.state.permitted, false);
  const overridden = f.find("group.link-preview", { surface: "console",
    moduleStates: [{ id: "link-preview", enabled: false, health: "disabled" }] });
  assert.equal(overridden.state.enabled, false);
  assert.equal(overridden.status, "unavailable");
  const reserved = f.find("admin.relationship-export", { surface: "console" });
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.state.installed, false);
  const unknown = f.find("group.link-preview", { surface: "group", groupId: 100 });
  assert.equal(unknown.state.permitted, null, "missing actor cannot prove blacklist or admin status");
  assert.equal(unknown.state.health, "not_checked");
  assert.ok(MODULE_DEFINITIONS.some(item => item.id === "link-preview"));
});

test("non-admin never receives admin command details and private JM retains its own whitelist", () => {
  const f = fixture();
  const ordinary = buildCapabilityCatalog({ ...f.options, surface: "private", userId: 200 });
  assert.ok(ordinary.capabilities.every(item => item.permission !== "admin"));
  const admin = buildCapabilityCatalog({ ...f.options, surface: "private", userId: 300 });
  assert.equal(admin.capabilities.find(item => item.id === "admin.operations").state.permitted, true);
  assert.equal(admin.capabilities.find(item => item.id === "resources.jm").state.permitted, false);
  assert.equal(admin.capabilities.find(item => item.id === "chat.reply").state.permitted, false);
});

test("permission is checked again at execution after a capability snapshot", async t => {
  const f = fixture();
  assert.equal(f.find("admin.operations", { surface: "private", userId: 300 }).state.permitted, true);
  assert.match(await buildCommandReplyAsync("runtime", { userId: 300, admins: [300] }), /夜星运行状态/);
  assert.equal(await buildCommandReplyAsync("runtime", { userId: 300, admins: [] }), "这个命令需要管理员权限。");
  const originalGroups = CFG.groupWhitelist;
  CFG.groupWhitelist = [];
  t.after(() => { CFG.groupWhitelist = originalGroups; });
  t.mock.method(globalThis, "fetch", () => assert.fail("blocked group must not send or call a model"));
  await handleGroupMessage({ message_type: "group", group_id: 100, user_id: 200, message_id: 70100,
    text: "@夜星 状态", rawText: "@夜星 状态", nickname: "Synthetic", isAtMe: true,
    mentions: [], images: [], files: [], replyData: null }, []);
});

test("primary and fallback health are reported separately without claiming network connectivity", () => {
  const f = fixture();
  const health = { tasks: { group_chat: { ready: true, primary: { ready: false }, fallback: { ready: true } },
    private_chat: { ready: true, primary: { ready: true }, fallback: { ready: false } } } };
  const catalog = buildCapabilityCatalog({ ...f.options, modelHealth: health, surface: "group", groupId: 100, userId: 200 });
  const chat = catalog.capabilities.find(item => item.id === "chat.reply");
  assert.equal(chat.status, "limited");
  assert.equal(chat.state.health, "partially_configured");
  const direct = buildCapabilityCatalog({ ...f.options, modelHealth: health, surface: "private", userId: 200 });
  assert.equal(direct.capabilities.find(item => item.id === "chat.reply").statusLabel, "备用不可用");
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-secret|\.env_mimo|\.env_ds/);
});

test("daily summary can degrade locally while member summary needs a configured model", () => {
  const f = fixture();
  const modelHealth = { tasks: { ...f.modelHealth.tasks,
    group_summary: { ready: false, primary: { ready: false } },
    conversation_summary: { ready: false, primary: { ready: false } } } };
  const view = buildCapabilityCatalog({ ...f.options, modelHealth, surface: "group", groupId: 100, userId: 200 });
  const byId = id => view.capabilities.find(item => item.id === id);
  assert.equal(byId("group.summary").status, "limited");
  assert.equal(byId("group.summary").state.enabled, true);
  assert.equal(byId("group.conversation-summary").status, "unavailable");
  assert.equal(byId("group.conversation-summary").state.health, "configuration_error");
});

test("a degraded memory store appears degraded without changing admin access", () => {
  const f = fixture();
  const view = buildCapabilityCatalog({ ...f.options, surface: "private", userId: 300,
    moduleStates: [{ id: "memory", enabled: true, health: "degraded" }] });
  const memory = view.capabilities.find(item => item.id === "personal.memory");
  assert.equal(memory.status, "limited");
  assert.equal(memory.state.health, "degraded");
  assert.equal(view.capabilities.find(item => item.id === "admin.operations").state.permitted, true);
});
