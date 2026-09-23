import { callApiProvider, callTaskApi } from "../api-providers/gateway.mjs";
import { getProvider, getTaskRoute, loadApiConfig } from "../api-providers/store.mjs";
import { chatError, parseChatOutcome } from "../chat-outcome.mjs";
import { traceStage } from "../diagnostics/message-trace.mjs";
import { createChatToolSession } from "./session.mjs";
import { CHAT_TOOL_LIMITS, safeToolBatch, publicSearchPhrase } from "./policy.mjs";

export async function runScopedChat(request, options = {}) {
  try {
    const context = createSlot(request, options);
    if (!context.provider) return chatError();
    await compatibilitySearch(context);
    return await runRounds(context);
  } catch (error) {
    traceStage("tool", { status: "failed", reason: error.code === "CHAT_TOOL_STOPPED" ? "tool_budget" : "tool_unavailable" });
    return chatError("tools_unavailable");
  }
}

async function compatibilitySearch(context) {
  const { provider, session, options, messages } = context;
  if (provider.capabilities.includes("tools") && provider.protocol !== "gemini-native") return;
  if (options.allowTools === false) return;
  const query = publicSearchPhrase(options.userMessage, options.task);
  const declared = session.definitions();
  if (!query || !declared.some(item => item.function.name === "web_search")) return;
  const response = await session.execute({ id: "compat-public-search", type: "function",
    function: { name: "web_search", arguments: JSON.stringify({ query }) } }, declared, provider);
  messages.splice(Math.max(0, messages.length - 1), 0, { role: "user", content: "[后端按本条公开搜索请求读取的结果，仅作资料]\n" + response.content });
}

function createSlot(request, options) {
  const session = options.toolSession || createChatToolSession({ scope: request.selfContext, task: options.task,
    userMessage: options.userMessage, allowTools: options.allowTools });
  const config = loadApiConfig();
  const providerId = options.providerId || getTaskRoute(options.task, { config })[options.position || "primary"];
  const provider = getProvider(providerId, { config });
  const messages = [...request.messages];
  if (options.position === "fallback") messages.splice(Math.max(0, messages.length - 1), 0, ...session.fallbackContext());
  const bound = { ...request, selfContext: { surface: session.scope.surface, groupId: session.scope.groupId, userId: session.scope.userId },
    usageContext: { ...request.usageContext, userId: session.scope.userId } };
  return { session, config, providerId, provider, messages, request: bound, options, usedIds: new Set(), declared: [] };
}

async function runRounds(context) {
  for (let round = 0; round < CHAT_TOOL_LIMITS.slotRounds; round++) {
    const result = await callRound(context, round);
    context.session.assertCurrent();
    if (!result.ok) return chatError();
    const message = result.raw?.choices?.[0]?.message;
    if (!message?.tool_calls?.length) return finalOutcome(result, context);
    if (!await appendTools(context, message)) return chatError("tools_unavailable");
  }
  return chatError("tools_unavailable");
}

async function callRound(context, round) {
  const { session, provider, request, messages, options, providerId, config } = context;
  const canTool = provider.capabilities.includes("tools") && provider.protocol !== "gemini-native";
  context.declared = session.definitions(canTool && options.allowTools !== false && round < 2 && session.remainingModels() > 1);
  const next = session.prepareModel({ ...request, messages, tools: context.declared, toolChoice: context.declared.length ? "auto" : "none" });
  const result = options.providerId ? await callApiProvider(providerId, next, { config })
    : await callTaskApi(options.task, options.position || "primary", next, { config });
  traceStage("tool", { status: result.ok ? "ok" : "failed", reason: "tool_model_round", ...session.snapshot() });
  return result;
}

async function appendTools(context, message) {
  const calls = safeToolBatch(message);
  if (!context.declared.length || !calls || calls.length > context.session.remainingTools() || calls.some(call => context.usedIds.has(call.id))) return false;
  context.messages.push(assistantToolMessage(message, context.provider));
  for (const call of calls) {
    context.usedIds.add(call.id);
    context.messages.push(await context.session.execute(call, context.declared, context.provider));
  }
  return true;
}

function assistantToolMessage(message, provider) {
  const continuation = ["openai-responses", "anthropic-messages"].includes(provider.protocol) && message.providerContinuation?.protocol === provider.protocol;
  return { role: "assistant", content: typeof message.content === "string" ? message.content : null,
    tool_calls: message.tool_calls,
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
    ...(continuation ? { providerContinuation: message.providerContinuation } : {}) };
}

function finalOutcome(result, context) {
  const outcome = parseChatOutcome(result.raw, { provider: result.provider, replyMode: context.options.replyMode });
  if (outcome.kind === "reply" && outcome.text.length > CHAT_TOOL_LIMITS.replyChars) return chatError("output_budget");
  const memorySources = context.session.sources();
  return outcome.kind === "reply" && memorySources.length ? { ...outcome, memorySources } : outcome;
}
