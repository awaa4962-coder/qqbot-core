// bridge/napcat.mjs — OneBot v11 API 客户端（消息解析、发送、文件处理）
import { CFG } from './config.mjs';
import { logE } from './logger.mjs';
import { normalizeMsg, cleanText } from './context/messages.mjs';
import { fetchSafeText, validateSafeUrl } from './safe-url.mjs';
import {
  normalizeOutboundText,
  isOutboundPayloadSuccessful,
  sendGroupMessagePayload,
  sendPrivateMessagePayload,
  sendTextToGroup,
  sendTextToPrivate,
  splitLongText,
} from './outbound-message.mjs';

export function getImages(msg) {
  return getImageSegments(msg).map(function(item) { return item.url; });
}

export function getImageSegments(msg) {
  return normalizeMsg(msg)
    .filter(function(m) { return m.type === 'image' || m.type === 'flash'; })
    .map(normalizeImageSegment)
    .filter(function(item) { return item.url; });
}

function normalizeImageSegment(message) {
  const data = message.data || {};
  return {
    type: message.type,
    subType: Number(firstDefined(data.sub_type, data.subType, 0)),
    isFlash: [message.type === 'flash', data.flash === true, data.is_flash === true].some(Boolean),
    url: firstText(data.url, data.file),
    file: firstText(data.file),
    summary: firstText(data.summary),
    fileSize: Number(firstDefined(data.file_size, data.fileSize, 0)),
  };
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function firstText(...values) {
  return String(values.find(value => value) || '');
}

function extractFileFromSegment(segment) {
  if (segment.type === 'file' && segment.data) return segment.data;
  if (segment.type !== 'json' || !segment.data?.data) return null;

  try {
    const payload = JSON.parse(segment.data.data);
    const detail = payload?.app === 'com.tencent.miniapp_01' ? payload?.meta?.detail_1 : null;
    if (detail?.qqdocurl) return { name: detail.title || 'file', url: detail.qqdocurl };
  } catch {}
  return null;
}

function extractFileFromRawMessage(msg) {
  const text = typeof msg === 'string' ? msg : (JSON.stringify(msg) || '');
  const cqMatch = text.match(/\[CQ:file,[^\]]*file=([^,\]]+)[^\]]*\]/);
  return cqMatch ? { name: cqMatch[1], url: cqMatch[1] } : null;
}

function collectSegmentFiles(items) {
  const files = [];
  for (const item of items) {
    const file = extractFileFromSegment(item);
    if (file) files.push(file);
  }
  return files;
}

export function getFiles(msg) {
  const files = collectSegmentFiles(normalizeMsg(msg));
  const rawFile = extractFileFromRawMessage(msg);
  if (rawFile) files.push(rawFile);
  return files;
}

export function describeFiles(files) {
  if (!files.length) return '';
  return files.map(function(f) { return '[文件: ' + (f.name || 'unknown') + ']'; }).join(' ');
}

// ── fetchFileContent 拆分子函数 ──

const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'sql', 'csv', 'tsv', 'log', 'diff', 'patch', 'vim', 'lua', 'pl', 'pm',
  'r', 'dart', 'scala', 'clj', 'cljs', 'edn',
  'properties', 'gradle', 'lock',
]);

function validateFileUrl(url) {
  const result = validateSafeUrl(url);
  if (result.ok) return null;
  if (result.reason === 'invalid_url') return '无效URL';
  if (result.reason === 'unsupported_protocol') return '不支持协议';
  return '内网地址已拒绝';
}

function detectFileType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!TEXT_EXTS.has(ext)) return null; // null = 二进制
  return ext;
}

async function fetchWithTimeout(url, timeoutMs) {
  const text = await fetchSafeText(url, { timeoutMs, maxBytes: 10000 });
  if (text === null) throw new Error('URL blocked or download failed');
  return text;
}

function trimFileContent(txt, maxBytes) {
  if (txt.length <= maxBytes) return txt;
  return txt.slice(0, maxBytes) + '\n... [截断 ' + txt.length + '字符]';
}

