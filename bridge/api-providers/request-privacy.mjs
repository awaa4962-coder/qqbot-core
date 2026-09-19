import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";

// Redact payload text, not routing, authentication, image URLs or signed opaque fields.
export function redactProviderPayload(body) {
  const result = { ...body };
  for (const field of ["messages", "input", "contents"]) {
    if (Array.isArray(body[field])) result[field] = body[field].map(redactMessage);
    else if (typeof body[field] === "string") result[field] = redactSensitiveText(body[field]);
  }
  for (const field of ["system", "instructions"]) {
    if (body[field] !== undefined) result[field] = redactContent(body[field]);
  }
  if (body.systemInstruction) result.systemInstruction = redactMessage(body.systemInstruction);
  return result;
}

function redactMessage(message) {
  if (typeof message === "string") return redactSensitiveText(message);
  if (!message || typeof message !== "object") return message;
  const result = { ...message };
  for (const field of ["content", "parts", "reasoning_content"]) {
    if (message[field] !== undefined) result[field] = redactContent(message[field]);
  }
  if (message.type === "function_call") result.arguments = redactArguments(message.arguments);
  if (message.type === "function_call_output") result.output = redactToolData(message.output);
  if (Array.isArray(message.tool_calls)) {
    result.tool_calls = message.tool_calls.map(call => call.function ? {
      ...call,
      function: { ...call.function, arguments: redactArguments(call.function.arguments) },
    } : call);
  }
  return result;
}

function redactContent(content) {
  if (typeof content === "string") return redactSensitiveText(content);
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (typeof part === "string") return redactSensitiveText(part);
    if (!part || typeof part !== "object") return part;
    const result = { ...part };
    if (typeof part.text === "string") result.text = redactSensitiveText(part.text);
    if (part.type === "tool_result") result.content = redactContent(part.content);
    if (part.type === "tool_use") result.input = redactToolData(part.input);
    if (part.functionCall) {
      result.functionCall = { ...part.functionCall, args: redactToolData(part.functionCall.args) };
    }
    if (part.functionResponse) {
      result.functionResponse = { ...part.functionResponse, response: redactToolData(part.functionResponse.response) };
    }
    return result;
  });
}

function redactArguments(value) {
  if (typeof value !== "string") return redactToolData(value);
  try {
    return JSON.stringify(redactToolData(JSON.parse(value)));
  } catch {
    // Malformed arguments must not turn into a different, executable tool request.
    return redactSensitiveText(value);
  }
}

function redactToolData(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactToolData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    containsSensitiveText(key + '="redaction-probe"') ? "[REDACTED]" : redactToolData(item),
  ]));
}
