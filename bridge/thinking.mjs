// bridge/thinking.mjs — MiMo 思维链处理（content 提取、泄露检测、清洗）
import { log } from './logger.mjs';

const INTERJECTION_REPLY_MAX_CHARS = 160;

export function miMoContent(msg) {
  if (!msg) return null;
  const c = typeof msg.content === 'string' ? msg.content : '';
  const r = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (r.trim()) {
    log('miMoContent: reasoning_content ignored (' + r.length + ' chars)');
  }
  return c.trim() ? c : null;
}

// 检测纯文本思维链泄露：第三人称分析+自我指令+无实际回复
export function isLeakedReasoning(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 20) return false;
  const analysisPatterns = [
    /用户(说|表示|提到|问了|发了|指出|抱怨)/,
    /(看起来|似乎|好像).*(在讨论|在说|在问|在强调|的意思)/,
    /(可能|大概).*(是指|是想|在抱怨|在开玩笑)/,
    /(从之前的对话看|这个语境|上下文|在群里)/,
    /搜索结果.*(没有|显示|提到|相关)/,
  ];
  const planningPatterns = [
    /(我|夜星)需要.*(回应|回复|处理|注意)/,
    /(我|夜星)(得|应该|要).*(理解|回应|回复|处理|判断|分析|构思)/,
    /(首先|然后|接着|最后).*[，,\n]/,
    /(应该|要).*(保持|注意|避免|确保)/,
    /^.*(分析|判断|理解).*(对话|上下文|意图)/,
  ];
  const responsePatterns = [
    /喵[～~！!。]/,
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

export function normalizeInterjectionReply(text) {
  if (!text || typeof text !== 'string') return null;
  let reply = text.trim();
  reply = reply
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  if (reply.startsWith('{')) {
    try {
      const parsed = JSON.parse(reply);
      reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    } catch {
      // MiMo may output incomplete JSON; try regex rescue before giving up
      const m = reply.match(/"reply"\s*:\s*"([^"]*)/);
      reply = m ? m[1].trim() : '';
    }
  }

  if (!reply || reply.length > INTERJECTION_REPLY_MAX_CHARS || reply.includes('\n')) return null;
  if (isLeakedReasoning(reply)) return null;

  const metaPatterns = [
    /^(用户|群友|.*在群里)/,
    /(看起来|似乎|好像).*(在|是|想)/,
    /(从之前的对话看|这个语境|上下文|搜索结果)/,
    /(我|夜星)(得|需要|应该|要).*(理解|回应|回复|处理|判断|分析|构思)/,
    /(可能|大概).*(是想|是在|因为|抱怨|投诉|要求)/,
  ];
  if (metaPatterns.some(p => p.test(reply))) return null;

  return reply;
}

export function isUnsafeReasoningText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  const unsafePatterns = [
    /^(思考过程|分析|推理|我的思路)\s*[:：]/,
    /^(我需要先|首先我需要|让我分析一下|用户的意思是)/,
    /(用户的意思是|让我分析一下|首先我需要|我需要先)/,
    /(用户|群友).{0,20}(说|问|提到|表示).{0,80}(我需要|我应该|我得|需要先|首先)/,
    /(看起来|从之前的对话看|这个语境|上下文).{0,120}(我需要|我应该|我得|理解|分析|判断)/,
    /^The user (said|asked|seems|wants)/i,
  ];
  if (unsafePatterns.some(p => p.test(t))) return true;
  return isLeakedReasoning(t);
}

export function sanitizeAssistantReply(text) {
  const cleaned = cleanThinking(text);
  if (!cleaned) return null;
  if (isUnsafeReasoningText(cleaned)) {
    log('sanitizeAssistantReply: unsafe reasoning text dropped (' + cleaned.length + ' chars)');
    return null;
  }
  return cleaned;
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
  const unsafeBlocks = [
    /^(?:思考过程|分析|推理|我的思路)\s*[:：][\s\S]*?(?:\n{2,}|$)/,
    /^(?:我需要先|首先我需要|让我分析一下|用户的意思是)[\s\S]*?(?:\n{2,}|$)/,
  ];
  for (const p of unsafeBlocks) {
    const m = t.match(p);
    if (m) t = t.slice(m[0].length).trim();
  }
  t = t.trim();
  if (!t) { log('cleanThinking: stripped to empty, returning null for fallback'); return null; }
  return t;
}
