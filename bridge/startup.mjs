// bridge/startup.mjs — 入口（HTTP Server + WebSocket Server + 启动逻辑）
import http from "node:http";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import { CFG } from "./config.mjs";
import { log, logE, cleanupLogger, getStormStatus } from "./logger.mjs";
import { stopChatRuns } from "./cognition/chat-run.mjs";
import { users, groupChats, flushSavesSync } from "./storage.mjs";
import { sendMsg, getImages, getFiles, getReplyData } from "./napcat.mjs";
import { processEvent } from "./reply.mjs";
import { getAdmissionStatus } from "./event-admission.mjs";
import { createOneBotLinkManager } from "./onebot-link.mjs";
import { getPipelineStatus } from "./pipeline-state.mjs";
import { createDailySummaryCatchUp } from "./group-summary/catchup.mjs";
import { createRuntimeMaintenance } from "./runtime-maintenance.mjs";
import {
  getCachedNapCatReadiness,
  refreshNapCatReadiness,
} from "./napcat-readiness.mjs";
import { generateProfile } from "./profile.mjs";
import { cleanText } from "./context/messages.mjs";
import { VERSION } from "./version.mjs";
import { refreshJmRuntimeHealth } from "./jm-provider.mjs";
import { cleanupExpiredMemoryProfiles, flushMemoryProfilesSync } from "./memory-profile.mjs";
import { flushImageContextCacheSync } from "./knowledge/memes/image-context.mjs";
import { handleAdminApiRequest } from "./admin-api/index.mjs";
import { isAuthorizedAdminRequest } from "./admin-api/auth.mjs";
import { isAllowedBrowserOrigin, isAuthorizedOneBotRequest, readRequestJson } from "./http-ingress.mjs";
import { handleWebConsoleRequest } from "./web-console.mjs";
import {
  initializeStickerSystem,
  shutdownStickerSystem,
} from "./features/stickers/index.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 请求体上限

// ── HTTP Server ──
function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin && isAllowedBrowserOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
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
    pipeline: getPipelineStatus(),
    napcat: getCachedNapCatReadiness(),
  });
}

async function handleReady(res) {
  const onebot = oneBotLink.status();
  const napcat = await refreshNapCatReadiness();
  const ready = onebot.ready && napcat.ready;
  sendJson(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'not_ready',
    onebot,
    napcat,
    admission: getAdmissionStatus(),
    pipeline: getPipelineStatus(),
  });
}

async function handleReply(req, res) {
  try {
    const data = await readRequestJson(req);
    const { group_id, message, reply_to } = data;
    if (!group_id || !message) {
      sendJson(res, 400, { error: 'group_id and message required' });
      return;
    }
    const result = await sendMsg(group_id, message, reply_to);
    sendJson(res, 200, { status: 'sent', result: result });
  } catch (e) {
    sendRequestError(req, res, e);
  }
}

async function handleInspectMsg(req, res) {
  try {
    const data = await readRequestJson(req);
    sendJson(res, 200, {
      text: cleanText(data.message),
      images: getImages(data.message),
      files: getFiles(data.message),
      reply: getReplyData(data.message),
      raw: data.message,
    }, 2);
  } catch (e) {
    sendRequestError(req, res, e);
  }
}

async function handleEventPost(req, res) {
  try {
    const ev = await readRequestJson(req);
    const outcome = await processEvent(ev);
    sendJson(res, 200, { status: outcome.ok ? 'processed' : 'ignored', outcome });
  } catch (e) {
    logE('processEvent error:', e.statusCode || 'processing_failed');
    sendRequestError(req, res, e);
  }
}

async function routeHttpRequest(req, res, pathname) {
  const url = new URL(req.url, 'http://localhost');
  if (await handleWebConsoleRequest(req, res, { pathname })) return;
  if (await handleAdminApiRequest(req, res, { pathname, url, sendJson })) return;
  if (!authorizeHttpAction(req, res, pathname)) return;
  if (await handlePublicGet(req, res, pathname)) return;
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

async function handlePublicGet(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/changelog') {
    handleChangelog(res);
    return true;
  }
  if (req.method === 'GET' && pathname === '/health') {
    handleHealth(res);
    return true;
  }
  if (req.method === 'GET' && pathname === '/ready') {
    await handleReady(res);
    return true;
  }
  return false;
}

