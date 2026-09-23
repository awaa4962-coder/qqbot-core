// Group chat and bounded tool rounds; task routes select the actual provider.
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { MIMO_TOOLS } from "./search.mjs";
import { tryMiMoVision } from "./vision.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { chatError, parseChatOutcome } from "./chat-outcome.mjs";
import { buildModelPrompt } from "./system-prompts/compose.mjs";
import { buildImageContextMessage } from "./system-prompts/image-context.mjs";
import { buildInterjectionPrompt } from "./interjection-policy.mjs";
import { selectPersonaCue } from "./persona-style.mjs";
import { runScopedChat } from "./chat-tools/runner.mjs";

export function buildSystem(_userName, groupId, mood, options = {}) {
  return buildModelPrompt({ ...options, groupId, mood }).system;
}

// ── tryMiMo 拆分子函数 ──

/** 处理图片 → 文本描述 */
export async function resolveVisionContext(imageUrls, options = {}) {
  if (!imageUrls?.length) return null;
  log('vision: processing', imageUrls.length, 'images');
  const desc = await tryMiMoVision(imageUrls, options);
  log('vision: MiMo result', desc ? 'ok (' + desc.length + ' chars)' : 'NULL');
  if (!desc) { log('vision: no visual description available'); }
  return desc;
}

/** 调用 MiMo API(不含 tool_call 编排) */
export async function callMiMoApi(systemPrompt, messages, maxTokens, options = {}) {
  const request = {
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    maxTokens,
    temperature: options.temperature ?? 0.7,
    timeoutMs: options.timeoutMs || 60000,
    thinking: options.thinking,
    reasoningSignals: options.reasoningSignals,
    tools: options.allowTools === false ? [] : MIMO_TOOLS,
    toolChoice: "auto",
    usageContext: options.usageContext,
    selfContext: options.selfContext,
    promptMetadata: options.promptMetadata,
  };
  const result = options.providerId
    ? await callApiProvider(options.providerId, request)
    : await callTaskApi(options.task || "group_chat", options.position || "primary", request);
  return result.ok ? result.raw : null;
}

/** 解析 MiMo 响应为纯文本(不含 tool_call 处理) */
export function parseMiMoResponse(rawResponse, options = {}) {
  return parseChatOutcome(rawResponse, options).text;
}

function resolveMaxTokens(groupId, isAtMe) {
  if (!isAtMe) return 192;
  return LONG_GROUPS.includes(String(groupId)) ? 1024 : 1536;
}

async function buildMiMoMessages(history, imageUrls, userMsg, userName, options) {
  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);

  const visionDesc = Object.prototype.hasOwnProperty.call(options, 'visionContext')
    ? options.visionContext
    : await resolveVisionContext(imageUrls, { usageContext: options.usageContext });
  if (imageUrls?.length) {
    msgs.push(buildImageContextMessage(visionDesc, { imageCount: imageUrls.length }));
  }

  const currentInput = options.replyMode === 'interjection'
    ? buildInterjectionPrompt(userMsg, {
        userName,
        userId: options.currentUserId,
        hasImages: Boolean(imageUrls?.length),
        visionAvailable: Boolean(visionDesc),
        currentInput: options.currentInput,
      })
    : typeof options.currentInput === 'string' ? options.currentInput : buildCurrentInput(userName, userMsg, options.currentUserId);
  msgs.push({ role: 'user', content: currentInput });
  return msgs;
}

export async function tryMiMo(userMsg, userName, history, imageUrls, groupId, isAtMe, mood, options = {}) {
  return (await tryMiMoResult(userMsg, userName, history, imageUrls, groupId, isAtMe, mood, options)).text;
}

export async function tryMiMoResult(userMsg, userName, history, imageUrls, groupId, isAtMe, mood, options = {}) {
  const shouldAnswer = isAtMe === undefined ? true : isAtMe;
  const maxTok = resolveMaxTokens(groupId, shouldAnswer);
  const mimoOptions = {
    allowTools: options.allowTools !== undefined ? options.allowTools : shouldAnswer,
    replyMode: options.replyMode || 'chat',
    currentUserId: options.currentUserId,
    currentInput: options.currentInput,
    toolSession: options.toolSession,
    thinking: options.replyMode === 'interjection' ? { type: 'disabled' } : undefined,
    personaCue: options.personaCue || selectPersonaCue(userMsg, {
      replyMode: options.replyMode || 'chat',
    }),
    providerId: options.providerId,
    task: options.task || (options.replyMode === "interjection" ? "interjection" : "group_chat"),
    position: options.position || "primary",
    reasoningSignals: { hasImages: Boolean(imageUrls?.length) },
    usageContext: buildMiMoUsageContext(options),
    selfContext: { surface: "group", groupId, userId: options.currentUserId },
    ...(Object.prototype.hasOwnProperty.call(options, 'visionContext')
      ? { visionContext: options.visionContext }
      : {}),
  };

  try {
    const prompt = buildModelPrompt({ ...mimoOptions, groupId, mood });
    mimoOptions.promptMetadata = prompt.metadata;
    const msgs = [prompt.dynamicMessage, ...await buildMiMoMessages(history, imageUrls, userMsg, userName, mimoOptions)];
    const system = prompt.system;
    return await runScopedChat({
      messages: [{ role: 'system', content: system }, ...msgs],
      maxTokens: maxTok, temperature: 0.7, timeoutMs: 60000,
      thinking: mimoOptions.thinking, reasoningSignals: mimoOptions.reasoningSignals,
      usageContext: mimoOptions.usageContext, selfContext: mimoOptions.selfContext,
      promptMetadata: prompt.metadata,
    }, { ...mimoOptions, userMessage: userMsg });
  } catch (e) {
    logE('tryMiMo error:', e.message);
    return chatError("request_failed");
  }
}

function buildMiMoUsageContext(options) {
  return {
    userId: options.currentUserId,
    task: options.task || (options.replyMode === "interjection" ? "interjection" : "group_chat"),
    position: options.position || "primary",
  };
}
