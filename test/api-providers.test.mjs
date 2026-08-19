import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { callApiProvider, callTaskApi } from "../bridge/api-providers/gateway.mjs";
import { listApiPresets } from "../bridge/api-providers/presets.mjs";
import {
  applyApiProviderAction,
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
  it("ships protocol presets without secrets", () => {
    const presets = listApiPresets();
    assert.ok(presets.length >= 20);
    assert.ok(presets.some(item => item.protocol === "openai-chat"));
    assert.ok(presets.some(item => item.protocol === "openai-responses"));
    assert.ok(presets.some(item => item.protocol === "anthropic-messages"));
    assert.ok(presets.some(item => item.protocol === "gemini-native"));
    assert.equal(JSON.stringify(presets).includes("apiKey"), false);
  });

  it("uses DeepSeek V4 Flash for summaries while protecting the group-chat fallback", () => {
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
    assert.equal(config.providers.deepseek.name, "DeepSeek V4 Flash");
    assert.equal(config.providers.deepseek.model, "deepseek-v4-flash");
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
    assert.equal(loadApiConfig({ root }).providers.mimo.model, "mimo-v2.5");

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
    assert.equal(stored.providers.mimo.name, "MiMo 主力");
    assert.equal(stored.providers.mimo.model, "mimo-v2.5");
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
