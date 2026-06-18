// bridge/search.mjs — 搜索模块（Tavily + Bing CN 兜底 + DS 搜索总结 + B站/Link预览）
import { CFG } from './config.mjs';
import { log, logE } from './logger.mjs';

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
  if (!text || !CFG.tavilyKey) return false;
  const t = text.toLowerCase();
  for (const kw of SEARCH_TRIGGERS) { if (t.includes(kw)) return true; }
  return false;
}

export async function webSearch(query) {
  if (!CFG.tavilyKey) return bingSearch(query);
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: CFG.tavilyKey, query: query, max_results: 5, include_answer: true }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('Tavily HTTP ' + r.status);
    const d = await r.json();
    if (d?.results?.length) {
      let out = '搜索结果:\n';
      for (const res of d.results.slice(0, 3)) { out += '- ' + res.title + ': ' + (res.content?.slice(0, 200) || '') + '\n'; }
      if (d.answer) out += '\n总结: ' + d.answer;
      return out;
    }
    return '未找到相关结果';
  } catch (e) {
    logE('webSearch (Tavily) error:', e.message, '-> falling back to Bing');
    return await bingSearch(query);
  }
}

export async function bingSearch(query) {
  try {
    const r = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&form=QBLH&mkt=zh-CN', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('Bing HTTP ' + r.status);
    const html = await r.text();
    const results = [];
    const algoRe = /<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = algoRe.exec(html)) !== null) {
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const snippet = match[3].replace(/<[^>]*>/g, '').trim().slice(0, 200);
      if (title && snippet) { results.push('- ' + title + ': ' + snippet); if (results.length >= 5) break; }
    }
    if (!results.length) {
      const fallRe = /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = fallRe.exec(html)) !== null) {
        const title = match[2].replace(/<[^>]*>/g, '').trim();
        if (title && !title.includes('Bing') && !title.includes('Microsoft')) { results.push('- ' + title); if (results.length >= 5) break; }
      }
    }
    if (results.length) { log('bingSearch: got', results.length, 'results'); return '搜索结果 (Bing):\n' + results.join('\n'); }
    return '未找到相关结果';
  } catch (e) { logE('bingSearch error:', e.message); return '搜索暂时不可用: ' + e.message; }
}

export async function buildSearchFallback(toolResults, toolResults2, userMsg, userName) {
  const allResults = (toolResults || []).concat(toolResults2 || []);
  const rawText = allResults.map(t => typeof t.content === 'string' ? t.content : '').filter(c => c && c !== '未找到相关结果' && c !== '搜索功能未配置').join('\n\n');
  if (!rawText.trim()) return '唔…好像没找到什么有用的结果呢，换个关键词试试叭～';
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.dsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是夜星，一个可爱的AI猫娘助手。用户的问题是：' + userMsg + '。现在用2-3句话总结以下搜索结果回答用户，保持猫娘口吻，带喵和颜文字，不要长篇大论。' },
          { role: 'user', content: '用户' + (userName||'') + '问了：' + userMsg + '\n\n搜索结果：\n' + rawText.slice(0, 3000) },
        ],
        max_tokens: 300, temperature: 0.7,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    const summary = d?.choices?.[0]?.message?.content?.trim();
    if (summary) return summary;
  } catch (e) { logE('buildSearchFallback DS summary failed:', e.message); }
  const short = rawText.slice(0, 300).trim();
  return '夜星搜到了一些结果喵，大概是：' + short + (rawText.length > 300 ? '…' : '');
}

// B站 / 通用 Link Preview → 已拆分至 services/link-preview/
export { extractLinkPreview } from "./services/link-preview/index.mjs";
