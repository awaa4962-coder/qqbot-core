import { normalizedRaw, normalizeUsage, openAiToolCalls, splitSystemMessages } from "../message-convert.mjs";
import { postProviderJson } from "../transport.mjs";

export async function callOpenAiResponses(provider, key, request) {
  const { system, conversation } = splitSystemMessages(request.messages);
  const body = {
    model: provider.model,
    input: conversation.flatMap(convertInputMessage),
    max_output_tokens: request.maxTokens || 1024,
  };
  if (system) body.instructions = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools?.length && provider.capabilities.includes("tools")) {
    body.tools = request.tools.map(convertTool);
    body.tool_choice = request.toolChoice || "auto";
  }
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  const result = await postProviderJson(provider, key, body, request);
  if (!result.ok) return result;
  return { ...result, raw: normalizeResponse(provider.id, result.data) };
}

function convertInputMessage(message) {
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

function normalizeResponse(providerId, data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const textParts = [];
  const toolCalls = [];
  for (const item of output) {
    collectResponseText(item, textParts);
    collectResponseTool(item, toolCalls);
  }
  const content = data?.output_text || textParts.join("\n");
  return normalizedRaw(providerId, content, {
    id: data?.id,
    finishReason: data?.status === "incomplete" ? "length" : undefined,
    toolCalls: openAiToolCalls(toolCalls),
    usage: normalizeUsage(data?.usage),
  });
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
