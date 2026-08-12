// bridge/startup.mjs — 入口（HTTP Server + WebSocket Server + 启动逻辑）
import http from "node:http";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import { CFG } from "./config.mjs";
import { log, logE, cleanupLogger, getStormStatus } from "./logger.mjs";
import { users, groupChats, flushSavesSync } from "./storage.mjs";
import { sendMsg, getImages, getFiles, getReplyData } from "./napcat.mjs";
import { processEvent } from "./reply.mjs";
import { generateProfile } from "./profile.mjs";
import { cleanText } from "./context/messages.mjs";
import { VERSION } from "./version.mjs";
import { cleanupExpiredJmTempDirs, refreshJmRuntimeHealth } from "./jm-provider.mjs";
import { cleanupExpiredMemoryProfiles, flushMemoryProfilesSync } from "./memory-profile.mjs";
import { flushImageContextCacheSync } from "./knowledge/memes/image-context.mjs";
import {
  flushMemeStoreSync,
  initializeMemeKnowledge,
  scheduleMemeTrendUpdates,
  stopMemeTrendUpdates,
} from "./knowledge/memes/index.mjs";
import { handleAdminApiRequest } from "./admin-api/index.mjs";
import {
  initializeStickerSystem,
  shutdownStickerSystem,
} from "./features/stickers/index.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 请求体上限

function _readBody(req, res) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', function(chunk) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', function() { resolve(body); });
  });
}

// ── HTTP Server ──
function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin && (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-QQFriend-Admin-Token');
}

function sendJson(res, statusCode, payload, spacing) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, spacing));
}

function sendMarkdown(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(content);
}

async function readJsonBody(req, res) {
  const body = await _readBody(req, res);
  return body ? JSON.parse(body) : null;
}

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function handleChangelog(res) {
  try {
    sendMarkdown(res, fs.readFileSync(CFG.changelogFile, 'utf-8'));
  } catch {
    sendJson(res, 500, { error: 'changelog not found' });
  }
}

function handleHealth(res) {
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    users: Object.keys(users).length,
    groups: Object.keys(groupChats).length,
    memory: process.memoryUsage().rss,
    storm: getStormStatus(),
  });
}

async function handleReply(req, res) {
  try {
    const data = await readJsonBody(req, res);
    if (!data) return;
    const { group_id, message, reply_to } = data;
    if (!group_id || !message) {
      sendJson(res, 400, { error: 'group_id and message required' });
      return;
    }
    const result = await sendMsg(group_id, message, reply_to);
    sendJson(res, 200, { status: 'sent', result: result });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleInspectMsg(req, res) {
  try {
    const data = await readJsonBody(req, res);
    if (!data) return;
    sendJson(res, 200, {
      text: cleanText(data.message),
      images: getImages(data.message),
      files: getFiles(data.message),
      reply: getReplyData(data.message),
      raw: data.message,
    }, 2);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleEventPost(req, res) {
  try {
    const ev = await readJsonBody(req, res);
    if (!ev) return;
    await processEvent(ev);
    sendJson(res, 200, { status: 'received' });
  } catch (e) {
    logE('processEvent error:', e.message);
    sendJson(res, 500, { error: e.message });
  }
}

async function routeHttpRequest(req, res, pathname) {
  const url = new URL(req.url, 'http://localhost');
  if (await handleAdminApiRequest(req, res, { pathname, url, sendJson })) return;
  if (req.method === 'GET' && pathname === '/changelog') {
    handleChangelog(res);
    return;
  }
  if (req.method === 'GET' && pathname === '/health') {
    handleHealth(res);
    return;
  }
  if (req.method === 'POST' && pathname === '/reply') {
    await handleReply(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/inspect_msg') {
    await handleInspectMsg(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/') {
    await handleEventPost(req, res);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async function(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;

  const url = new URL(req.url, 'http://localhost');
  await routeHttpRequest(req, res, url.pathname);
});

server.on('error', function(error) {
  logE('HTTP server error:', error.message);
  if (error.code === 'EADDRINUSE') {
    cleanupLogger();
    process.exit(1);
  }
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server: server });

// ── WebSocket 单连接管理：新连接优先，替换旧连接 ──
let _activeWs = null;

wss.on('connection', function(ws) {
  if (_activeWs && _activeWs.readyState === _activeWs.OPEN) {
    log('WebSocket new client connected, closing previous client');
    _activeWs.close(1000, 'replaced by new connection');
  }
  _activeWs = ws;
  log('WebSocket client connected');

  ws.on('message', function(data) {
    try {
      const ev = JSON.parse(data.toString());
      processEvent(ev).catch(function(e) { logE('WS processEvent error:', e.message); });
    } catch (e) {
      logE('WS parse error:', e.message);
    }
  });

  ws.on('close', function() {
    if (_activeWs === ws) _activeWs = null;
    log('WebSocket client disconnected');
  });
  ws.on('error', function(e) {
    if (_activeWs === ws) _activeWs = null;
    logE('WebSocket error:', e.message);
  });
});

// ── Start ──
// 进程退出前强制存档
function flushRuntimeState() {
  stopMemeTrendUpdates();
  shutdownStickerSystem();
  flushSavesSync();
  flushMemoryProfilesSync();
  flushImageContextCacheSync();
  flushMemeStoreSync();
  cleanupLogger();
}

process.on('SIGINT', () => { flushRuntimeState(); process.exit(0); });
process.on('SIGTERM', () => { flushRuntimeState(); process.exit(0); });
process.on('beforeExit', flushRuntimeState);

server.listen(CFG.listenPort, function() {
  log('NapCat Bridge v' + VERSION + ' listening on http://0.0.0.0:' + CFG.listenPort);
  log('WebSocket server ready');
  log('Self UIN:', CFG.selfUin);
  log('Whitelist groups:', CFG.groupWhitelist.join(', '));
  log('Users loaded:', Object.keys(users).length);
  log('Group chats loaded:', Object.keys(groupChats).length);
  cleanupExpiredJmTempDirs().catch(error => logE('jm expired temp cleanup failed:', error.message));
  refreshJmRuntimeHealth().then(status => {
    log('jm runtime health:', status.health, status.reason);
  }).catch(error => logE('jm runtime health failed:', error.message));
  cleanupExpiredMemoryProfiles();
  const memeDecay = initializeMemeKnowledge();
  log('meme knowledge ready:', JSON.stringify(memeDecay));
  const stickerStatus = initializeStickerSystem();
  log('sticker system ready:', JSON.stringify(stickerStatus));
  scheduleMemeTrendUpdates();

  // 每小时更新所有用户画像
  async function refreshAllProfiles() {
    const uids = Object.keys(users).filter(function(id) { return id !== String(CFG.selfUin) && !isNaN(Number(id)) && users[id]?.chats?.length >= 10; });
    if (!uids.length) return;
    log('profile refresh: scanning', uids.length, 'users...');
    let updated = 0;
    for (const uid of uids) {
      try {
        const desc = await generateProfile(uid);
        if (desc) updated++;
        await new Promise(function(r) { setTimeout(r, 500); }); // 限流
      } catch {}
    }
    log('profile refresh: updated', updated, '/', uids.length, 'users');
  }
  if (CFG.legacyProfileRefreshEnabled) {
    refreshAllProfiles().catch(function() {});
    setInterval(function() { refreshAllProfiles().catch(function() {}); }, 3600000);
  } else {
    log('legacy profile refresh disabled');
  }
});
