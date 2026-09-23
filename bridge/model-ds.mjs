// Private/file chat and group fallback; task routes select the actual provider.
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { webSearch, needsSearch } from "./search.mjs";
import { buildModelPrompt } from "./system-prompts/compose.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { chatError, parseChatOutcome } from "./chat-outcome.mjs";
import { selectPersonaCue } from "./persona-style.mjs";

async function buildSearchContext(userMsg, options) {
  // Attachment contents are model input, not permission to publish a search query.
  if (options.task === 'file_chat') return '';
  if (needsSearch(userMsg)) {
    log('DS pre-search input chars:', userMsg.length);
    const searchResult = await webSearch(userMsg);
    if (searchResult && searchResult !== '未找到相关结果' && searchResult !== '搜索功能未配置') {
      log('DS pre-search result chars:', searchResult.length);
      return '[联网搜索结果]\n' + searchResult + '\n\n请基于以上搜索结果回答用户问题。如果搜索结果不相关，请诚实说明。\n\n';
    }
  }
  return '';
}

function buildDeepSeekMessages(userMsg, userName, history, searchCtx, options) {
  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);
  if (searchCtx) msgs.push({ role: 'user', content: searchCtx });
  const currentInput = typeof options.currentInput === 'string' ? options.currentInput : buildCurrentInput(userName, userMsg, options.currentUserId);
  msgs.push({ role: 'user', content: currentInput });
  return msgs;
}

function resolveDeepSeekMaxTokens(groupId, isAtMe) {
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  return isAtMe ? (isLong ? 1024 : 1536) : 150;
}

export async function tryDeepSeek(userMsg, userName, history, groupId, isAtMe, mood, options = {}) {
  return (await tryDeepSeekResult(userMsg, userName, history, groupId, isAtMe, mood, options)).text;
}

export async function tryDeepSeekResult(userMsg, userName, history, groupId, isAtMe, mood, options = {}) {
  if (isAtMe === undefined) isAtMe = true;
  const maxTok = resolveDeepSeekMaxTokens(groupId, isAtMe);
  const searchCtx = await buildSearchContext(userMsg, options);
  const msgs = buildDeepSeekMessages(userMsg, userName, history, searchCtx, options);

  const personaCue = options.personaCue || selectPersonaCue(userMsg, {
    replyMode: options.replyMode || "chat",
  });
  const prompt = buildModelPrompt({
    ...options,
    personaCue, groupId, mood,
  });

  try {
    const privateRequest = isPrivateModelRequest(groupId);
    const task = options.task || (privateRequest ? "private_chat" : "group_chat");
    const request = {
      messages: [{ role: 'system', content: prompt.system }, prompt.dynamicMessage, ...msgs],
      maxTokens: maxTok,
      temperature: 0.7,
      timeoutMs: 30000,
      usageContext: buildDeepSeekUsageContext(options, task, privateRequest),
      selfContext: { surface: privateRequest ? "private" : "group", groupId, userId: options.currentUserId },
      promptMetadata: prompt.metadata,
    };
    const result = options.providerId
      ? await callApiProvider(options.providerId, request)
      : await callTaskApi(task, options.position || (privateRequest ? "primary" : "fallback"), request);
    if (!result.ok) return chatError();
    return parseChatOutcome(result.raw, {
      provider: result.provider || "deepseek",
      finishReason: result.finishReason,
      usage: result.usage,
    });
  } catch (e) {
    logE('tryDeepSeek error:', e.message);
    return chatError("request_failed");
  }
}

function buildDeepSeekUsageContext(options, task, privateRequest) {
  return {
    userId: options.currentUserId,
    task,
    position: options.position || (privateRequest ? "primary" : "fallback"),
  };
}

function isPrivateModelRequest(groupId) {
  return groupId === null || groupId === undefined;
}
