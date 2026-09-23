import { contentAsText, normalizedRaw, normalizeUsage, parseDataImage, splitSystemMessages } from "../message-convert.mjs";
import { postProviderJson } from "../transport.mjs";
import { redactProviderPayload } from "../request-privacy.mjs";
import { containsSensitiveText } from "../../privacy.mjs";

const PROTOCOL = "anthropic-messages";
const MAX_CONTINUATION_BYTES = 1024 * 1024;

export async function callAnthropicMessages(provider, key, request) {
  const { system, conversation } = splitSystemMessages(request.messages);
  const body = {
    model: provider.model,
    max_tokens: request.maxTokens || 1024,
    messages: convertMessages(conversation),
  };
  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  const toolsEnabled = configureTools(body, provider, request);
  const result = await postProviderJson(provider, key, body, request);
  if (!result.ok) return result;
  if ((!toolsEnabled || body.tool_choice?.type === "none") && Array.isArray(result.data?.content) &&
      result.data.content.some(block => block?.type === "tool_use")) {
    throw new Error("Anthropic returned tool calls while tools are disabled");
  }
  return { ...result, raw: normalizeResponse(provider.id, result.data) };
}

function configureTools(body, provider, request) {
  const toolsEnabled = request.tools?.length && provider.capabilities.includes("tools");
  if (toolsEnabled) {
    body.tools = request.tools.map(tool => ({
      name: tool.function?.name || "",
      description: tool.function?.description || "",
      input_schema: tool.function?.parameters || { type: "object", properties: {} },
    }));
    body.tool_choice = convertToolChoice(request.toolChoice ?? body.tool_choice ?? "auto");
  } else {
    delete body.tools;
    delete body.tool_choice;
  }
  return toolsEnabled;
}

function convertToolChoice(choice) {
  if (["auto", "none", "any", "required"].includes(choice)) {
    return { type: choice === "required" ? "any" : choice };
  }
  if (choice?.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  if (["auto", "none", "any", "tool"].includes(choice?.type)) return choice;
  throw new Error("Invalid Anthropic tool choice");
}

function convertMessages(conversation) {
  const messages = [];
  const pending = new Set();
  const seen = new Set();
  let previousWasTool = false;
  for (const message of conversation) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw new Error("Invalid Anthropic tool result sequence");
      const converted = convertMessage(message);
      // Parallel results belong in one user message immediately after tool_use.
      if (previousWasTool) messages.at(-1).content.push(...converted.content);
      else messages.push(converted);
    } else {
      if (pending.size) throw new Error("Incomplete Anthropic tool results");
      const converted = convertMessage(message);
      for (const block of converted.content) {
        if (block.type !== "tool_use") continue;
        if (!block.id || seen.has(block.id)) throw new Error("Invalid Anthropic tool call IDs");
        seen.add(block.id);
        pending.add(block.id);
      }
      messages.push(converted);
    }
    previousWasTool = message.role === "tool";
  }
  if (pending.size) throw new Error("Incomplete Anthropic tool results");
  return messages;
}

function convertMessage(message) {
  if (message.role === "tool") return convertToolResult(message);
  const role = message.role === "assistant" ? "assistant" : "user";
  if (role === "assistant" && message.providerContinuation?.protocol === PROTOCOL) {
    return { role, content: continuationItems(message.providerContinuation.items) };
  }
  const content = convertContent(message.content);
  if (role === "assistant" && message.tool_calls?.length) {
    if (!message.content) content.length = 0;
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

function convertToolResult(message) {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: message.tool_call_id,
      content: contentAsText(message.content),
      ...(message.is_error === true ? { is_error: true } : {}),
    }],
  };
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
  const content = Array.isArray(data?.content) ? data.content : [];
  const items = content.some(block => block?.type === "tool_use") ? continuationItems(content) : content;
  const collected = { text: [], tools: [], reasoning: [] };
  for (const block of items) {
    collectAnthropicBlock(block, collected);
  }
  const raw = normalizedRaw(providerId, collected.text.join("\n"), {
    id: data?.id,
    reasoning: collected.reasoning.join(""),
    toolCalls: collected.tools,
    finishReason: data?.stop_reason === "max_tokens" ? "length" : data?.stop_reason,
    usage: normalizeUsage(data?.usage),
  });
  if (collected.tools.length) {
    // Internal same-provider history, never user-visible content or log data.
    raw.choices[0].message.providerContinuation = { protocol: PROTOCOL, items };
  }
  return raw;
}

function continuationItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 256 || !items.every(validContinuationBlock)) {
    throw new Error("Invalid Anthropic provider continuation");
  }
  let json;
  try { json = JSON.stringify(items); } catch { throw new Error("Invalid Anthropic provider continuation"); }
  if (Buffer.byteLength(json) > MAX_CONTINUATION_BYTES) throw new Error("Anthropic provider continuation exceeds limit");
  const blocks = JSON.parse(json);
  const ids = blocks.filter(block => block.type === "tool_use").map(block => block.id);
  if (new Set(ids).size !== ids.length) throw new Error("Invalid Anthropic tool call IDs");
  // Signed thinking cannot be redacted without invalidating the whole block.
  if (blocks.some(block => block.type === "thinking" && containsSensitiveText(block.thinking))) {
    throw new Error("Sensitive text in signed Anthropic thinking");
  }
  return redactProviderPayload({ messages: [{ role: "assistant", content: blocks }] }).messages[0].content;
}

function validContinuationBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  switch (block.type) {
    case "text": return typeof block.text === "string";
    case "thinking": return typeof block.thinking === "string" && nonEmptyString(block.signature) &&
      Object.keys(block).every(key => ["type", "thinking", "signature"].includes(key));
    case "redacted_thinking": return nonEmptyString(block.data) &&
      Object.keys(block).every(key => ["type", "data", "signature"].includes(key));
    case "tool_use": return nonEmptyString(block.id) && nonEmptyString(block.name) &&
      block.input !== null && typeof block.input === "object" && !Array.isArray(block.input);
    default: return false;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
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
    const input = JSON.parse(value || "{}");
    if (input && typeof input === "object" && !Array.isArray(input)) return input;
  } catch { /* Report no source arguments in the error. */ }
  throw new Error("Invalid Anthropic tool arguments");
}
