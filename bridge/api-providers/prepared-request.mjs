import { redactProviderPayload } from "./request-privacy.mjs";
import { measureVisionRequest } from "../vision/request-budget.mjs";

// Fit after protocol conversion too: native wrappers and redaction may increase wire size.
export function prepareProviderRequest(provider, request, buildBody) {
  if (!request.fitPreparedContext) return { request, body: buildBody(provider, request) };
  const measure = candidate => {
    const images = measureVisionRequest(candidate);
    const body = redactProviderPayload(buildBody(provider, candidate));
    return { ...images, chars: measureProviderPayload(body, candidate, provider.protocol) };
  };
  const prepared = { ...request, messages: request.fitPreparedContext(request, measure) };
  request.validatePrepared?.(prepared, measure);
  return { request: prepared, body: buildBody(provider, prepared) };
}

export function measureProviderPayload(body, request, protocol) {
  const trusted = new Set(request.trustedImageUrls || []);
  const trustedBytes = new Set([...trusted].map(url => typeof url === "string" ? url.split(",")[1] : ""));
  const copy = JSON.parse(JSON.stringify(body));
  if (protocol === "gemini-native") {
    for (const row of copy.contents || []) if (row.role === "user") {
      for (const part of row.parts || []) replaceInlineImage(part.inlineData, trustedBytes);
    }
  } else {
    for (const row of (protocol === "openai-responses" ? copy.input : copy.messages) || []) {
      if (row.role !== "user" || !Array.isArray(row.content)) continue;
      for (const part of row.content) replacePreparedImage(part, trusted, trustedBytes, protocol);
    }
  }
  return JSON.stringify(copy).length;
}

function replacePreparedImage(part, trusted, bytes, protocol) {
  if (protocol === "openai-chat" && part.type === "image_url" && trusted.has(part.image_url?.url)) part.image_url.url = "[prepared-image]";
  if (protocol === "openai-responses" && part.type === "input_image" && trusted.has(part.image_url)) part.image_url = "[prepared-image]";
  if (protocol === "anthropic-messages" && part.type === "image" && part.source?.type === "base64" &&
      part.source.media_type === "image/jpeg" && bytes.has(part.source.data)) part.source.data = "[prepared-image]";
}

function replaceInlineImage(data, trusted) {
  if (data?.mimeType === "image/jpeg" && trusted.has(data.data)) data.data = "[prepared-image]";
}
