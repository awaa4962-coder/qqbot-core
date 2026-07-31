// bridge/model-ds.mjs — DeepSeek V4 Flash 兜底 + 私聊
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { webSearch, needsSearch } from "./search.mjs";
import { buildSystem } from "./model-mimo.mjs";
import { callApiProvider, callTaskApi } from "./api-providers/gateway.mjs";
import { buildCurrentInput } from "./context/messages.mjs";
import { buildOutputPacket } from "./output-pipeline.mjs";
import { selectPersonaCue } from "./persona-style.mjs";

async function buildSearchContext(userMsg) {
  if (needsSearch(userMsg)) {
    log('DS pre-search triggered for:', JSON.stringify(userMsg.slice(0,80)));
    const searchResult = await webSearch(userMsg);
    if (searchResult && searchResult !== '未找到相关结果' && searchResult !== '搜索功能未配置') {
      log('DS pre-search result:', searchResult.slice(0, 100));
      return '[联网搜索结果]\n' + searchResult + '\n\n请基于以上搜索结果回答用户问题。如果搜索结果不相关，请诚实说明。\n\n';
    }
  }
  return '';
}

function buildDeepSeekMessages(userMsg, userName, history, searchCtx, options) {
  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);
  if (searchCtx) msgs.push({ role: 'user', content: searchCtx });
  msgs.push({ role: 'user', content: buildCurrentInput(userName, userMsg, options.currentUserId) });
  return msgs;
}

function resolveDeepSeekMaxTokens(groupId, isAtMe) {
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  return isAtMe ? (isLong ? 1024 : 1536) : 150;
}

export async function tryDeepSeek(userMsg, userName, history, groupId, isAtMe, mood, options = {}) {
  if (isAtMe === undefined) isAtMe = true;
  const maxTok = resolveDeepSeekMaxTokens(groupId, isAtMe);
  const searchCtx = await buildSearchContext(userMsg);
  const msgs = buildDeepSeekMessages(userMsg, userName, history, searchCtx, options);

  const personaCue = options.personaCue || selectPersonaCue(userMsg, {
    replyMode: options.replyMode || "chat",
  });
  const system = buildSystem(userName, groupId, mood || '', {
    ...options,
    personaCue,
  });

  try {
    const privateRequest = isPrivateModelRequest(groupId);
    const task = options.task || (privateRequest ? "private_chat" : "group_chat");
    const request = {
      messages: [{ role: 'system', content: system }, ...msgs],
      maxTokens: maxTok,
      temperature: 0.7,
      timeoutMs: 30000,
    };
    const result = options.providerId
      ? await callApiProvider(options.providerId, request)
      : await callTaskApi(task, options.position || (privateRequest ? "primary" : "fallback"), request);
    if (!result.ok) return null;
    const packet = buildOutputPacket(result.raw, {
      provider: result.provider || "deepseek",
      finishReason: result.finishReason,
      usage: result.usage,
    });
    log("DeepSeek output packet:", JSON.stringify({
      ok: packet.ok,
      finishReason: packet.finishReason,
      risks: packet.risks,
      lengths: packet.lengths,
    }));
    return packet.ok ? packet.text : null;
  } catch (e) {
    logE('tryDeepSeek error:', e.message);
    return null;
  }
}

function isPrivateModelRequest(groupId) {
  return groupId === null || groupId === undefined;
}
