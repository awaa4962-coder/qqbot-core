import { buildOutputPacket } from "../output-pipeline.mjs";
import { callApiProvider } from "../api-providers/gateway.mjs";
import { API_PROTOCOLS, listApiPresets } from "../api-providers/presets.mjs";
import { applyReasoningPolicy } from "../api-providers/reasoning-policy.mjs";
import {
  buildApiConfigSnapshot,
  deleteApiProvider,
  getProvider,
  rollbackApiConfig,
  saveApiProvider,
  saveApiRoutes,
} from "../api-providers/store.mjs";

export function buildApiProviderManagerSnapshot(options = {}) {
  return {
    ...buildApiConfigSnapshot(options),
    protocols: API_PROTOCOLS.map(item => ({ ...item, capabilities: [...item.capabilities] })),
    presets: listApiPresets(),
    guide: {
      title: "三分钟接入其他模型",
      steps: [
        "文档里有 /chat/completions：选择 OpenAI Chat 兼容预设。",
        "文档里有 /responses：选择 Responses 兼容预设。",
        "文档里有 /v1/messages：选择 Anthropic 兼容预设。",
        "文档地址以 :generateContent 结尾：选择 Gemini 原生预设。",
        "保存实例后先测试连接，通过后再装入任务插槽。",
      ],
    },
  };
}

export async function applyApiProviderAction(payload, options = {}) {
  const action = String(payload?.action || "").trim();
  if (action === "save-provider") {
    const mode = payload?.mode === "create" ? "create" : "update";
    const provider = saveApiProvider(payload.provider || {}, { ...options, mode });
    return {
      ok: true,
      message: mode === "create"
        ? "新 API 实例已创建，任务插槽尚未改变"
        : "API 实例修改已保存，任务插槽尚未改变",
      provider,
      snapshot: buildApiProviderManagerSnapshot(options),
    };
  }
  if (action === "test-provider") return await testApiProvider(payload.providerId, options);
  if (action === "save-routes") {
    const routes = saveApiRoutes(payload.routes || {}, options);
    return {
      ok: true,
      message: "任务插槽已切换，新请求立即使用新路由",
      routes,
      snapshot: buildApiProviderManagerSnapshot(options),
    };
  }
  if (action === "rollback") {
    return {
      ok: true,
      message: "已恢复上一版 API 路由和实例配置",
      snapshot: rollbackApiConfig(options),
    };
  }
  if (action === "delete-provider") {
    const result = deleteApiProvider(payload.providerId, options);
    return {
      ...result,
      message: "API 实例已删除",
      snapshot: buildApiProviderManagerSnapshot(options),
    };
  }
  throw new Error("未知 API 管理操作");
}

export async function testApiProvider(providerId, options = {}) {
  const provider = getProvider(providerId, options);
  const baseRequest = {
    messages: [
      { role: "system", content: "这是连接测试。不要解释，只回复 OK。" },
      { role: "user", content: "请回复 OK" },
    ],
    maxTokens: 24,
    temperature: 0,
    timeoutMs: 15000,
  };
  const resolved = applyReasoningPolicy(provider, baseRequest, {
    task: "group_chat",
    mode: "economy",
  });
  const result = await callApiProvider(providerId, resolved.request, {
    ...options,
    provider,
  });
  if (!result.ok) {
    return {
      ok: false,
      providerId,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
    };
  }
  const packet = buildOutputPacket(result.raw, { provider: result.provider });
  return {
    ok: packet.ok,
    providerId: result.provider,
    status: result.status,
    durationMs: result.durationMs,
    output: packet.ok ? packet.text.slice(0, 120) : null,
    error: packet.ok ? null : "接口有响应，但没有得到可发送的正文",
  };
}
