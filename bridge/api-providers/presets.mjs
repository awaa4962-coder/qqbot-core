// Built-in API protocol and provider presets. Presets never contain secrets.

export const API_PROTOCOLS = Object.freeze([
  {
    id: "openai-chat",
    name: "OpenAI Chat Completions",
    summary: "兼容 /chat/completions 的文本、图片和工具调用接口。",
    capabilities: ["text", "vision", "tools", "reasoning"],
  },
  {
    id: "openai-responses",
    name: "OpenAI Responses",
    summary: "兼容 /responses 的新式统一生成接口。",
    capabilities: ["text", "vision", "tools", "reasoning"],
  },
  {
    id: "anthropic-messages",
    name: "Anthropic Messages",
    summary: "兼容 /v1/messages、content blocks 和 tool_use 的接口。",
    capabilities: ["text", "vision", "tools", "reasoning"],
  },
  {
    id: "gemini-native",
    name: "Gemini GenerateContent",
    summary: "兼容 contents / parts 和 x-goog-api-key 的 Gemini 原生接口。",
    capabilities: ["text", "vision", "reasoning"],
  },
]);

const PRESETS = [
  preset("mimo-official", "MiMo 官方", "openai-chat", {
    endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.5",
    tokenField: "max_completion_tokens",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("deepseek-official", "DeepSeek 官方", "openai-chat", {
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash",
    capabilities: ["text", "tools", "reasoning"],
  }),
  preset("openai-chat", "OpenAI Chat", "openai-chat", {
    endpoint: "https://api.openai.com/v1/chat/completions",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("openai-responses", "OpenAI Responses", "openai-responses", {
    endpoint: "https://api.openai.com/v1/responses",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("anthropic-official", "Anthropic Claude", "anthropic-messages", {
    endpoint: "https://api.anthropic.com/v1/messages",
    auth: "x-api-key",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("gemini-official", "Google Gemini", "gemini-native", {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    auth: "x-goog-api-key",
    capabilities: ["text", "vision", "reasoning"],
  }),
  preset("doubao-responses", "豆包方舟 Responses", "openai-responses", {
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/responses",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("openrouter", "OpenRouter", "openai-chat", {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("qwen-compatible", "阿里云百炼兼容模式", "openai-chat", {
    endpoint: "",
    endpointHint: "填写控制台给出的 compatible-mode/v1/chat/completions 完整地址",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("moonshot-compatible", "Moonshot / Kimi", "openai-chat", {
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    capabilities: ["text", "vision", "tools"],
  }),
  preset("zhipu-compatible", "智谱 GLM", "openai-chat", {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("siliconflow-compatible", "硅基流动", "openai-chat", {
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("groq-compatible", "Groq", "openai-chat", {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    capabilities: ["text", "tools"],
  }),
  preset("together-compatible", "Together AI", "openai-chat", {
    endpoint: "https://api.together.xyz/v1/chat/completions",
    capabilities: ["text", "vision", "tools"],
  }),
  preset("xai-compatible", "xAI", "openai-chat", {
    endpoint: "https://api.x.ai/v1/chat/completions",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("azure-openai", "Azure / Foundry OpenAI", "openai-chat", {
    endpoint: "",
    endpointHint: "填写包含 deployment 和 api-version 的完整 Chat Completions 地址",
    auth: "api-key",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("ollama-local", "Ollama 本地", "openai-chat", {
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    auth: "none",
    allowLocal: true,
    capabilities: ["text", "vision", "tools"],
  }),
  preset("lmstudio-local", "LM Studio 本地", "openai-chat", {
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    auth: "none",
    allowLocal: true,
    capabilities: ["text", "vision", "tools"],
  }),
  preset("vllm-local", "vLLM 本地", "openai-chat", {
    endpoint: "http://127.0.0.1:8000/v1/chat/completions",
    auth: "none",
    allowLocal: true,
    capabilities: ["text", "vision", "tools"],
  }),
  preset("custom-openai-chat", "其他 OpenAI Chat 兼容接口", "openai-chat", {
    endpoint: "",
    endpointHint: "粘贴完整 /chat/completions 地址",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("custom-openai-responses", "其他 Responses 兼容接口", "openai-responses", {
    endpoint: "",
    endpointHint: "粘贴完整 /responses 地址",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("custom-anthropic", "其他 Anthropic 兼容接口", "anthropic-messages", {
    endpoint: "",
    endpointHint: "粘贴完整 /v1/messages 地址",
    auth: "x-api-key",
    capabilities: ["text", "vision", "tools", "reasoning"],
  }),
  preset("custom-gemini", "其他 Gemini 兼容接口", "gemini-native", {
    endpoint: "",
    endpointHint: "地址可包含 {model} 占位符",
    auth: "x-goog-api-key",
    capabilities: ["text", "vision", "reasoning"],
  }),
];

export const BUILTIN_API_PRESETS = Object.freeze(PRESETS.map(Object.freeze));

export function listApiPresets() {
  return BUILTIN_API_PRESETS.map(item => ({
    ...item,
    capabilities: [...item.capabilities],
  }));
}

export function findApiPreset(id) {
  return BUILTIN_API_PRESETS.find(item => item.id === String(id || "")) || null;
}

function preset(id, name, protocol, options = {}) {
  return {
    id,
    name,
    protocol,
    endpoint: options.endpoint || "",
    endpointHint: options.endpointHint || "",
    model: options.model || "",
    auth: options.auth || "bearer",
    tokenField: options.tokenField || "max_tokens",
    allowLocal: options.allowLocal === true,
    capabilities: options.capabilities || ["text"],
  };
}
