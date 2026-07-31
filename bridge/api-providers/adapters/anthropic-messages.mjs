import { contentAsText, normalizedRaw, normalizeUsage, parseDataImage, splitSystemMessages } from "../message-convert.mjs";
import { postProviderJson } from "../transport.mjs";

export async function callAnthropicMessages(provider, key, request) {
  const { system, conversation } = splitSystemMessages(request.messages);
  const body = {
    model: provider.model,
    max_tokens: request.maxTokens || 1024,
    messages: conversation.map(convertMessage),
  };
  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length && provider.capabilities.includes("tools")) {
    body.tools = request.tools.map(tool => ({
      name: tool.function?.name || "",
      description: tool.function?.description || "",
      input_schema: tool.function?.parameters || { type: "object", properties: {} },
    }));
  }
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  const result = await postProviderJson(provider, key, body, request);
  if (!result.ok) return result;
  return { ...result, raw: normalizeResponse(provider.id, result.data) };
}

function convertMessage(message) {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: contentAsText(message.content),
      }],
    };
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = convertContent(message.content);
  if (role === "assistant" && message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function?.name || "",
        input: parseJsonArguments(call.function?.arguments),
      });
    }
  }
  return { role, content };
}

function convertContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks = [];
  for (const part of content || []) {
    if (part?.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
    const image = parseDataImage(part?.image_url?.url);
    if (image) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function normalizeResponse(providerId, data) {
  const collected = { text: [], tools: [], reasoning: [] };
  for (const block of data?.content || []) {
    collectAnthropicBlock(block, collected);
  }
  return normalizedRaw(providerId, collected.text.join("\n"), {
    id: data?.id,
    reasoning: collected.reasoning.join(""),
    toolCalls: collected.tools,
    finishReason: data?.stop_reason === "max_tokens" ? "length" : data?.stop_reason,
    usage: normalizeUsage(data?.usage),
  });
}

function collectAnthropicBlock(block, collected) {
  if (block?.type === "text" && block.text) collected.text.push(block.text);
  if (isReasoningBlock(block) && block.thinking) collected.reasoning.push(block.thinking);
  if (block?.type === "tool_use") collected.tools.push(toOpenAiToolCall(block));
}

function isReasoningBlock(block) {
  return block?.type === "thinking" || block?.type === "reasoning";
}

function toOpenAiToolCall(block) {
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
  };
}

function parseJsonArguments(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}
