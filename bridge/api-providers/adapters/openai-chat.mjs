import { postProviderJson } from "../transport.mjs";
import { prepareProviderRequest } from "../prepared-request.mjs";

export async function callOpenAiChat(provider, key, request) {
  const prepared = prepareProviderRequest(provider, request, buildBody);
  const result = await postProviderJson(provider, key, prepared.body, prepared.request);
  if (!result.ok) return result;
  return { ...result, raw: { ...result.data, provider: provider.id } };
}

function buildBody(provider, request) {
  const tokenField = provider.tokenField || "max_tokens";
  const body = {
    model: provider.model,
    messages: request.messages || [],
    [tokenField]: request.maxTokens || 1024,
    temperature: request.temperature ?? 0.7,
  };
  if (request.tools?.length && provider.capabilities.includes("tools")) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice || "auto";
  }
  if (request.thinking && provider.capabilities.includes("reasoning")) {
    body.thinking = request.thinking;
  }
  if (request.extra && typeof request.extra === "object") Object.assign(body, request.extra);
  return body;
}
