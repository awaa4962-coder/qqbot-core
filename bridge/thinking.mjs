// bridge/thinking.mjs — MiMo 思维链处理（content 提取、泄露检测、清洗）
import { log } from './logger.mjs';

// MiMo 把回复塞 reasoning_content 而非 content → 优先取 reasoning，fallback content
export function miMoContent(msg) {
  if (!msg) return null;
  const c = msg.content || '';
  const r = msg.reasoning_content || '';
  if (typeof c === 'string' && c.trim() && isLeakedReasoning(c) && r.trim()) {
    log('miMoContent: content looks like leaked reasoning, using reasoning_content instead');
    return r;
  }
  return c || r || null;
}

// 检测纯文本思维链泄露：第三人称分析+自我指令+无实际回复
export function isLeakedReasoning(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 20) return false;
  const analysisPatterns = [
    /用户(说|表示|提到|问了|发了|指出|抱怨)/,
    /(看起来|似乎|好像).*(在讨论|在说|在问|的意思)/,
    /(可能|大概).*(是指|是想|在抱怨|在开玩笑)/,
  ];
  const planningPatterns = [
    /(我|夜星)需要.*(回应|回复|处理|注意)/,
    /(首先|然后|接着|最后).*[，,\n]/,
    /(应该|要).*(保持|注意|避免|确保)/,
    /^.*(分析|判断|理解).*(对话|上下文|意图)/,
  ];
  const responsePatterns = [
    /(喵[～~！!。]|[（(].*[）)])/,
    /[😀-🙏🐱🌟✨💕]/u,
    /(哈哈|诶嘿|嗷|捏|哒|惹|鸭)[！!。，,～~]/,
    /^[^用看这可也但所因如而虽不我你他是].*[呢嘛吧啊哦呀哈呵嘿]$/m,
  ];
  const hasAnalysis = analysisPatterns.some(p => p.test(t));
  const hasPlanning = planningPatterns.some(p => p.test(t));
  const hasResponse = responsePatterns.some(p => p.test(t));
  if (hasAnalysis && hasPlanning && !hasResponse) {
    log('isLeakedReasoning: detected leaked chain-of-thought (' + t.length + ' chars)');
    return true;
  }
  return false;
}

export function cleanThinking(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/<\s*(?:think|thinking|reasoning|thought)\s*>[\s\S]*?<\/\s*(?:think|thinking|reasoning|thought)\s*>/gi, '');
  t = t.replace(/<\s*(?:think|thinking|reasoning|thought)\s*>[\s\S]*?(?=\n\n|$)/gi, '');
  t = t.replace(/<\/?\s*(?:think|thinking|reasoning|thought)\s*>/gi, '');
  if (/<\s*tool_call\s*>/i.test(t) || /<\s*function\s*=\s*web_search/i.test(t)) {
    log('cleanThinking: stripping leaked tool_call XML');
    t = t.replace(/<\s*tool_call\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi, '');
    t = t.replace(/<\s*tool_call\s*>[\s\S]*$/gi, '');
    t = t.replace(/<\/\s*tool_call\s*>/gi, '');
    t = t.replace(/<\s*function\s*=\s*\w+\s*>/gi, '');
    t = t.replace(/<\s*parameter\s*=\s*\w+\s*>/gi, '');
    t = t.replace(/<\s*\/\s*parameter\s*>/gi, '');
    t = t.replace(/<\s*\/\s*function\s*>/gi, '');
  }
  const patterns = [/^(嗯[，,]?让我想想[。\n]*|好[，,]?我来[^\n]*[。\n]*|明白了[，,]?[^\n]*[。\n]*)/];
  for (const p of patterns) {
    const m = t.match(p); if (m) { const rest = t.slice(m[0].length).trim(); if (rest.length > 0) t = rest; }
  }
  t = t.trim();
  if (!t) { log('cleanThinking: stripped to empty, returning null for fallback'); return null; }
  return t;
}
