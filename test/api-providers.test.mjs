import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { callApiProvider, callTaskApi } from "../bridge/api-providers/gateway.mjs";
import { findApiPreset, listApiPresets } from "../bridge/api-providers/presets.mjs";
import {
  applyApiProviderAction,
  buildApiProviderManagerSnapshot,
  testApiProvider,
} from "../bridge/admin-api/api-provider-manager.mjs";
import {
  buildApiConfigSnapshot,
  createDefaultApiConfig,
  loadApiConfig,
  readProviderSecret,
  saveApiProvider,
  saveApiRoutes,
  validateProviderEndpoint,
} from "../bridge/api-providers/store.mjs";
import { buildOutputPacket } from "../bridge/output-pipeline.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("API provider presets and storage", () => {
  it("offers separate MiMo 2.6 tiers and the canonical multimodal DeepSeek Flash preset", () => {
    for (const [id, model] of [["mimo-official", "mimo-v2.6-flash"], ["mimo-pro-official", "mimo-v2.6-pro"], ["deepseek-official", "deepseek-flash"]]) {
      const preset = findApiPreset(id);
      assert.equal(preset.model, model);
      assert.ok(preset.capabilities.includes("vision"));
      assert.ok(preset.capabilities.includes("reasoning"));
      assert.equal(preset.protocol, "openai-chat");
    }
    assert.equal(findApiPreset("mimo-pro-official").tokenField, "max_completion_tokens");
  });

  it("new presets do not silently overwrite already saved model IDs or task reasoning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-model-refresh-"));
    try {
      const stored = createDefaultApiConfig();
      stored.providers.mimo.model = "mimo-v2.5";
      stored.providers.deepseek.model = "deepseek-v4-flash";
      stored.routes.group_chat.reasoning = "deep";
      fs.mkdirSync(path.join(root, ".qqfriend"));
      fs.writeFileSync(path.join(root, ".qqfriend/api-providers.json"), JSON.stringify(stored));
      const loaded = loadApiConfig({ root });
      assert.equal(loaded.providers.mimo.model, "mimo-v2.5");
      assert.equal(loaded.providers.deepseek.model, "deepseek-v4-flash");
      assert.deepEqual(loaded.routes, stored.routes);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("ships protocol presets without secrets", () => {
    const presets = listApiPresets();
    assert.ok(presets.length >= 20);
    assert.ok(presets.some(item => item.protocol === "openai-chat"));
    assert.ok(presets.some(item => item.protocol === "openai-responses"));
    assert.ok(presets.some(item => item.protocol === "anthropic-messages"));
    assert.ok(presets.some(item => item.protocol === "gemini-native"));
    assert.equal(JSON.stringify(presets).includes("apiKey"), false);
  });

  it("uses DeepSeek V4.1 Flash for summaries while protecting the group-chat fallback", () => {
    const config = createDefaultApiConfig();
    assert.equal(config.schemaVersion, 2);
    assert.equal(config.routes.group_chat.primary, "mimo");
    assert.equal(config.routes.group_chat.fallback, "deepseek");
    assert.equal(config.routes.group_chat.reasoning, "auto");
    assert.equal(config.routes.interjection.reasoning, "economy");
    assert.equal(config.routes.private_chat.primary, "deepseek");
    assert.equal(config.routes.group_summary.primary, "deepseek");
    assert.equal(config.routes.group_summary.fallback, "mimo");
    assert.equal(config.routes.group_summary.reasoning, "economy");
    assert.equal(config.routes.vision.primary, "mimo");
    assert.equal(config.routes.vision.fallback, null);
    assert.equal(config.routes.vision.reasoning, "economy");
    assert.equal(config.providers.deepseek.name, "DeepSeek V4.1 Flash");
    assert.equal(config.providers.deepseek.model, "deepseek-flash");
    assert.ok(config.providers.deepseek.capabilities.includes("vision"));
  });

  it("migrates legacy routes to task reasoning defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-migrate-"));
    const legacy = createDefaultApiConfig();
    legacy.schemaVersion = 1;
    for (const route of Object.values(legacy.routes)) delete route.reasoning;
    fs.mkdirSync(path.join(root, ".qqfriend"), { recursive: true });
    fs.writeFileSync(path.join(root, ".qqfriend", "api-providers.json"), JSON.stringify(legacy), "utf8");

    const migrated = loadApiConfig({ root });
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.routes.group_chat.reasoning, "auto");
    assert.equal(migrated.routes.group_summary.reasoning, "economy");
    assert.equal(migrated.routes.sticker_select.reasoning, "economy");
  });

  it("persists valid reasoning modes and rejects unknown modes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-reasoning-"));
    saveApiRoutes({
      group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "deep" },
    }, { root });
    assert.equal(loadApiConfig({ root }).routes.group_chat.reasoning, "deep");
    assert.throws(() => saveApiRoutes({
      group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "maximum" },
    }, { root }), /不支持的思考档位/);
  });

  it("caches runtime files without returning mutable shared config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-cache-"));
    const first = loadApiConfig({ root });
    first.providers.mimo.model = "mutated-only-in-caller";
    assert.equal(loadApiConfig({ root }).providers.mimo.model, "mimo-v2.6-flash");

    saveApiRoutes({
      group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "deep" },
    }, { root });
    assert.equal(loadApiConfig({ root }).routes.group_chat.reasoning, "deep");

    const provider = loadApiConfig({ root }).providers.mimo;
    fs.writeFileSync(path.join(root, ".env_mimo"), "test-cache-secret-one", "utf8");
    assert.equal(readProviderSecret(provider, { root }), "test-cache-secret-one");
    saveApiProvider({ ...provider, key: "test-cache-secret-two" }, { root, mode: "update" });
    assert.equal(readProviderSecret(provider, { root }), "test-cache-secret-two");
  });

  it("stores custom keys outside the public JSON snapshot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-"));
    const secret = "sk-test-secret-123456";
    saveApiProvider({
      id: "other-model",
      name: "其他模型",
      presetId: "custom-openai-chat",
      protocol: "openai-chat",
      endpoint: "https://api.example.com/v1/chat/completions",
      model: "mystery-model",
      auth: "bearer",
      capabilities: ["text"],
      key: secret,
    }, { root });

    const stored = loadApiConfig({ root });
    assert.equal(stored.providers["other-model"].model, "mystery-model");
    assert.equal(fs.readFileSync(path.join(root, ".env_api_other-model"), "utf8"), secret);
    const snapshot = buildApiConfigSnapshot({ root });
    assert.equal(snapshot.providers.find(item => item.id === "other-model").keyConfigured, true);
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(JSON.stringify(snapshot).includes("secretFile"), false);
  });

  it("never lets create mode overwrite an existing provider", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-create-"));
    assert.throws(() => saveApiProvider({
      id: "mimo",
      name: "不应覆盖",
      presetId: "mimo-official",
      protocol: "openai-chat",
      endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
      model: "other-model",
      auth: "bearer",
      capabilities: ["text"],
    }, { root, mode: "create" }), /已存在.*不会覆盖/);

    const stored = loadApiConfig({ root });
    assert.equal(stored.providers.mimo.name, "MiMo 2.6 Flash");
    assert.equal(stored.providers.mimo.model, "mimo-v2.6-flash");
  });

  it("requires update mode to target an existing provider", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-update-"));
    assert.throws(() => saveApiProvider({
      id: "missing-provider",
      name: "不存在",
      presetId: "custom-openai-chat",
      protocol: "openai-chat",
      endpoint: "https://api.example.com/v1/chat/completions",
      model: "missing",
      auth: "bearer",
      capabilities: ["text"],
    }, { root, mode: "update" }), /不存在/);
  });

  it("passes create mode through the admin manager", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-manager-"));
    await assert.rejects(() => applyApiProviderAction({
      action: "save-provider",
      mode: "create",
      provider: {
        id: "mimo",
        name: "重复实例",
        presetId: "mimo-official",
        protocol: "openai-chat",
        endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
        model: "mimo-v2.5",
        auth: "bearer",
        capabilities: ["text"],
      },
    }, { root }), /已存在.*不会覆盖/);
  });

  it("refuses to remove the protected DeepSeek group fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-routes-"));
    assert.throws(() => saveApiRoutes({
      group_chat: { primary: "mimo", fallback: null },
    }, { root }), /DeepSeek/);
  });

  it("rejects disabling an in-use provider before writing config or a replacement key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-disable-"));
    saveApiRoutes({ private_chat: { primary: "mimo", fallback: "deepseek" } }, { root });
    const file = path.join(root, ".qqfriend", "api-providers.json");
    const before = fs.readFileSync(file, "utf8");
    for (const id of ["mimo", "deepseek"]) {
      assert.throws(() => saveApiProvider({ id, enabled: false, key: "synthetic-replacement-key" }, { root }), /先切换插槽再停用/);
    }
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, ".env_mimo")), false);
    assert.equal(loadApiConfig({ root }).routes.private_chat.primary, "mimo");
  });

  it("fails closed on an invalid saved route instead of replacing all configured routes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-corrupt-"));
    const config = createDefaultApiConfig();
    config.routes.private_chat.primary = "missing-provider";
    fs.mkdirSync(path.join(root, ".qqfriend"), { recursive: true });
    fs.writeFileSync(path.join(root, ".qqfriend", "api-providers.json"), JSON.stringify(config));
    assert.throws(() => loadApiConfig({ root }), /已停止模型调用/);
    globalThis.fetch = () => assert.fail("invalid saved config must never reach a provider");
    const result = await callTaskApi("group_chat", "primary", basicRequest(), { root });
    assert.equal(result.ok, false);
    assert.equal(result.raw, null);
    assert.equal((await callApiProvider("mimo", basicRequest(), { root })).ok, false);
  });

  it("defaults only for an absent config and rejects corrupt JSON or saved provider data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-invalid-"));
    assert.equal(loadApiConfig({ root }).routes.group_chat.primary, "mimo");
    fs.mkdirSync(path.join(root, ".qqfriend"), { recursive: true });
    const file = path.join(root, ".qqfriend", "api-providers.json");
    for (const value of ["{", "null", "[]", "{}", '{"routes":[]}', '{"providers":{"mimo":{"endpoint":"invalid"}},"routes":{}}']) {
      fs.writeFileSync(file, value);
      assert.throws(() => loadApiConfig({ root }), /API 配置无效/);
    }
    for (const route of [
      { primary: "mimo", fallback: "deepseek", reasoning: "invalid" },
      { primary: "mimo", fallback: null, reasoning: "auto" },
    ]) {
      const config = createDefaultApiConfig();
      config.routes.group_chat = route;
      fs.writeFileSync(file, JSON.stringify(config));
      assert.throws(() => loadApiConfig({ root }), /API 配置无效/);
    }
  });

  it("still permits disabling an unused custom provider", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-idle-"));
    saveApiProvider({ id: "idle-node", presetId: "ollama-local", model: "synthetic" }, { root });
    saveApiProvider({ id: "idle-node", enabled: false }, { root });
    assert.equal(loadApiConfig({ root }).providers["idle-node"].enabled, false);
    assert.equal(loadApiConfig({ root }).routes.group_chat.fallback, "deepseek");
  });

  it("exposes a read-only invalid-config recovery view and can roll back without overwriting it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-recovery-"));
    saveApiRoutes({ private_chat: { primary: "mimo", fallback: null } }, { root });
    saveApiRoutes({ private_chat: { primary: "deepseek", fallback: null } }, { root });
    const file = path.join(root, ".qqfriend", "api-providers.json");
    const corrupt = '{"synthetic-corrupt":';
    fs.writeFileSync(file, corrupt);
    const snapshot = buildApiProviderManagerSnapshot({ root });
    assert.match(snapshot.configurationError, /已停止模型调用/);
    assert.equal(snapshot.rollbackAvailable, true);
    assert.deepEqual(snapshot.providers, []);
    assert.deepEqual(snapshot.routes, {});
    assert.deepEqual(snapshot.tasks, []);
    assert.throws(() => saveApiRoutes({}, { root }), /API 配置无效/);
    assert.throws(() => saveApiProvider({ id: "mimo", name: "accidental overwrite" }, { root }), /API 配置无效/);
    assert.equal(fs.readFileSync(file, "utf8"), corrupt);
    const result = await applyApiProviderAction({ action: "rollback" }, { root });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.configurationError, null);
    assert.equal(loadApiConfig({ root }).routes.private_chat.primary, "mimo");
  });

  it("allows opted-in loopback models and blocks private network endpoints", () => {
    assert.doesNotThrow(() => validateProviderEndpoint({
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      allowLocal: true,
      model: "local",
    }));
    assert.throws(() => validateProviderEndpoint({
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      allowLocal: false,
      model: "local",
    }), /本地模型模式/);
    assert.throws(() => validateProviderEndpoint({
      endpoint: "https://192.168.1.2/v1/chat/completions",
      model: "private",
    }), /内网/);
  });
});