function authorizeHttpAction(req, res, pathname) {
  if (req.method !== 'POST') return true;
  if (['/reply', '/inspect_msg'].includes(pathname) && !isAuthorizedAdminRequest(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return false;
  }
  if (pathname === '/' && !isAuthorizedOneBotRequest(req, CFG.napcatAccessToken)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

const server = http.createServer(async function(req, res) {
  if (!isAllowedBrowserOrigin(req.headers.origin)) { sendJson(res, 403, { error: 'origin forbidden' }); return; }
  applyCors(req, res);
  if (handleOptions(req, res)) return;

  try {
    const url = new URL(req.url, 'http://localhost');
    await routeHttpRequest(req, res, url.pathname);
  } catch (error) { sendRequestError(req, res, error); }
});

function sendRequestError(req, res, error) {
  if (res.headersSent || res.destroyed) return;
  res.setHeader('Connection', 'close');
  const code = error.statusCode || 500;
  res.once('finish', () => req.destroy());
  sendJson(res, code, { error: error.statusCode ? error.message : 'request failed' });
}

server.on('error', function(error) {
  logE('HTTP server error:', error.message);
  if (error.code === 'EADDRINUSE') {
    cleanupLogger();
    process.exit(1);
  }
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
server.on('upgrade', (req, socket, head) => {
  if (!isAuthorizedOneBotRequest(req, CFG.napcatAccessToken)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
const oneBotLink = createOneBotLinkManager({ processor: processEvent, log, logError: logE });
const dailySummaryCatchUp = createDailySummaryCatchUp({
  isReady: () => oneBotLink.status().ready && getCachedNapCatReadiness().ready,
  log: (event, detail) => log('summary catch-up', event, JSON.stringify(detail || {})),
});
const runtimeMaintenance = createRuntimeMaintenance({ log, logError: logE });

wss.on('connection', function(ws) {
  oneBotLink.attach(ws);
  refreshNapCatReadiness({ force: true }).catch(error => logE('NapCat readiness probe failed:', error.message));
});

// ── Start ──
// 进程退出前强制存档
function flushRuntimeState() {
  dailySummaryCatchUp.stop();
  runtimeMaintenance.stop();
  shutdownStickerSystem();
  flushSavesSync();
  flushMemoryProfilesSync();
  flushImageContextCacheSync();
  cleanupLogger();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChatRuns();
  log('shutdown requested:', signal);
  await oneBotLink.stop({ drainMs: 10000 });
  await new Promise(resolve => server.close(resolve));
  flushRuntimeState();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('beforeExit', flushRuntimeState);
process.once('qqfriend:fatal', () => {
  // A corrupted process must not advertise healthy; persist only synchronous state before exit.
  try { flushRuntimeState(); } finally { process.exit(1); }
});

server.listen(CFG.listenPort, CFG.listenHost, function() {
  log('NapCat Bridge v' + VERSION + ' listening on http://' + CFG.listenHost + ':' + CFG.listenPort);
  log('WebSocket server ready');
  log('Self UIN:', CFG.selfUin);
  log('Whitelist groups:', CFG.groupWhitelist.join(', '));
  log('Users loaded:', Object.keys(users).length);
  log('Group chats loaded:', Object.keys(groupChats).length);
  runtimeMaintenance.start();
  refreshJmRuntimeHealth().then(status => {
    log('jm runtime health:', status.health, status.reason);
  }).catch(error => logE('jm runtime health failed:', error.message));
  cleanupExpiredMemoryProfiles();
  const stickerStatus = initializeStickerSystem();
  log('sticker system ready:', JSON.stringify(stickerStatus));
  dailySummaryCatchUp.start();

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
