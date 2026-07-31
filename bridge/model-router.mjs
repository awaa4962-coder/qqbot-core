// bridge/model-router.mjs - stable task-level model dispatch facade.
import { parseMiMoResponse, resolveVisionContext, tryMiMo } from "./model-mimo.mjs";
import { tryDeepSeek } from "./model-ds.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";

export const MODEL_PROVIDERS = Object.freeze({
  PRIMARY: "mimo",
  FALLBACK: "deepseek",
});

export const MODEL_TASKS = Object.freeze({
  GROUP_CHAT: "group_chat",
  INTERJECTION: "interjection",
  PRIVATE_CHAT: "private_chat",
  FILE_CHAT: "file_chat",
  GROUP_SUMMARY: "group_summary",
  RELATIONSHIP_COMMENT: "relationship_comment",
  STICKER_SELECT: "sticker_select",
});

export const MODEL_COST_TIERS = Object.freeze({
  LOCAL: "local",
  SMALL: "small",
  STANDARD: "standard",
  FALLBACK: "fallback",
});

export const TASK_MODEL_POLICY = Object.freeze({
  [MODEL_TASKS.GROUP_CHAT]: {
    primary: MODEL_PROVIDERS.PRIMARY,
    fallback: MODEL_PROVIDERS.FALLBACK,
    tier: MODEL_COST_TIERS.STANDARD,
  },
  [MODEL_TASKS.INTERJECTION]: {
    primary: MODEL_PROVIDERS.PRIMARY,
    fallback: "local",
    tier: MODEL_COST_TIERS.SMALL,
  },
  [MODEL_TASKS.PRIVATE_CHAT]: {
    primary: MODEL_PROVIDERS.FALLBACK,
    fallback: null,
    tier: MODEL_COST_TIERS.STANDARD,
  },
  [MODEL_TASKS.FILE_CHAT]: {
    primary: MODEL_PROVIDERS.FALLBACK,
    fallback: null,
    tier: MODEL_COST_TIERS.STANDARD,
  },
  [MODEL_TASKS.GROUP_SUMMARY]: {
    primary: MODEL_PROVIDERS.PRIMARY,
    fallback: MODEL_PROVIDERS.FALLBACK,
    tier: MODEL_COST_TIERS.STANDARD,
    localFirst: true,
  },
  [MODEL_TASKS.RELATIONSHIP_COMMENT]: {
    primary: MODEL_PROVIDERS.PRIMARY,
    fallback: MODEL_PROVIDERS.FALLBACK,
    tier: MODEL_COST_TIERS.SMALL,
    cachePreferred: true,
  },
  [MODEL_TASKS.STICKER_SELECT]: {
    primary: MODEL_PROVIDERS.PRIMARY,
    fallback: MODEL_PROVIDERS.FALLBACK,
    tier: MODEL_COST_TIERS.SMALL,
  },
});

export async function callPrimaryChat(request = {}) {
  const task = request.options?.replyMode === "interjection"
    ? MODEL_TASKS.INTERJECTION
    : MODEL_TASKS.GROUP_CHAT;
  return await tryMiMo(
    request.userMsg || "",
    request.userName || "",
    request.history || [],
    request.imageUrls || [],
    request.groupId,
    request.isAtMe,
    request.mood || "",
    { ...(request.options || {}), task, position: "primary" }
  );
}

export async function callFallbackChat(request = {}) {
  const privateRequest = request.groupId === null || request.groupId === undefined;
  const task = request.task ||
    (privateRequest ? MODEL_TASKS.PRIVATE_CHAT : MODEL_TASKS.GROUP_CHAT);
  return await tryDeepSeek(
    request.userMsg || "",
    request.userName || "",
    request.history || [],
    request.groupId,
    request.isAtMe,
    request.mood || "",
    {
      ...(request.options || {}),
      task,
      position: task === MODEL_TASKS.GROUP_CHAT ? "fallback" : "primary",
    }
  );
}

export async function resolveChatVisionContext(imageUrls) {
  return await resolveVisionContext(imageUrls || []);
}

export async function callChatProvider(provider, request = {}) {
  if (provider === MODEL_PROVIDERS.PRIMARY) {
    return await callPrimaryChat({
      ...request,
      options: { ...(request.options || {}), providerId: provider },
    });
  }
  if (provider === MODEL_PROVIDERS.FALLBACK) {
    return await tryDeepSeek(
      request.userMsg || "",
      request.userName || "",
      request.history || [],
      request.groupId,
      request.isAtMe,
      request.mood || "",
      { ...(request.options || {}), providerId: provider }
    );
  }
  throw new Error("unknown model provider: " + provider);
}

export function getModelTaskPolicy(task) {
  return TASK_MODEL_POLICY[task] || TASK_MODEL_POLICY[MODEL_TASKS.GROUP_CHAT];
}

export async function callRawModelProvider(provider, request = {}) {
  if (provider === MODEL_PROVIDERS.PRIMARY || provider === MODEL_PROVIDERS.FALLBACK) {
    const result = await callApiProvider(provider, buildRawRequest(request));
    return result.ok ? result.raw : null;
  }
  throw new Error("unknown model provider: " + provider);
}

export async function callTaskRawProvider(task, position, request = {}) {
  const result = await callTaskApi(task, position, buildRawRequest(request));
  return result.ok ? result.raw : null;
}

export async function callRelationshipCommentPrimary(prompt) {
  const raw = await callTaskRawProvider(MODEL_TASKS.RELATIONSHIP_COMMENT, "primary", {
    task: MODEL_TASKS.RELATIONSHIP_COMMENT,
    systemPrompt: "你是夜星的关系短评生成器。只输出一段中文短评，不要解释。",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 160,
    options: { allowTools: false, thinking: { type: "disabled" } },
  });
  return parseMiMoResponse(raw) || "";
}

export async function callRelationshipCommentFallback(prompt) {
  const raw = await callTaskRawProvider(MODEL_TASKS.RELATIONSHIP_COMMENT, "fallback", {
    task: MODEL_TASKS.RELATIONSHIP_COMMENT,
    systemPrompt: "你是夜星的关系短评生成器。只输出一段中文短评，不要解释。",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 160,
    temperature: 0.5,
    timeoutMs: 15000,
  });
  return parseRawText(raw, MODEL_PROVIDERS.FALLBACK);
}

export async function callStickerSelection(prompt, position = "primary") {
  const result = await callTaskApi(MODEL_TASKS.STICKER_SELECT, position, buildRawRequest({
    systemPrompt: [
      "你是聊天表情选择器，只能从候选中选择一张真正符合当前语境的图片。",
      "没有可靠匹配时必须选择 null。只输出严格 JSON，不要解释。",
    ].join("\n"),
    messages: [{ role: "user", content: prompt }],
    maxTokens: 100,
    temperature: 0.2,
    timeoutMs: 15000,
    options: { allowTools: false, thinking: { type: "disabled" } },
  }));
  if (!result.ok) return "";
  return parseRawText(result.raw, result.provider);
}

function buildRawRequest(request) {
  return {
    messages: [
      { role: "system", content: request.systemPrompt || "" },
      ...(request.messages || []),
    ],
    maxTokens: request.maxTokens || 1024,
    temperature: request.temperature ?? 0.7,
    timeoutMs: request.timeoutMs || 30000,
    thinking: request.options?.thinking,
    tools: request.options?.allowTools === false ? [] : request.tools,
  };
}

function parseRawText(raw, provider) {
  if (!raw) return "";
  const packet = buildOutputPacket(raw, { provider });
  return packet.ok ? packet.text : "";
}
