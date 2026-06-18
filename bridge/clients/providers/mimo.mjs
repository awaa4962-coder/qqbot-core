// bridge/clients/providers/mimo.mjs — MiMo 提供者封装
import { llmCall } from "../llm-client.mjs";
import { CFG } from "../../config.mjs";

const ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";
const MODEL = "mimo-v2.5";

export async function mimoChat(messages, { maxTokens = 1024, temperature = 0.7, timeoutMs = 30000, tools } = {}) {
  const extra = {};
  if (tools) {
    extra.tools = tools;
    extra.tool_choice = "auto";
  }
  return llmCall({
    provider: "mimo",
    apiKey: CFG.mimoKey,
    endpoint: ENDPOINT,
    model: MODEL,
    messages,
    maxTokens,
    temperature,
    timeoutMs,
    extra,
  });
}

export async function mimoVision(imageContents, { maxTokens = 300, timeoutMs = 30000 } = {}) {
  return llmCall({
    provider: "mimo",
    apiKey: CFG.mimoKey,
    endpoint: ENDPOINT,
    model: MODEL,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "请描述这些图片的内容，用中文回答，简洁一点。" }, ...imageContents],
    }],
    maxTokens,
    temperature: 0.7,
    timeoutMs,
  });
}
