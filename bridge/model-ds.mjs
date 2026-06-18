// bridge/model-ds.mjs — DeepSeek V4 Flash 兜底 + 私聊
import { LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { webSearch, needsSearch } from "./search.mjs";
import { cleanThinking } from "./thinking.mjs";
import { buildSystem } from "./model-mimo.mjs";
import { deepseekChat } from "./clients/providers/deepseek.mjs";

export async function tryDeepSeek(userMsg, userName, history, groupId, isAtMe, mood) {
  if (isAtMe === undefined) isAtMe = true;
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  const maxTok = isAtMe ? (isLong ? 512 : 1024) : 150;

  let searchCtx = '';
  if (needsSearch(userMsg)) {
    log('DS pre-search triggered for:', JSON.stringify(userMsg.slice(0,80)));
    const searchResult = await webSearch(userMsg);
    if (searchResult && searchResult !== '未找到相关结果' && searchResult !== '搜索功能未配置') {
      searchCtx = '[联网搜索结果]\n' + searchResult + '\n\n请基于以上搜索结果回答用户问题。如果搜索结果不相关，请诚实说明。\n\n';
      log('DS pre-search result:', searchResult.slice(0, 100));
    }
  }

  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);
  if (searchCtx) msgs.push({ role: 'user', content: searchCtx });
  msgs.push({ role: 'user', content: userName + '说: ' + userMsg });

  const system = buildSystem(userName, groupId, mood || '');

  try {
    const result = await deepseekChat(
      [{ role: 'system', content: system }, ...msgs],
      { maxTokens: maxTok, temperature: 0.7, timeoutMs: 30000 }
    );
    return result.ok ? (cleanThinking(result.text) || null) : null;
  } catch (e) {
    logE('tryDeepSeek error:', e.message);
    return null;
  }
}
