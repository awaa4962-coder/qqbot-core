// bridge/clients/providers/deepseek.mjs — DeepSeek 提供者封装
import { llmCall } from "../llm-client.mjs";
import { CFG } from "../../config.mjs";

const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-v4-flash";

export async function deepseekChat(messages, { maxTokens = 1024, temperature = 0.7, timeoutMs = 30000 } = {}) {
  return llmCall({
    provider: "deepseek",
    apiKey: CFG.dsKey,
    endpoint: ENDPOINT,
    model: MODEL,
    messages,
    maxTokens,
    temperature,
    timeoutMs,
  });
}
