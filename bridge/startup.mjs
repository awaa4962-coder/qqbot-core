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
import { getLatestChangelog, cleanText } from "./context.mjs";

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
const server = http.createServer(async function(req, res) {
  // CORS: 仅允许本地访问
  const origin = req.headers.origin || '';
  if (origin && (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // GET /changelog
  if (req.method === 'GET' && pathname === '/changelog') {
    try {
      const cl = fs.readFileSync(CFG.changelogFile, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(cl);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'changelog not found' }));
    }
    return;
  }

  // GET /health
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      users: Object.keys(users).length,
      groups: Object.keys(groupChats).length,
      memory: process.memoryUsage().rss,
      storm: getStormStatus(),
    }));
    return;
  }

  // POST /reply
  if (req.method === 'POST' && pathname === '/reply') {
    const body = await _readBody(req, res);
    if (!body) return;
    try {
      const data = JSON.parse(body);
      const { group_id, message, reply_to } = data;
      if (!group_id || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'group_id and message required' }));
        return;
      }
      const result = await sendMsg(group_id, message, reply_to);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'sent', result: result }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /inspect_msg
  if (req.method === 'POST' && pathname === '/inspect_msg') {
    const body = await _readBody(req, res);
    if (!body) return;
    try {
      const data = JSON.parse(body);
      const inspected = {
        text: cleanText(data.message),
        images: getImages(data.message),
        files: getFiles(data.message),
        reply: getReplyData(data.message),
        raw: data.message,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(inspected, null, 2));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /
  if (req.method === 'POST' && pathname === '/') {
    const body = await _readBody(req, res);
    if (!body) return;
    try {
      const ev = JSON.parse(body);
      await processEvent(ev);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'received' }));
    } catch (e) {
      logE('processEvent error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server: server });

// ── 重连冷却：防止 NapCat 断连后疯狂重连连成死循环 ──
let _lastWsDisconnect = 0;
const WS_RECONNECT_COOLDOWN = 5000; // 断开后 5 秒内不接受新连接

wss.on('connection', function(ws) {
  const sinceDisconnect = Date.now() - _lastWsDisconnect;
  if (sinceDisconnect < WS_RECONNECT_COOLDOWN) {
    log('WebSocket reconnected too fast (' + sinceDisconnect + 'ms since last disconnect), closing');
    ws.close(1008, 'cooldown');
    return;
  }
  log('WebSocket client connected');

  ws.on('message', function(data) {
    try {
      const ev = JSON.parse(data.toString());
      processEvent(ev).catch(function(e) { logE('WS processEvent error:', e.message); });
    } catch (e) {
      logE('WS parse error:', e.message);
    }
  });

  ws.on('close', function() { _lastWsDisconnect = Date.now(); log('WebSocket client disconnected'); });
  ws.on('error', function(e) { _lastWsDisconnect = Date.now(); logE('WebSocket error:', e.message); });
});

// ── Start ──
// 进程退出前强制存档
process.on('SIGINT', () => { flushSavesSync(); cleanupLogger(); process.exit(0); });
process.on('SIGTERM', () => { flushSavesSync(); cleanupLogger(); process.exit(0); });
process.on('beforeExit', () => { flushSavesSync(); cleanupLogger(); });

server.listen(CFG.listenPort, function() {
  log('NapCat Bridge v1.1.0 listening on http://0.0.0.0:' + CFG.listenPort);
  log('WebSocket server ready');
  log('Self UIN:', CFG.selfUin);
  log('Whitelist groups:', CFG.groupWhitelist.join(', '));
  log('Users loaded:', Object.keys(users).length);
  log('Group chats loaded:', Object.keys(groupChats).length);

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
  refreshAllProfiles().catch(function() {});
  setInterval(function() { refreshAllProfiles().catch(function() {}); }, 3600000);
});

