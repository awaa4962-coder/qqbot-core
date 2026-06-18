// bridge/profile.mjs — 用户画像生成
import { CFG } from "./config.mjs";
import { log } from "./logger.mjs";
import { users, saveUsers } from "./storage.mjs";
import { miMoContent } from "./thinking.mjs";

export async function generateProfile(uid) {
  const u = users[uid];
  if (!u) return '';
  const recent = u.chats.slice(-20);
  if (!recent.length) return '';

  const chatLog = recent.map(function(c) {
    return '[' + new Date(c.ts).toLocaleString('zh-CN') + '] 在' + c.group + '群说: ' + c.text;
  }).join('\n');

  const prompt = '根据以下聊天记录，用一句话概括这个人的性格、兴趣和说话特点（20-50字）：\n\n' + chatLog;

  try {
    const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CFG.mimoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        messages: [
          { role: 'system', content: '你是一个用户画像生成器。请根据聊天记录总结用户特点，简洁、准确。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 100,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    const desc = miMoContent(d?.choices?.[0]?.message);
    if (desc) {
      u.profile = desc.trim();
      saveUsers();
      return desc.trim();
    }
  } catch {}

  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CFG.dsKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是一个用户画像生成器。请根据聊天记录总结用户特点，简洁、准确。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 100,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    const desc = d?.choices?.[0]?.message?.content;
    if (desc) {
      u.profile = desc.trim();
      saveUsers();
      return desc.trim();
    }
  } catch {}
  return '';
}
