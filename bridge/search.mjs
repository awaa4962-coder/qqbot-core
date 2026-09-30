// bridge/search.mjs — 搜索模块（Tavily + Bing CN 兜底 + DS 搜索总结 + B站/Link预览）
import { CFG } from './config.mjs';
import { log, logE } from './logger.mjs';
import { callTaskApi } from './api-providers/gateway.mjs';
import { createModelTaskBudget } from './api-providers/task-budget.mjs';
import { buildOutputPacket } from './output-pipeline.mjs';
import { CORE_IDENTITY, CONTEXT_SAFETY } from './system-prompts/identity.mjs';
import { redactSensitiveText } from './privacy.mjs';
import { assertChatRunCurrent, chatRunSignal } from './cognition/chat-run.mjs';
import { getMemoryPrivacyGeneration } from './memory-profile/generation.mjs';
import { fetchSafeResponse, readBoundedResponseBuffer, validateSafeUrl } from './safe-url.mjs';

// Tool definition
export const MIMO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索最新的网络信息',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
    },
  },
];

const SEARCH_TRIGGERS = ['搜索', '搜一下', '查一下', '查查', '帮我搜', '搜搜', '今天天气', '最近新闻', '最近有什么', '热搜', '发生了什么', '实时']; // 去掉"最新""当前""现在怎么样"等日常高频词

export function needsSearch(text) {
  if (!text) return false;
  // webSearch 有 Bing fallback，所以这里不依赖 Tavily key 是否存在
  const t = text.toLowerCase();
  for (const kw of SEARCH_TRIGGERS) { if (t.includes(kw)) return true; }
  return false;
}

export async function webSearch(query, options = {}) {
  return formatSearchResults(await searchResults(query, options));
}

// Structured evidence uses the same providers/fallback, without a model summary call.
export async function webSearchResults(query, { signal } = {}) {
  const result = await searchResults(query, { signal });
  return {
    status: result.status,
    sources: result.sources.slice(0, 5).flatMap(source => {
      const url = sourceUrl(source.url);
      return url ? [{ url, title: String(source.title || '').slice(0, 160), snippet: String(source.snippet || '').slice(0, 300) }] : [];
    }),
    answer: String(result.answer || '').slice(0, 800),
  };
}

async function searchResults(query, options) {
  assertSearchCurrent(options);
  query = redactSensitiveText(query);
  if (!CFG.tavilyKey) return bingSearchResults(query, options);
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: CFG.tavilyKey, query: query, max_results: 5, include_answer: true }),
      signal: searchSignal(12000, options.signal), redirect: 'error',
    });
    if (!r.ok) throw new Error('Tavily HTTP ' + r.status);
    const buffer = r.body ? await readBoundedResponseBuffer(r, 128 * 1024) : null;
    if (r.body && buffer === null) throw new Error('Tavily response too large');
    const d = buffer ? JSON.parse(buffer.toString('utf8')) : await r.json();
    assertSearchCurrent(options);
    if (d?.results?.length) {
      return { status: 'ok', provider: 'tavily', sources: d.results.slice(0, 5).map(res => ({
        url: res.url, title: res.title, snippet: res.content || '',
      })), answer: d.answer || '' };
    }
    return { status: 'empty', sources: [], answer: '' };
  } catch {
    assertSearchCurrent(options);
    logE('webSearch (Tavily) failed; trying public fallback');
    return await bingSearchResults(query, options);
  }
}

export async function bingSearch(query, options = {}) {
  return formatSearchResults(await bingSearchResults(query, options));
}

async function bingSearchResults(query, options = {}) {
  assertSearchCurrent(options);
  query = redactSensitiveText(query);
  try {
    const safe = await fetchSafeResponse('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&form=QBLH&mkt=zh-CN', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: searchSignal(10000, options.signal), timeoutMs: 10000, maxRedirects: 0,
    });
    const r = safe.response;
    if (!safe.ok || !r?.ok) throw new Error('Bing unavailable');
    const buffer = await readBoundedResponseBuffer(r, 128 * 1024);
    if (buffer === null) throw new Error('Bing response too large');
    const html = buffer.toString('utf8');
    assertSearchCurrent(options);
    const results = parseBingSources(html);
    if (results.length) { log('bingSearch: got', results.length, 'results'); return { status: 'ok', provider: 'bing', sources: results, answer: '' }; }
    return { status: 'empty', sources: [], answer: '' };
  } catch { assertSearchCurrent(options); logE('bingSearch failed'); return { status: 'unavailable', sources: [], answer: '' }; }
}

