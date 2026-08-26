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
  const promptTokens = promptTokenCount(input);
  const completionTokens = completionTokenCount(input);
  const cachedTokens = cachedTokenCount(input);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(input.total_tokens ?? input.totalTokenCount ?? promptTokens + completionTokens),
    cache_reported: hasCacheDetails(input),
    prompt_cache_hit_tokens: cachedTokens,
    prompt_cache_miss_tokens: Number(input.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cachedTokens)),
    completion_tokens_details: { reasoning_tokens: reasoningTokenCount(input) },
  };
}

function hasCacheDetails(input) {
  return input.prompt_cache_hit_tokens !== undefined ||
    input.prompt_cache_miss_tokens !== undefined ||
    input.prompt_tokens_details?.cached_tokens !== undefined ||
    input.input_tokens_details?.cached_tokens !== undefined ||
    input.cache_read_input_tokens !== undefined;
}

function promptTokenCount(input) {
  return Number(input.prompt_tokens ?? input.input_tokens ?? input.promptTokenCount ?? 0);
}

function completionTokenCount(input) {
  return Number(input.completion_tokens ?? input.output_tokens ?? input.candidatesTokenCount ?? 0);
}

function cachedTokenCount(input) {
  return Number(
    input.prompt_cache_hit_tokens ??
    input.prompt_tokens_details?.cached_tokens ??
    input.input_tokens_details?.cached_tokens ??
    input.cache_read_input_tokens ??
    0
  );
}

function reasoningTokenCount(input) {
  return Number(
    input.completion_tokens_details?.reasoning_tokens ??
    input.output_tokens_details?.reasoning_tokens ??
    input.reasoning_tokens ??
    0
  );
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
