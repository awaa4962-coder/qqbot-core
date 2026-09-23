// bridge/model-router.mjs - stable task-level model dispatch facade.
import { parseMiMoResponse, resolveVisionContext, tryMiMoResult } from "./model-mimo.mjs";
import { tryDeepSeekResult } from "./model-ds.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { appendImageContext } from "./system-prompts/image-context.mjs";
import { callChatSlot, chatError } from "./chat-outcome.mjs";
import { traceStage } from "./diagnostics/message-trace.mjs";
import { assertChatRunCurrent, noteChatOutcome } from "./cognition/chat-run.mjs";
import { createChatToolSession } from "./chat-tools/session.mjs";
import { createVisionSession } from "./vision/session.mjs";

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
  CONVERSATION_SUMMARY: "conversation_summary",
  RELATIONSHIP_COMMENT: "relationship_comment",
  STICKER_SELECT: "sticker_select",
});

export async function callPrimaryChat(request = {}) {
  const task = request.options?.replyMode === "interjection"
    ? MODEL_TASKS.INTERJECTION
    : MODEL_TASKS.GROUP_CHAT;
  return await tryMiMoResult(
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
  return await tryDeepSeekResult(
    request.userMsg || "",
    request.userName || "",
    request.history || [],
    request.groupId,
    request.isAtMe,
    request.mood || "",
    {
      ...(request.options || {}),
      task,
      position: request.position || (task === MODEL_TASKS.GROUP_CHAT ? "fallback" : "primary"),
    }
  );
}

export async function executePrivateChatTask(request = {}, runtime = {}) {
  assertChatRunCurrent();
  const task = request.task === MODEL_TASKS.FILE_CHAT ? MODEL_TASKS.FILE_CHAT : MODEL_TASKS.PRIVATE_CHAT;
  const prepared = await preparePrivateRequest(request, task, runtime);
  prepared.options = withToolSession(prepared, task);
  const callSlot = runtime.callSlot || callFallbackChat;
  for (const position of ["primary", "fallback"]) {
    const result = await callChatSlot(callSlot, { ...prepared, position });
    if (result.kind !== "error") return finishChatResult(result, position);
  }
  return finishChatResult(chatError(), "unavailable");
}

async function preparePrivateRequest(request, task, runtime) {
  const imageUrls = request.imageUrls || [];
  let visionContext = request.options?.visionContext;
  if (imageUrls.length && runtime.resolveVision && !Object.hasOwn(request.options || {}, "visionContext")) {
    visionContext = await runtime.resolveVision(imageUrls, {
      usageContext: { userId: request.options?.currentUserId, task, position: "primary" },
    });
  }
  const prepared = {
    ...request,
    task,
    groupId: null,
    history: request.history,
  };
  if (imageUrls.length && (runtime.resolveVision || Object.hasOwn(request.options || {}, "visionContext"))) {
    prepared.history = buildModelFallbackHistory(request.history, imageUrls, visionContext);
    prepared.options = { ...request.options, visionContext };
  }
  return prepared;
}

export async function callInterjectionFallback(request = {}) {
  return await tryMiMoResult(
    request.userMsg || "",
    request.userName || "",
    request.history || [],
    request.imageUrls || [],
    request.groupId,
    request.isAtMe,
    request.mood || "",
    {
      ...(request.options || {}),
      task: MODEL_TASKS.INTERJECTION,
      position: "fallback",
    }
  );
}

export async function executeChatTask(request = {}, runtime = {}) {
  request = { ...request, options: withToolSession(request, request.options?.replyMode === "interjection" ? "interjection" : "group_chat") };
  const primaryChat = runtime.primaryChat || callPrimaryChat;
  const primary = await callChatSlot(primaryChat, request);
  if (primary.kind !== "error") return finishChatResult(primary, "primary");
  if (request.options?.replyMode === "interjection") {
    const fallbackChat = runtime.interjectionFallback || runtime.fallbackChat || callInterjectionFallback;
    const fallback = await callChatSlot(fallbackChat, request);
    return finishChatResult(fallback, fallback.kind === "error" ? "unavailable" : "fallback");
  }

  const fallbackChat = runtime.fallbackChat || callFallbackChat;
  const fallback = await callChatSlot(fallbackChat, buildFallbackChatRequest(request));
  return finishChatResult(fallback, fallback.kind === "error" ? "unavailable" : "fallback");
}

function finishChatResult(result, position) {
  noteChatOutcome(result);
  traceStage("output", { status: result.kind === "reply" ? "ok" : result.kind === "error" ? "failed" : "skipped",
    reason: result.kind === "reply" ? undefined : result.reason, position });
  return { ...result, position };
}

function buildFallbackChatRequest(request) {
  return {
    userMsg: request.userMsg,
    userName: request.userName,
    history: request.options?.visionSession ? request.history : buildModelFallbackHistory(
      request.history,
      request.imageUrls,
      request.options?.visionContext,
    ),
    groupId: request.groupId,
    isAtMe: request.isAtMe,
    mood: request.mood,
    options: {
      currentUserId: request.options?.currentUserId,
      currentInput: request.options?.currentInput,
      toolSession: request.options?.toolSession,
      allowTools: request.options?.allowTools,
      visionSession: request.options?.visionSession,
      personaCue: request.options?.personaCue,
    },
  };
}

function withToolSession(request, task) {
  const options = request.options || {};
  const surface = request.groupId === null || request.groupId === undefined ? "private" : "group";
  const scope = { surface, groupId: request.groupId, userId: options.currentUserId };
  const visionSession = options.visionSession || (request.imageUrls?.length && !Object.hasOwn(options, "visionContext")
    ? createVisionSession(request.imageUrls, { scope, sources: options.imageSources, usageContext: { task } }) : null);
  return { ...options, ...(visionSession ? { visionSession } : {}), toolSession: options.toolSession || createChatToolSession({
    scope, task,
    userMessage: request.userMsg, allowTools: task === "interjection" ? false : options.allowTools,
  }) };
}

export function buildModelFallbackHistory(history, imageUrls, visionContext) {
  if (!imageUrls?.length) return Array.isArray(history) ? history : [];
  return appendImageContext(history, visionContext, { imageCount: imageUrls.length });
}

export async function resolveChatVisionContext(imageUrls, options = {}) {
  return await resolveVisionContext(imageUrls || [], {
    usageContext: {
      userId: options.userId,
      task: MODEL_TASKS.GROUP_CHAT,
      position: "primary",
    },
  });
}

export async function callRawModelProvider(provider, request = {}) {
  if (provider === MODEL_PROVIDERS.PRIMARY || provider === MODEL_PROVIDERS.FALLBACK) {
    const result = await callApiProvider(provider, buildRawRequest(request));
    return result.ok ? result.raw : null;
  }
  throw new Error("unknown model provider: " + provider);
}

export async function callTaskRawProvider(task, position, request = {}) {
  const result = await callTaskProviderResult(task, position, request);
  return result.ok ? result.raw : null;
}

export async function callTaskProviderResult(task, position, request = {}, options = {}) {
  return await callTaskApi(task, position, buildRawRequest(request), options);
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
    usageContext: request.options?.usageContext || request.usageContext,
  };
}

function parseRawText(raw, provider) {
  if (!raw) return "";
  const packet = buildOutputPacket(raw, { provider });
  return packet.ok ? packet.text : "";
}