function parseBingSources(html) {
  const results = [];
  const algoRe = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = algoRe.exec(html)) !== null) {
    const title = match[2].replace(/<[^>]*>/g, '').trim();
    const snippet = match[3].replace(/<[^>]*>/g, '').trim().slice(0, 200);
    if (title && snippet) { results.push({ url: match[1], title, snippet }); if (results.length >= 5) break; }
  }
  if (!results.length) {
    const fallRe = /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = fallRe.exec(html)) !== null) {
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      if (title && !title.includes('Bing') && !title.includes('Microsoft')) { results.push({ url: match[1], title, snippet: '' }); if (results.length >= 5) break; }
    }
  }
  return results;
}

function formatSearchResults(result) {
  if (result.status === 'unavailable') return '搜索暂时不可用';
  if (result.status !== 'ok') return '未找到相关结果';
  if (result.provider === 'bing') return '搜索结果 (Bing):\n' + result.sources.map(source => '- ' + source.title + (source.snippet ? ': ' + source.snippet : '')).join('\n');
  let out = '搜索结果:\n';
  for (const source of result.sources.slice(0, 3)) out += '- ' + source.title + ': ' + source.snippet.slice(0, 200) + '\n';
  if (result.answer) out += '\n总结: ' + result.answer;
  return out;
}

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  let url = validateSafeUrl(value.replace(/&amp;/gi, '&'));
  if (!url.ok) return '';
  // Bing sometimes wraps the target in a base64-encoded click-tracking URL.
  if (/(?:^|\.)bing\.com$/i.test(url.url.hostname) && url.url.pathname === '/ck/a') {
    const target = url.url.searchParams.get('u');
    if (target?.startsWith('a1')) url = validateSafeUrl(Buffer.from(target.slice(2), 'base64url').toString('utf8'));
  }
  return url.ok && url.url.href.length <= 2048 ? url.url.href : '';
}

function searchSignal(timeoutMs, external) {
  return globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(timeoutMs), chatRunSignal(), external].filter(Boolean));
}

function assertSearchCurrent(options) { assertChatRunCurrent(); options.signal?.throwIfAborted(); }

export async function buildSearchFallback(toolResults, toolResults2, userMsg, userName, selfContext, options = {}) {
  const privacyGeneration = getMemoryPrivacyGeneration();
  const assertCurrent = () => {
    assertSearchCurrent(options);
    options.assertCurrent?.();
    if (privacyGeneration !== getMemoryPrivacyGeneration()) {
      throw Object.assign(new Error('privacy_changed'), { code: 'CHAT_MEMORY_CHANGED' });
    }
  };
  assertCurrent();
  const allResults = (toolResults || []).concat(toolResults2 || []);
  const rawText = redactSensitiveText(allResults.map(t => typeof t.content === 'string' ? t.content : '').filter(c => c && c !== '未找到相关结果' && c !== '搜索功能未配置' && !c.startsWith('搜索暂时不可用')).join('\n\n'));
  if (!rawText.trim()) return '唔…好像没找到什么有用的结果呢，换个关键词试试叭～';
  try {
    const budget = createModelTaskBudget("search_summary", { now: options.budgetClock,
      signal: globalThis.AbortSignal.any([chatRunSignal(), options.signal].filter(Boolean)), assertCurrent });
    const prepared = budget.prepare({
      messages: [
        { role: 'system', content: [CORE_IDENTITY, CONTEXT_SAFETY, '用2-3句话基于搜索结果回答用户，结果不足或不相关时明确说明。自然表达，不强加口癖或颜文字。'].join('\n') },
        { role: 'user', content: redactSensitiveText('用户' + (userName||'') + '问了：' + userMsg) + '\n\n搜索结果：\n' + rawText.slice(0, 3000) },
      ],
      promptMetadata: { promptVersion: "search-summary-v1" },
      maxTokens: 300,
      temperature: 0.7,
      timeoutMs: 15000,
      selfContext,
    });
    let result;
    try { result = await (options.callProvider || callTaskApi)("search_summary", "primary", prepared); }
    finally { budget.assertCurrent(); }
    const packet = result.ok ? buildOutputPacket(result.raw, { provider: result.provider }) : null;
    const summary = packet?.ok ? packet.text : "";
    if (summary) return summary;
  } catch (e) {
    assertCurrent();
    logE('buildSearchFallback DS summary failed:', e.message);
  }
  assertCurrent();
  const short = rawText.slice(0, 300).trim();
  return '夜星搜到了一些结果喵，大概是：' + short + (rawText.length > 300 ? '…' : '');
}

// B站 / 通用 Link Preview → 已拆分至 services/link-preview/
export { extractLinkPreview } from "./services/link-preview/index.mjs";
