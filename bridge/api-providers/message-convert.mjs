export function splitSystemMessages(messages) {
  const system = [];
  const conversation = [];
  for (const message of messages || []) {
    if (message?.role === "system") system.push(contentAsText(message.content));
    else if (message?.role) conversation.push(message);
  }
  return { system: system.filter(Boolean).join("\n\n"), conversation };
}

export function contentAsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => typeof part === "string" ? part : part?.text || "")
    .filter(Boolean)
    .join("\n");
}

export function parseDataImage(url) {
  const match = String(url || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2].replace(/\s+/g, ""),
  };
}

export function normalizeUsage(input = {}) {
  return {
    prompt_tokens: Number(input.prompt_tokens ?? input.input_tokens ?? input.promptTokenCount ?? 0),
    completion_tokens: Number(input.completion_tokens ?? input.output_tokens ?? input.candidatesTokenCount ?? 0),
    total_tokens: Number(input.total_tokens ?? input.totalTokenCount ?? 0),
  };
}

export function normalizedRaw(providerId, content, options = {}) {
  const message = {
    role: "assistant",
    content: typeof content === "string" && content.trim() ? content : null,
  };
  if (options.reasoning) message.reasoning_content = options.reasoning;
  if (options.toolCalls?.length) message.tool_calls = options.toolCalls;
  return {
    provider: providerId,
    choices: [{
      index: 0,
      message,
      finish_reason: options.finishReason || (options.toolCalls?.length ? "tool_calls" : "stop"),
    }],
    usage: options.usage || null,
    id: options.id || null,
  };
}

export function openAiToolCalls(toolCalls) {
  return (toolCalls || []).map((item, index) => ({
    id: item.id || item.call_id || "tool-" + index,
    type: "function",
    function: {
      name: item.function?.name || item.name || "",
      arguments: item.function?.arguments || item.arguments || "{}",
    },
  }));
}
