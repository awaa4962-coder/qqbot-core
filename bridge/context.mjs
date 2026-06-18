// bridge/context.mjs — 上下文构建（消息格式化、历史截取、权重排序）+ changelog
import fs from 'node:fs';
import { CFG } from './config.mjs';
import { users, groupChats } from './storage.mjs';

export function getLatestChangelog() {
  try {
    const cl = fs.readFileSync(CFG.changelogFile, 'utf-8');
    const lines = cl.split('\n');
    let v15 = [];
    let found = false;
    for (const l of lines) {
      if (found && l.startsWith('## ')) break;
      if (l.startsWith('## v15')) { found = true; v15.push(l); continue; }
      if (found) v15.push(l);
    }
    return v15.join('\n').trim() || cl.slice(0, 500);
  } catch { return '更新日志暂无'; }
}

export function fmtMsg(m) {
  const nick = m.nickname || 'unknown';
  const text = typeof m.text === 'string' ? m.text : JSON.stringify(m.text);
  return { role: m.uid === String(CFG.selfUin) ? 'assistant' : 'user', content: nick + ': ' + text };
}

export function recentGroupChat(group_id, limit) {
  if (limit === undefined) limit = 30;
  const gid = String(group_id);
  const msgs = groupChats[gid] || [];
  const recent = msgs.slice(-limit);
  return recent.map(fmtMsg);
}

export function crossGroupCtx(uid, currentGroup) {
  const u = users[uid];
  if (!u || !u.chats) return [];
  const cg = String(currentGroup);
  const otherChats = u.chats.filter(function(c) { return c.group !== cg; }).slice(-5);
  return otherChats.map(function(c) {
    return { role: 'user', content: '[在' + c.group + '群] ' + (c.nickname || 'unknown') + ': ' + (typeof c.text === 'string' ? c.text : JSON.stringify(c.text)) };
  });
}

export function recentHistory(uid, limit) {
  const u = users[uid];
  if (!u || !u.chats) return [];
  if (limit === undefined) limit = 30;
  const msgs = u.chats.slice(-limit);
  return msgs.map(function(m) {
    return { role: 'user', content: '[在' + m.group + '群] ' + (m.nickname || 'unknown') + ': ' + (typeof m.text === 'string' ? m.text : JSON.stringify(m.text)) };
  });
}

export function recentHistoryWeighted(uid, currentGroup) {
  const u = users[uid];
  if (!u || !u.chats) return { history: [], mood: '' };
  const cg = String(currentGroup);
  const now = Date.now();
  const weighted = [];
  for (let i = u.chats.length - 1; i >= 0; i--) {
    const c = u.chats[i];
    if (String(c.group) !== cg) continue;
    const ageHours = (now - c.ts) / 3600000;
    if (ageHours > 12) break;
    let weight = 1;
    if (ageHours < 0.5) weight = 5;
    else if (ageHours < 1) weight = 4;
    else if (ageHours < 4) weight = 3;
    weighted.push({ msg: c, weight: weight });
  }
  weighted.sort(function(a, b) { return b.weight - a.weight; });
  const top = weighted.slice(0, 15);
  top.sort(function(a, b) { return a.msg.ts - b.msg.ts; });
  const history = top.map(function(m) {
    return { role: 'user', content: m.msg.nickname + ': ' + (typeof m.msg.text === 'string' ? m.msg.text : JSON.stringify(m.msg.text)) };
  });
  const gid = String(currentGroup);
  const recentInGroup = groupChats[gid] || [];
  const recentMsgs = recentInGroup.slice(-20);
  const speakers = new Set(recentMsgs.map(function(m) { return m.uid; }));
  let mood = '';
  if (speakers.size >= 5) mood = '（群聊氛围活跃，多人参与）';
  else if (speakers.size >= 3) mood = '（群聊氛围正常）';
  else mood = '（群聊比较安静）';
  return { history: history, mood: mood };
}

export function normalizeMsg(msg) {
  if (!msg) return [];
  if (Array.isArray(msg)) return msg;
  if (msg.type) return [msg];
  return [];
}

export function cleanText(msg) {
  return normalizeMsg(msg).filter(function(m) { return m.type === 'text'; }).map(function(m) { return m.data?.text || ''; }).join(' ').trim();
}
