// bridge/storage.mjs — 用户记忆 + 群聊日志持久化
import fs from 'node:fs';
import { CFG } from './config.mjs';
import { logE } from './logger.mjs';

// ── 全局状态 ──
export let users = {};
export let groupChats = {};

try {
  const raw = fs.readFileSync(CFG.memoryFile, 'utf-8');
  users = JSON.parse(raw);
  if (typeof users !== 'object' || Array.isArray(users)) users = {};
} catch { users = {}; }

try {
  const raw = fs.readFileSync(CFG.chatLogFile, 'utf-8');
  groupChats = JSON.parse(raw);
  if (typeof groupChats !== 'object' || Array.isArray(groupChats)) groupChats = {};
} catch { groupChats = {}; }

// ── 防抖存档（v17: 异步批量，避免每条消息都同步写盘）──
let _saveUsersDirty = false;
let _saveUsersTimer = null;
let _saveGroupChatsDirty = false;
let _saveGroupChatsTimer = null;
const SAVE_DEBOUNCE_MS = 30000;
let _saveInProgress = { users: false, chats: false };

export function saveUsers() {
  _saveUsersDirty = true;
  if (_saveUsersTimer) return;
  _saveUsersTimer = setTimeout(async () => {
    _saveUsersTimer = null;
    if (!_saveUsersDirty) return;
    _saveUsersDirty = false;
    if (_saveInProgress.users) return;
    _saveInProgress.users = true;
    try {
      const tmp = CFG.memoryFile + '.tmp.' + process.pid;
      await fs.promises.writeFile(tmp, JSON.stringify(users, null, 2), 'utf-8');
      await fs.promises.rename(tmp, CFG.memoryFile);
    } catch (e) {
      logE('saveUsers async write failed:', e.message);
      _saveUsersDirty = true;
    }
    _saveInProgress.users = false;
  }, SAVE_DEBOUNCE_MS);
}

export function saveGroupChats() {
  _saveGroupChatsDirty = true;
  if (_saveGroupChatsTimer) return;
  _saveGroupChatsTimer = setTimeout(async () => {
    _saveGroupChatsTimer = null;
    if (!_saveGroupChatsDirty) return;
    _saveGroupChatsDirty = false;
    if (_saveInProgress.chats) return;
    _saveInProgress.chats = true;
    try {
      const tmp = CFG.chatLogFile + '.tmp.' + process.pid;
      await fs.promises.writeFile(tmp, JSON.stringify(groupChats, null, 2), 'utf-8');
      await fs.promises.rename(tmp, CFG.chatLogFile);
    } catch (e) {
      logE('saveGroupChats async write failed:', e.message);
      _saveGroupChatsDirty = true;
    }
    _saveInProgress.chats = false;
  }, SAVE_DEBOUNCE_MS);
}

// 立即存档（进程退出前调用）
export function flushSavesSync() {
  if (_saveUsersDirty) {
    try {
      const tmp = CFG.memoryFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
      fs.renameSync(tmp, CFG.memoryFile);
    } catch (e) {
      console.error('[flush] users save failed:', e.message);
    }
  }
  if (_saveGroupChatsDirty) {
    try {
      const tmp = CFG.chatLogFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(groupChats, null, 2), 'utf-8');
      fs.renameSync(tmp, CFG.chatLogFile);
    } catch (e) {
      console.error('[flush] chats save failed:', e.message);
    }
  }
}

export function getUser(uid, nickname) {
  if (!users[uid]) {
    users[uid] = { uid, nicknames: [], firstSeen: new Date().toISOString(), chats: [], description: '' };
  }
  const u = users[uid];
  if (!u.chats) u.chats = [];
  if (!u.nicknames) u.nicknames = [];
  if (nickname && !u.nicknames.includes(nickname)) {
    u.nicknames.push(nickname);
    if (u.nicknames.length > 20) u.nicknames = u.nicknames.slice(-20);
    u.alias = nickname;
    saveUsers();
  }
  return u;
}

export function logGroupMsg(group_id, nickname, text, uid, role, imageUrls) {
  const gid = String(group_id);
  if (!groupChats[gid]) groupChats[gid] = [];
  const entry = {
    uid: String(uid),
    nickname: nickname || 'unknown',
    text: typeof text === 'string' ? text.slice(0, 500) : JSON.stringify(text).slice(0, 500),
    role: role || 'member',
    ts: Date.now(),
  };
  if (imageUrls?.length) entry.imageUrls = imageUrls;
  groupChats[gid].push(entry);
  if (groupChats[gid].length > 2000) groupChats[gid] = groupChats[gid].slice(-2000);
  saveGroupChats();

  const u = getUser(uid, nickname);
  u.chats.push({
    group: gid,
    nickname: nickname || 'unknown',
    text: typeof text === 'string' ? text.slice(0, 300) : JSON.stringify(text).slice(0, 300),
    ts: Date.now(),
  });
  if (u.chats.length > 200) u.chats = u.chats.slice(-200);
}
