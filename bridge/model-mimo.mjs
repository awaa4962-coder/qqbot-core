// bridge/model-mimo.mjs - MiMo V2.5 主力聊天 + 工具调用
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { webSearch, buildSearchFallback, MIMO_TOOLS } from "./search.mjs";
import { tryMiMoVision } from "./vision.mjs";
import { isLeakedReasoning, normalizeInterjectionReply } from "./thinking.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { buildChatSystemPrompt } from "./system-prompts/chat.mjs";
import { buildInterjectionSystemPrompt } from "./system-prompts/interjection.mjs";
import { buildImageContextMessage } from "./system-prompts/image-context.mjs";
import { buildInterjectionPrompt } from "./interjection-policy.mjs";
import { selectPersonaCue } from "./persona-style.mjs";

export function buildSystem(_userName, groupId, mood, options = {}) {
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  if (options.replyMode === 'interjection') {
    return buildInterjectionSystemPrompt({
      mood: mood || '正常',
      personaCue: options.personaCue,
    });
  }
  return buildChatSystemPrompt({
    mood: mood || '正常',
    isLongGroup: isLong,
    replyMode: options.replyMode || 'chat',
    personaCue: options.personaCue,
  });
}

// ── tryMiMo 拆分子函数 ──

/** 处理图片 → 文本描述 */
export async function resolveVisionContext(imageUrls) {
  if (!imageUrls?.length) return null;
  log('vision: processing', imageUrls.length, 'images');
  const desc = await tryMiMoVision(imageUrls);
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
    tools: options.allowTools === false ? [] : MIMO_TOOLS,
    toolChoice: "auto",
  };
  const result = options.providerId
    ? await callApiProvider(options.providerId, request)
    : await callTaskApi(options.task || "group_chat", options.position || "primary", request);
  return result.ok ? result.raw : null;
}

/** 解析 MiMo 响应为纯文本(不含 tool_call 处理) */
export function parseMiMoResponse(rawResponse, options = {}) {
  const packet = buildOutputPacket(rawResponse, {
    provider: options.provider || rawResponse?.provider || "mimo",
  });
  log("MiMo output packet:", JSON.stringify({
    ok: packet.ok,
    finishReason: packet.finishReason,
    risks: packet.risks,
    lengths: packet.lengths,
  }));
  if (!packet.ok) return null;
  if (options.replyMode === 'interjection') return normalizeInterjectionReply(packet.text);
  return packet.text || null;
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
    : await resolveVisionContext(imageUrls);
  if (imageUrls?.length) {
    msgs.push(buildImageContextMessage(visionDesc, { imageCount: imageUrls.length }));
  }

  const currentInput = options.replyMode === 'interjection'
    ? buildInterjectionPrompt(userMsg, {
        userName,
        userId: options.currentUserId,
        hasImages: Boolean(imageUrls?.length),
        visionAvailable: Boolean(visionDesc),
      })
    : buildCurrentInput(userName, userMsg, options.currentUserId);
  msgs.push({ role: 'user', content: currentInput });
  return msgs;
}

async function parseInitialMiMoResult(system, msgs, response, maxTok, userMsg, userName, options) {
  const choice = response?.choices?.[0];
  if (!choice) return null;

  const msg = choice.message;
  if (msg?.tool_calls?.length) {
    if (options.allowTools === false) {
      log('MiMo tool_calls ignored because tools are disabled');
      return null;
    }
    return await handleToolCalls(system, msgs, msg, maxTok, userMsg, userName, options);
  }

  return parseMiMoResponse(response, options);
}

