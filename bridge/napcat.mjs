// bridge/napcat.mjs — OneBot v11 API 客户端（消息解析、发送、文件处理）
import http from 'node:http';
import { CFG } from './config.mjs';
import { log, logE } from './logger.mjs';
import { normalizeMsg, cleanText } from './context.mjs';

export function getImages(msg) {
  return normalizeMsg(msg).filter(function(m) { return m.type === 'image' || m.type === 'flash'; }).map(function(m) { return m.data?.url || m.data?.file || ''; }).filter(Boolean);
}

export function getFiles(msg) {
  const items = normalizeMsg(msg);
  const files = [];
  for (const m of items) {
    if (m.type === 'file' && m.data) files.push(m.data);
    else if (m.type === 'json' && m.data?.data) {
      try {
        const p = JSON.parse(m.data.data);
        if (p?.app === 'com.tencent.miniapp_01' && p?.meta?.detail_1?.qqdocurl) {
          files.push({ name: p.meta.detail_1.title || 'file', url: p.meta.detail_1.qqdocurl });
        }
      } catch {}
    }
  }
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const cqMatch = text.match(/\[CQ:file,[^\]]*file=([^,\]]+)[^\]]*\]/);
  if (cqMatch) {
    files.push({ name: cqMatch[1], url: cqMatch[1] });
  }
  return files;
}

export function describeFiles(files) {
  if (!files.length) return '';
  return files.map(function(f) { return '[文件: ' + (f.name || 'unknown') + ']'; }).join(' ');
}

export async function fetchFileContent(fileData) {
  if (!fileData) return '';
  const name = fileData.name || '';
  const url = fileData.url || fileData.file || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const textExts = new Set([
    'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
    'css', 'scss', 'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
    'sql', 'csv', 'tsv', 'log', 'diff', 'patch', 'vim', 'lua', 'pl', 'pm',
    'r', 'dart', 'scala', 'clj', 'cljs', 'edn',
    'properties', 'gradle', 'lock',
  ]);
  if (!textExts.has(ext)) return '[文件: ' + name + ' (二进制)]';
  if (!url) return '';
  // SSRF 防护：只允许 http/https，拒绝内网地址
  let parsed;
  try { parsed = new URL(url); } catch { return '[文件: ' + name + ' (无效URL)]'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '[文件: ' + name + ' (不支持协议)]';
  const hostname = parsed.hostname;
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' ||
      hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') || hostname.startsWith('172.17.') ||
      hostname.startsWith('172.18.') || hostname.startsWith('172.19.') ||
      hostname.startsWith('172.20.') || hostname.startsWith('172.21.') ||
      hostname.startsWith('172.22.') || hostname.startsWith('172.23.') ||
      hostname.startsWith('172.24.') || hostname.startsWith('172.25.') ||
      hostname.startsWith('172.26.') || hostname.startsWith('172.27.') ||
      hostname.startsWith('172.28.') || hostname.startsWith('172.29.') ||
      hostname.startsWith('172.30.') || hostname.startsWith('172.31.')) {
    return '[文件: ' + name + ' (内网地址已拒绝)]';
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    const maxBytes = 10000;
    if (txt.length > maxBytes) return txt.slice(0, maxBytes) + '\n... [截断 ' + txt.length + '字符]';
    return txt;
  } catch (e) {
    return '[文件: ' + name + ' (读取失败: ' + e.message + ')]';
  }
}

export function getReplyData(msg) {
  const found = normalizeMsg(msg).find(function(m) { return m.type === 'reply'; });
  return found ? found.data : null;
}

export async function fetchReplyData(replyData) {
  if (!replyData) return { text: '', images: [] };
  const msgId = replyData.id;
  if (!msgId) return { text: '', images: [] };
  try {
    const r = await fetch(CFG.napcatApi + '/get_msg?message_id=' + encodeURIComponent(msgId));
    const d = await r.json();
    if (d?.status === 'ok' || d?.retcode === 0) {
      const msg = d.data;
      const text = cleanText(msg.message);
      const images = getImages(msg.message);
      const files = getFiles(msg.message);
      let res = text;
      if (images.length) res += ' [图片' + images.length + '张]';
      if (files.length) res += ' ' + describeFiles(files);
      return { text: res, images: images };
    }
  } catch {}
  return { text: '', images: [] };
}

export async function sendMsg(group_id, message, replyTo) {
  const msgArr = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message;
  const payload = { group_id: group_id, message: msgArr };
  if (replyTo) payload.message.unshift({ type: 'reply', data: { id: replyTo } });
  try {
    const r = await fetch(CFG.napcatApi + '/send_group_msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    log('sendMsg:', d?.status || d?.retcode || 'ok');
    return d;
  } catch (e) {
    logE('sendMsg error:', e.message);
    return null;
  }
}

export async function sendPrivateMsg(user_id, message) {
  const msgArr = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message;
  try {
    const r = await fetch(CFG.napcatApi + '/send_private_msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ user_id: user_id, message: msgArr }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    log('sendPrivateMsg:', d?.status || d?.retcode || 'ok');
    return d;
  } catch (e) {
    logE('sendPrivateMsg error:', e.message);
    return null;
  }
}

export async function sendMsgWithImage(groupId, text, imageUrl) {
  if (!imageUrl) return sendMsg(groupId, text);
  try {
    const payload = {
      group_id: groupId,
      message: [
        { type: 'image', data: { file: imageUrl, type: 'flash' } },
        { type: 'text', data: { text: text } },
      ],
    };
    const r = await fetch(CFG.napcatApi + '/send_group_msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    log('sendMsgWithImage:', d?.status || d?.retcode || 'ok');
    return d;
  } catch (e) {
    logE('sendMsgWithImage error:', e.message);
    return sendMsg(groupId, text);
  }
}
