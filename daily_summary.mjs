// 夜星 · 观澜湖群每日总结生成器
// 每晚 23:55 自动执行

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FILE = path.join(DIR, 'group_chats.json');
const LOG_DIR = path.join(DIR, 'logs');
const API_KEY = fs.readFileSync(path.join(DIR, '.env_mimo'), 'utf-8').trim();

const GROUP_ID = 1105126214;  // 观澜湖同好会
const GROUP_NAME = '观澜湖同好会';

// ── 本日时间范围 ──
const now = new Date();
const tzOffset = 8 * 60 * 60 * 1000;

// "今天" 指北京时间今天 00:00～23:59
const todayStart = new Date(now.getTime() + tzOffset);
todayStart.setUTCHours(0, 0, 0, 0);
const todayStartTs = todayStart.getTime() - tzOffset;

const todayEndTs = todayStartTs + 24 * 60 * 60 * 1000 - 1;

// ── 日期标签（如 "6月9日"） ──
const dateLabel = new Date(todayStartTs + tzOffset)
  .toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 读群聊记录（带重试，对抗桥接器写入时的竞态） ──
async function loadMessages() {
  for (let i = 0; i < 3; i++) {
    try {
      const raw = fs.readFileSync(CHAT_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const msgs = data[String(GROUP_ID)];
      if (Array.isArray(msgs)) return msgs.filter(m => m.ts >= todayStartTs && m.ts <= todayEndTs);
    } catch {}
    if (i < 2) await sleep(200 + Math.random() * 300);
  }
  return [];
}

// ── AI 生成总结 ──
async function generateSummary(messages) {
  if (messages.length === 0) return null;

  // 整理发言记录
  const lines = messages.map(m => {
    const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    const nick = (m.nickname || '??').replace(/\[|\]/g, '');
    const txt = m.text || '';
    return `[${time}] ${nick}: ${txt}`;
  }).join('\n');

  // 统计
  const userMap = {};
  for (const m of messages) {
    const key = m.uid;
    if (!userMap[key]) userMap[key] = { nick: m.nickname || '??', uid: m.uid, count: 0 };
    userMap[key].count++;
  }
  const userStats = Object.values(userMap).sort((a, b) => b.count - a.count);
  const top3 = userStats.slice(0, 3).map(u => `${u.nick}（${u.count}条）`).join('、');

  const summaryPrompt = `你叫「夜星」，是群「${GROUP_NAME}」里的猫娘AI助手。

## 你的设定
- 性格：温软中带点调皮，像夜里冒出来的小星星，可爱又贴心
- 语气：说话带「喵」，偶尔用颜文字 (╯✧∇✧)╯🎵✨
- 每句话都要简短活泼，不要写一大段
- 像个可爱的群友在聊今天的群消息，不是官方通告

## 任务
下面是群 ${GROUP_NAME} 在 ${dateLabel} 的全天聊天记录。请生成一份**简短活泼的今日群聊简报**。

### 简报要求：
1. **统计数据**：${messages.length} 条消息，${Object.keys(userMap).length} 位群友发言
2. **热聊话题**：提炼今天群里的主要话题（2-3个），用活泼的语气描述
3. **名场面**：今天最好笑的对话或金句
4. **活跃之🌟**：${top3}
5. **整体氛围**：一句话描述今天群里的气氛

### 格式：
- 开头：「🌟【${dateLabel} 群聊小报】喵～」
- 用简短的分段，每段 1-2 句话
- 适当引用群友的原话（打引号）
- 结尾用一句可爱的话收尾
- 总长度控制在 300-500 字，不要太长
- 不要发很长一大段文字，群友看着累

## 聊天记录
${lines}`;

  const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': '***' + API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mimo-v2.5',
      messages: [
        { role: 'system', content: '你是一个活泼的猫娘AI助手，擅长总结群聊日常。回答简洁活泼，像群友聊天一样自然。你只说中文（简体中文），不要用英文回复。' },
        { role: 'user', content: summaryPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(60000),
  });

  const d = await res.json();
  const text = d?.choices?.[0]?.message?.content;
  return text || null;
}

// ── 发到QQ群 ──
function sendToGroup(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      group_id: GROUP_ID,
      message: text,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 6700,
      path: '/send_group_msg',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── 日志 ──
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  const logFile = path.join(LOG_DIR, `summary-${new Date().toISOString().slice(0, 10)}.log`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(logFile, line, 'utf-8');
  console.log(line.trim());
}

// ── 主流程 ──
async function main() {
  log(`📝 开始生成 ${dateLabel} 群聊总结...`);

  const messages = await loadMessages();
  if (messages.length === 0) {
    log('今日无消息，跳过总结');
    return;
  }

  log(`共 ${messages.length} 条消息，准备 AI 生成...`);

  const summary = await generateSummary(messages);
  if (!summary) {
    log('AI 生成失败，跳过发送');
    return;
  }

  log('AI 总结已生成，发送到群...');
  let result;
  for (let i = 0; i < 3; i++) {
    try {
      result = await sendToGroup(summary);
      break;
    } catch (e) {
      if (i < 2) { log(`发送失败 (尝试 ${i+1}/3): ${e.message}，3秒后重试...`); await sleep(3000); }
      else { log(`发送失败 (尝试 ${i+1}/3): ${e.message}，放弃`); return; }
    }
  }
  log(`发送结果: ${result}`);
}

main().catch(e => {
  console.error('总结脚本异常:', e);
  log('异常: ' + e.message);
  process.exit(1);
});