describe("API protocol adapters", () => {
  it("applies task reasoning to both MiMo and DeepSeek", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-gateway-"));
    saveApiRoutes({
      group_chat: { primary: "mimo", fallback: "deepseek", reasoning: "deep" },
    }, { root });
    fs.writeFileSync(path.join(root, ".env_mimo"), "sk-test-mimo-key", "utf8");
    fs.writeFileSync(path.join(root, ".env_ds"), "sk-test-ds-key", "utf8");
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      };
    };

    const primary = await callTaskApi("group_chat", "primary", basicRequest(), { root });
    const fallback = await callTaskApi("group_chat", "fallback", basicRequest(), { root });
    assert.deepEqual(bodies[0].thinking, { type: "enabled" });
    assert.deepEqual(bodies[1].thinking, { type: "enabled" });
    assert.equal(primary.reasoningPolicy.effectiveMode, "deep");
    assert.equal(fallback.reasoningPolicy.applied, true);
  });

  it("keeps the default DeepSeek summary budget for final text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-summary-reasoning-"));
    fs.writeFileSync(path.join(root, ".env_ds"), "sk-test-ds-key", "utf8");
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "日报正文" } }] }),
      };
    };

    const result = await callTaskApi("group_summary", "primary", basicRequest(), { root });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(result.reasoningPolicy.effectiveMode, "economy");
    assert.equal(result.reasoningPolicy.applied, true);
  });

  it("allows a summary recovery call to force non-thinking output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-summary-recovery-"));
    saveApiRoutes({
      group_summary: { primary: "deepseek", fallback: "mimo", reasoning: "deep" },
    }, { root });
    fs.writeFileSync(path.join(root, ".env_mimo"), "sk-test-mimo-key", "utf8");
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "恢复正文" } }] }),
      };
    };

    const result = await callTaskApi("group_summary", "fallback", basicRequest(), {
      root,
      reasoningMode: "economy",
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(result.reasoningPolicy.configuredMode, "economy");
    assert.equal(result.reasoningPolicy.effectiveMode, "economy");
  });

  it("disables private reasoning during provider connection tests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-api-connection-test-"));
    fs.writeFileSync(path.join(root, ".env_ds"), "sk-test-ds-key", "utf8");
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "OK", reasoning_content: "private" } }],
        }),
      };
    };

    const result = await testApiProvider("deepseek", { root });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(result.ok, true);
    assert.equal(result.output, "OK");
  });

  it("normalizes Responses output into the shared output pipeline", async () => {
    mockJsonResponse({
      id: "resp-1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "响应正常" }] }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    const provider = testProvider({
      id: "responses-test",
      protocol: "openai-responses",
      endpoint: "https://example.com/v1/responses",
    });
    const result = await callApiProvider(provider.id, basicRequest(), {
      provider,
      key: "sk-test-key",
    });
    const packet = buildOutputPacket(result.raw, { provider: result.provider });
    assert.equal(packet.text, "响应正常");
  });

  it("keeps Anthropic thinking blocks out of final text", async () => {
    mockJsonResponse({
      id: "msg-1",
      content: [
        { type: "thinking", thinking: "内部推理不能外发" },
        { type: "text", text: "最终答案" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    const provider = testProvider({
      id: "anthropic-test",
      protocol: "anthropic-messages",
      endpoint: "https://example.com/v1/messages",
      auth: "x-api-key",
    });
    const result = await callApiProvider(provider.id, basicRequest(), {
      provider,
      key: "sk-test-key",
    });
    const packet = buildOutputPacket(result.raw, { provider: result.provider });
    assert.equal(packet.text, "最终答案");
    assert.equal(packet.text.includes("内部推理"), false);
  });

  it("converts Gemini candidates and rejects HTTP redirects", async () => {
    let requestOptions = null;
    globalThis.fetch = async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Gemini 正常" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
        }),
      };
    };
    const provider = testProvider({
      id: "gemini-test",
      protocol: "gemini-native",
      endpoint: "https://example.com/models/{model}:generateContent",
      auth: "x-goog-api-key",
    });
    const result = await callApiProvider(provider.id, basicRequest(), {
      provider,
      key: "sk-test-key",
    });
    assert.equal(buildOutputPacket(result.raw).text, "Gemini 正常");
    assert.equal(requestOptions.redirect, "error");
    assert.equal(requestOptions.headers["x-goog-api-key"], "sk-test-key");
  });
});

function testProvider(overrides = {}) {
  return {
    id: "test",
    name: "测试接口",
    protocol: "openai-chat",
    endpoint: "https://example.com/v1/chat/completions",
    model: "test-model",
    auth: "bearer",
    tokenField: "max_tokens",
    allowLocal: false,
    capabilities: ["text", "vision", "tools", "reasoning"],
    enabled: true,
    ...overrides,
  };
}

function basicRequest() {
  return {
    messages: [{ role: "user", content: "你好" }],
    maxTokens: 32,
    temperature: 0,
  };
}

function mockJsonResponse(value) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  });
}