export async function fetchFileContent(fileData) {
  if (!fileData) return '';
  const name = fileData.name || '';
  const url = fileData.url || fileData.file || '';

  if (!detectFileType(name)) return '[文件: ' + name + ' (二进制)]';
  if (!url) return '';

  const urlErr = validateFileUrl(url);
  if (urlErr) return '[文件: ' + name + ' (' + urlErr + ')]';

  try {
    const txt = await fetchWithTimeout(url, 8000);
    return trimFileContent(txt, 10000);
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

export { normalizeOutboundText, splitLongText };

export async function sendLongGroupMsg(groupId, text, replyTo) {
  return sendTextToGroup({ groupId, text, replyTo });
}

export async function sendLongPrivateMsg(userId, text) {
  return sendTextToPrivate({ userId, text });
}

export async function sendMsg(group_id, message, replyTo) {
  if (typeof message === 'string') return sendLongGroupMsg(group_id, message, replyTo);
  const msgArr = Array.isArray(message) ? [...message] : message;
  if (!msgArr?.length) return null;
  const payload = { group_id: group_id, message: msgArr };
  if (replyTo) payload.message.unshift({ type: 'reply', data: { id: replyTo } });
  return sendGroupMessagePayload(payload, 'sendMsg');
}

export async function sendPrivateMsg(user_id, message) {
  if (typeof message === 'string') return sendLongPrivateMsg(user_id, message);
  const msgArr = Array.isArray(message) ? [...message] : message;
  if (!msgArr?.length) return null;
  return sendPrivateMessagePayload({ user_id: user_id, message: msgArr }, 'sendPrivateMsg');
}

export async function uploadGroupFile(groupId, filePath, name) {
  try {
    const r = await fetch(CFG.napcatApi + '/upload_group_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        group_id: groupId,
        file: filePath,
        name: name,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    return d;
  } catch (e) {
    logE('uploadGroupFile error:', e.message);
    return null;
  }
}

export async function uploadPrivateFile(userId, filePath, name) {
  try {
    const r = await fetch(CFG.napcatApi + '/upload_private_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        user_id: userId,
        file: filePath,
        name: name,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    return d;
  } catch (e) {
    logE('uploadPrivateFile error:', e.message);
    return null;
  }
}

export async function getGroupMemberInfo(groupId, userId) {
  const url = CFG.napcatApi +
    '/get_group_member_info?group_id=' + encodeURIComponent(groupId) +
    '&user_id=' + encodeURIComponent(userId) +
    '&no_cache=false';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d?.status === 'ok' || d?.retcode === 0) return d.data || null;
  } catch (e) {
    logE('getGroupMemberInfo error:', e.message);
  }
  return null;
}

export async function sendMsgWithImage(groupId, text, imageUrl, options = {}) {
  if (!imageUrl) return sendMsg(groupId, text);
  const imageData = { file: imageUrl };
  if (options.flash === true) imageData.type = 'flash';
  const chunks = splitLongText(text);
  if (!chunks.length) {
    return sendGroupMessagePayload({
      group_id: groupId,
      message: [{ type: 'image', data: imageData }],
    }, 'sendMsgWithImage');
  }
  try {
    const firstPayload = {
      group_id: groupId,
      message: [
        { type: 'image', data: imageData },
        { type: 'text', data: { text: chunks[0] } },
      ],
    };
    const results = [await sendGroupMessagePayload(firstPayload, 'sendMsgWithImage')];
    if (!isOutboundPayloadSuccessful(results[0])) return results[0];
    for (let i = 1; i < chunks.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const result = await sendGroupMessagePayload({
        group_id: groupId,
        message: [{ type: 'text', data: { text: chunks[i] } }],
      }, 'sendMsgWithImage');
      results.push(result);
      if (!isOutboundPayloadSuccessful(result)) break;
    }
    return results.length <= 1 ? results[0] : results;
  } catch (e) {
    logE('sendMsgWithImage error:', e.message);
    return sendMsg(groupId, text);
  }
}