export async function tryMiMo(userMsg, userName, history, imageUrls, groupId, isAtMe, mood, options = {}) {
  const shouldAnswer = isAtMe === undefined ? true : isAtMe;
  const maxTok = resolveMaxTokens(groupId, shouldAnswer);
  const mimoOptions = {
    allowTools: options.allowTools !== undefined ? options.allowTools : shouldAnswer,
    replyMode: options.replyMode || 'chat',
    currentUserId: options.currentUserId,
    thinking: options.replyMode === 'interjection' ? { type: 'disabled' } : undefined,
    personaCue: options.personaCue || selectPersonaCue(userMsg, {
      replyMode: options.replyMode || 'chat',
    }),
    providerId: options.providerId,
    task: options.task || (options.replyMode === "interjection" ? "interjection" : "group_chat"),
    position: options.position || "primary",
    ...(Object.prototype.hasOwnProperty.call(options, 'visionContext')
      ? { visionContext: options.visionContext }
      : {}),
  };

  try {
    const msgs = await buildMiMoMessages(history, imageUrls, userMsg, userName, mimoOptions);
    const system = buildSystem(userName, groupId, mood || '', mimoOptions);
    const response = await callMiMoApi(system, msgs, maxTok, {
      allowTools: mimoOptions.allowTools,
      thinking: mimoOptions.thinking,
      providerId: mimoOptions.providerId,
      task: mimoOptions.task,
      position: mimoOptions.position,
    });
    return await parseInitialMiMoResult(system, msgs, response, maxTok, userMsg, userName, mimoOptions);
  } catch (e) {
    logE('tryMiMo error:', e.message);
    return null;
  }
}

// ── tool_call 多轮编排 ──

function parseToolCallPayload(tc) {
  try {
    return JSON.parse(tc.function.arguments);
  } catch (e) {
    logE('MiMo tool_call args parse error:', e.message);
    return null;
  }
}

async function executeKnownTool(tc, roundLabel) {
  if (tc.function?.name !== 'web_search') return null;
  const args = parseToolCallPayload(tc);
  if (!args?.query) return null;

  log('MiMo web_search' + roundLabel + ' query:', JSON.stringify(args.query.slice(0,100)));
  const result = await webSearch(args.query);
  log('MiMo web_search' + roundLabel + ' result:', result.slice(0, 100));
  return { role: 'tool', tool_call_id: tc.id, content: result };
}

async function collectToolResults(toolCalls, roundLabel = '') {
  const toolResults = [];
  for (const tc of toolCalls || []) {
    const result = await executeKnownTool(tc, roundLabel);
    if (result) toolResults.push(result);
  }
  return toolResults;
}

function getChoiceMessage(response) {
  return response?.choices?.[0]?.message || null;
}

function usableReply(response, roundLabel) {
  const reply = parseMiMoResponse(response);
  if (reply && !isLeakedReasoning(reply)) return reply;
  if (reply) log('MiMo ' + roundLabel + ' reply is leaked reasoning, using search fallback');
  return null;
}

async function fallbackFromSearch(toolResults, toolResults2, userMsg, userName, roundLabel) {
  log('MiMo ' + roundLabel + ' think-only, using search data as fallback');
  return await buildSearchFallback(toolResults, toolResults2, userMsg, userName);
}

async function handleSecondRoundTools(
  system,
  msgs,
  msg,
  toolResults,
  choice2Message,
  maxTok,
  userMsg,
  userName,
  modelOptions
) {
  const toolCalls2 = choice2Message?.tool_calls || [];
  if (!toolCalls2.length) return null;

  log('MiMo tool_calls round 2:', toolCalls2.length, 'calls');
  const toolResults2 = await collectToolResults(toolCalls2, ' r2');
  if (!toolResults2.length) return null;

  const d3 = await callMiMoApi(
    system,
    [...msgs, msg, ...toolResults, choice2Message, ...toolResults2],
    maxTok,
    modelOptions
  );
  return usableReply(d3, 'r3') || await fallbackFromSearch(toolResults, toolResults2, userMsg, userName, 'r3');
}

async function handleToolCalls(system, msgs, msg, maxTok, userMsg, userName, modelOptions = {}) {
  log('MiMo tool_calls:', msg.tool_calls.length, 'calls');
  const toolResults = await collectToolResults(msg.tool_calls);
  if (!toolResults.length) return null;

  const d2 = await callMiMoApi(system, [...msgs, msg, ...toolResults], maxTok, modelOptions);
  const choice2Message = getChoiceMessage(d2);
  if (!choice2Message) return null;

  const r3Reply = await handleSecondRoundTools(
    system,
    msgs,
    msg,
    toolResults,
    choice2Message,
    maxTok,
    userMsg,
    userName,
    modelOptions
  );
  if (r3Reply) return r3Reply;

  return usableReply(d2, 'r2') || await fallbackFromSearch(toolResults, [], userMsg, userName, 'r2');
}
