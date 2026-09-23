import { normalizedRaw, normalizeUsage, splitSystemMessages } from "../message-convert.mjs";
import { postProviderJson } from "../transport.mjs";
import { redactProviderPayload } from "../request-privacy.mjs";
import { redactSensitiveText } from "../../privacy.mjs";

const PROTOCOL = "openai-responses";
const MAX_CONTINUATION_BYTES = 1024 * 1024;

export async function callOpenAiResponses(provider, key, request) {
  const { system, conversation } = splitSystemMessages(request.messages);
  const body = {
    model: provider.model,
    input: conversation.flatMap(convertInputMessage),
    max_output_tokens: request.maxTokens || 1024,
  };
  validateToolSequence(body.input);
  if (system) body.instructions = system;
  const reasoningEnabled = request.reasoning && request.reasoning.effort !== "none";
  if (request.temperature !== undefined && !reasoningEnabled) {
    body.temperature = request.temperature;
  }
  if (request.reasoning && provider.capabilities.includes("reasoning")) {
    body.reasoning = request.reasoning;
  }
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  const toolsEnabled = configureTools(body, provider, request);
  if (toolsEnabled || conversation.some(message => message.providerContinuation?.protocol === PROTOCOL)) {
    configureStatelessReplay(body);
  }
  const result = await postProviderJson(provider, key, body, request);
  if (!result.ok) return result;
  return { ...result, raw: normalizeResponse(provider.id, result.data, toolsEnabled && body.tool_choice !== "none") };
}

function configureStatelessReplay(body) {
  // Manual replay must work without server-side response storage, including on older endpoints.
  body.store = false;
  body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
}

function configureTools(body, provider, request) {
  const toolsEnabled = request.tools?.length && provider.capabilities.includes("tools");
  if (toolsEnabled) {
    body.tools = request.tools.map(convertTool);
    body.tool_choice = request.toolChoice ?? body.tool_choice ?? "auto";
  } else {
    delete body.tools;
    body.tool_choice = "none";
  }
  return toolsEnabled;
}

function convertInputMessage(message) {
  if (message.role === "assistant" && message.providerContinuation?.protocol === PROTOCOL) {
    return continuationItems(message.providerContinuation.items);
  }
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    }];
  }
  const items = [];
  if (message.content) {
    items.push({ role: message.role, content: convertInputContent(message.content) });
  }
  for (const call of message.tool_calls || []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function?.name || "",
      arguments: call.function?.arguments || "{}",
    });
  }
  return items;
}

function validateToolSequence(input) {
  const pending = new Set();
  const seen = new Set();
  for (const item of input) {
    if (item.type === "function_call") {
      if (!item.call_id || seen.has(item.call_id)) throw new Error("Invalid Responses tool call IDs");
      seen.add(item.call_id);
      pending.add(item.call_id);
    }
    if (item.type === "function_call_output" && !pending.delete(item.call_id)) {
      throw new Error("Invalid Responses tool result sequence");
    }
  }
  if (pending.size) throw new Error("Incomplete Responses tool results");
}

function convertInputContent(content) {
  if (typeof content === "string") return content;
  return (content || []).flatMap(part => {
    if (part?.type === "text" && part.text) return [{ type: "input_text", text: part.text }];
    if (part?.type === "image_url" && part.image_url?.url) {
      return [{ type: "input_image", image_url: part.image_url.url }];
    }
    return [];
  });
}

function convertTool(tool) {
  return {
    type: "function",
    name: tool.function?.name || "",
    description: tool.function?.description || "",
    parameters: tool.function?.parameters || { type: "object", properties: {} },
  };
}

function normalizeResponse(providerId, data, toolsEnabled) {
  const output = Array.isArray(data?.output) ? data.output : [];
  if (!toolsEnabled && hasFunctionCalls(output)) throw new Error("Responses returned tool calls while tools are disabled");
  const items = hasFunctionCalls(output) ? continuationItems(output) : output;
  const textParts = [];
  const toolCalls = [];
  for (const item of items) {
    collectResponseText(item, textParts);
    collectResponseTool(item, toolCalls);
  }
  const content = data?.output_text || textParts.join("\n");
  const raw = normalizedRaw(providerId, toolCalls.length ? redactSensitiveText(content) : content, {
    id: data?.id,
    finishReason: data?.status === "incomplete" ? "length" : undefined,
    toolCalls: toolCalls.map(item => ({
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: item.arguments },
    })),
    usage: normalizeUsage(data?.usage),
  });
  if (toolCalls.length) {
    raw.choices[0].message.providerContinuation = { protocol: PROTOCOL, items };
  }
  return raw;
}

function continuationItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 256 || !items.every(validContinuationItem)) {
    throw new Error("Invalid Responses provider continuation");
  }
  let json;
  try { json = JSON.stringify(items); } catch { throw new Error("Invalid Responses provider continuation"); }
  if (Buffer.byteLength(json) > MAX_CONTINUATION_BYTES) throw new Error("Responses provider continuation exceeds limit");
  const nativeItems = JSON.parse(json);
  const ids = nativeItems.filter(item => item.type === "function_call").map(item => item.call_id);
  if (new Set(ids).size !== ids.length) throw new Error("Invalid Responses tool call IDs");
  return redactProviderPayload({ input: nativeItems }).input;
}

function validContinuationItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  switch (item.type) {
    case "reasoning": return validReasoningItem(item);
    case "function_call": return nonEmptyString(item.call_id) && nonEmptyString(item.name) && typeof item.arguments === "string";
    case "message": return item.role === "assistant" && Array.isArray(item.content) && item.content.every(part =>
      (part?.type === "output_text" && typeof part.text === "string") ||
      (part?.type === "refusal" && typeof part.refusal === "string"));
    default: return false;
  }
}

function validReasoningItem(item) {
  return nonEmptyString(item.id) && Array.isArray(item.summary) &&
    item.summary.every(part => part?.type === "summary_text" && typeof part.text === "string") &&
    (item.encrypted_content === undefined || item.encrypted_content === null || typeof item.encrypted_content === "string");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function collectResponseText(item, target) {
  if (item?.type !== "message") return;
  for (const part of item.content || []) {
    if (part?.type === "output_text" && part.text) target.push(part.text);
  }
}

function collectResponseTool(item, target) {
  if (item?.type === "function_call") target.push(item);
}

function hasFunctionCalls(items) {
  return Array.isArray(items) && items.some(item => item?.type === "function_call");
}
