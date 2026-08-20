// bridge/storage.mjs — 用户记忆 + 群聊日志持久化
import fs from 'node:fs';
import { CFG } from './config.mjs';
import { logE } from './logger.mjs';

// ── 全局状态 ──
export let users = {};
export let groupChats = {};
let _usersNeedTimestampRepair = false;
let _groupChatsNeedTimestampRepair = false;

try {
  const raw = fs.readFileSync(CFG.memoryFile, 'utf-8');
  users = JSON.parse(raw);
  if (typeof users !== 'object' || Array.isArray(users)) users = {};
  _usersNeedTimestampRepair = repairUserTimestamps(users);
} catch { users = {}; }

try {
  const raw = fs.readFileSync(CFG.chatLogFile, 'utf-8');
  groupChats = JSON.parse(raw);
  if (typeof groupChats !== 'object' || Array.isArray(groupChats)) groupChats = {};
  _groupChatsNeedTimestampRepair = repairGroupChatTimestamps(groupChats);
} catch { groupChats = {}; }

// ── 防抖存档（v17: 异步批量，避免每条消息都同步写盘）──
let _saveUsersDirty = _usersNeedTimestampRepair;
let _saveUsersTimer = null;
let _saveGroupChatsDirty = _groupChatsNeedTimestampRepair;
let _saveGroupChatsTimer = null;
const SAVE_DEBOUNCE_MS = 5000;
const _saveInProgress = { users: false, chats: false };

export function saveUsers() {
  _saveUsersDirty = true;
  if (_saveUsersTimer) return;
  _saveUsersTimer = setTimeout(async () => {
    _saveUsersTimer = null;
    if (!_saveUsersDirty) return;
    if (_saveInProgress.users) {
      saveUsers();
      return;
    }
    _saveUsersDirty = false;
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
  _saveUsersTimer.unref?.();
}

export function saveGroupChats() {
  _saveGroupChatsDirty = true;
  if (_saveGroupChatsTimer) return;
  _saveGroupChatsTimer = setTimeout(async () => {
    _saveGroupChatsTimer = null;
    if (!_saveGroupChatsDirty) return;
    if (_saveInProgress.chats) {
      saveGroupChats();
      return;
    }
    _saveGroupChatsDirty = false;
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
  _saveGroupChatsTimer.unref?.();
}

// 立即存档（进程退出前调用）
export function flushSavesSync() {
  if (_saveUsersTimer) {
    clearTimeout(_saveUsersTimer);
    _saveUsersTimer = null;
  }
  if (_saveGroupChatsTimer) {
    clearTimeout(_saveGroupChatsTimer);
    _saveGroupChatsTimer = null;
  }
  if (_saveUsersDirty) {
    try {
      const tmp = CFG.memoryFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
      fs.renameSync(tmp, CFG.memoryFile);
      _saveUsersDirty = false;
    } catch (e) {
      console.error('[flush] users save failed:', e.message);
    }
  }
  if (_saveGroupChatsDirty) {
    try {
      const tmp = CFG.chatLogFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(groupChats, null, 2), 'utf-8');
      fs.renameSync(tmp, CFG.chatLogFile);
      _saveGroupChatsDirty = false;
    } catch (e) {
      console.error('[flush] chats save failed:', e.message);
    }
  }
}

if (_saveUsersDirty) saveUsers();
if (_saveGroupChatsDirty) saveGroupChats();

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

export function logGroupMsg(group_id, nickname, text, uid, role, imageUrls, meta = {}) {
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
  const mentions = sanitizeMentions(meta.mentions);
  if (mentions.length) entry.mentions = mentions;
  appendMessageMetadata(entry, meta);
  groupChats[gid].push(entry);
  if (groupChats[gid].length > 2000) groupChats[gid] = groupChats[gid].slice(-2000);
  saveGroupChats();

  const u = getUser(uid, nickname);
  const userChat = {
    group: gid,
    nickname: nickname || 'unknown',
    text: typeof text === 'string' ? text.slice(0, 300) : JSON.stringify(text).slice(0, 300),
    ts: Date.now(),
  };
  if (mentions.length) userChat.mentions = mentions;
  appendMessageMetadata(userChat, meta);
  u.chats.push(userChat);
  if (u.chats.length > 200) u.chats = u.chats.slice(-200);
  saveUsers();
}

function appendMessageMetadata(target, meta) {
  const messageId = normalizeMetadataId(meta.messageId);
  const replyToMessageId = normalizeMetadataId(meta.replyToMessageId);
  const turnId = normalizeMetadataId(meta.turnId);
  if (messageId) target.messageId = messageId;
  if (replyToMessageId) target.replyToMessageId = replyToMessageId;
  if (turnId) target.turnId = turnId;
}

function normalizeMetadataId(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, 80);
}

function sanitizeMentions(mentions) {
  if (!Array.isArray(mentions)) return [];
  return mentions
    .slice(0, 8)
    .map(function(item) {
      const qq = String(item?.qq || '').trim();
      if (!qq) return null;
      return {
        qq,
        isBot: Boolean(item.isBot),
        isAll: Boolean(item.isAll),
      };
    })
    .filter(Boolean);
}

function repairUserTimestamps(store, now = Date.now()) {
  let changed = false;
  for (const user of Object.values(store || {})) {
    if (!user || typeof user !== 'object') continue;
    changed = repairChatList(user.chats, now) || changed;
    if (isFarFuture(user.profileGeneratedAt, now)) {
      user.profileGeneratedAt = 0;
      changed = true;
    }
    if (isFarFuture(Date.parse(user.firstSeen), now)) {
      user.firstSeen = new Date(now).toISOString();
      changed = true;
    }
    for (const comment of Object.values(user.relationshipComments || {})) {
      if (isFarFuture(comment?.generatedAt, now)) {
        comment.generatedAt = 0;
        changed = true;
      }
    }
  }
  return changed;
}

function repairGroupChatTimestamps(store, now = Date.now()) {
  let changed = false;
  for (const chats of Object.values(store || {})) {
    changed = repairChatList(chats, now) || changed;
  }
  return changed;
}

function repairChatList(chats, now) {
  if (!Array.isArray(chats)) return false;
  let changed = false;
  for (const chat of chats) {
    if (!isFarFuture(chat?.ts, now)) continue;
    chat.ts = now;
    changed = true;
  }
  return changed;
}

function isFarFuture(timestamp, now) {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > Number(now) + 5 * 60 * 1000;
}
