import { normalizedRaw, normalizeUsage, parseDataImage, splitSystemMessages } from "../message-convert.mjs";
import { postProviderJson } from "../transport.mjs";

export async function callGeminiNative(provider, key, request) {
  const { system, conversation } = splitSystemMessages(request.messages);
  const body = {
    contents: conversation.map(convertMessage),
    generationConfig: {
      maxOutputTokens: request.maxTokens || 1024,
      temperature: request.temperature ?? 0.7,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  const result = await postProviderJson(provider, key, body, request);
  if (!result.ok) return result;
  return { ...result, raw: normalizeResponse(provider.id, result.data) };
}

function convertMessage(message) {
  const role = message.role === "assistant" ? "model" : "user";
  const parts = [];
  if (typeof message.content === "string") {
    parts.push({ text: message.content });
  } else {
    for (const item of message.content || []) {
      if (item?.type === "text" && item.text) parts.push({ text: item.text });
      const image = parseDataImage(item?.image_url?.url);
      if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
  }
  return { role, parts: parts.length ? parts : [{ text: "" }] };
}

function normalizeResponse(providerId, data) {
  const candidate = data?.candidates?.[0] || {};
  const text = [];
  let reasoning = "";
  for (const part of candidate?.content?.parts || []) {
    if (part?.thought === true && part.text) reasoning += part.text;
    else if (part?.text) text.push(part.text);
  }
  return normalizedRaw(providerId, text.join("\n"), {
    reasoning,
    finishReason: normalizeFinishReason(candidate.finishReason),
    usage: normalizeUsage(data?.usageMetadata),
  });
}

function normalizeFinishReason(reason) {
  const value = String(reason || "").toLowerCase();
  if (value.includes("max_token")) return "length";
  if (value === "stop") return "stop";
  return value || null;
}
