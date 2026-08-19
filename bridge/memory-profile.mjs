// bridge/memory-profile.mjs - bounded, expiring profile summaries for context
import fs from "node:fs";
import path from "node:path";

import { CFG } from "./config.mjs";
import { logE } from "./logger.mjs";
import { MEMORY_TOPIC_RULES } from "./knowledge/topic-rules.mjs";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INTERJECTION_PREFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 30000;
const PROFILE_FILE = CFG.memoryProfileFile;

const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/i,
  /(?:api[_-]?key|token|secret|password|passwd|密码|密钥)\s*[:=]/i,
  /\b\d{15,18}[0-9x]\b/i,
  /\b1[3-9]\d{9}\b/,
];

export const memoryProfiles = loadProfiles();

let saveTimer = null;
let dirty = false;

function createRoot() {
  return {
    userProfiles: {},
    groupProfiles: {},
    userGroupProfiles: {},
  };
}

function loadProfiles() {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...createRoot(),
      ...parsed,
      userProfiles: parsed.userProfiles || {},
      groupProfiles: parsed.groupProfiles || {},
      userGroupProfiles: parsed.userGroupProfiles || {},
    };
  } catch {
    return createRoot();
  }
}

export function saveMemoryProfiles() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await fs.promises.mkdir(path.dirname(PROFILE_FILE), { recursive: true });
      const tmp = PROFILE_FILE + ".tmp." + process.pid;
      await fs.promises.writeFile(tmp, JSON.stringify(memoryProfiles, null, 2), "utf8");
      await fs.promises.rename(tmp, PROFILE_FILE);
    } catch (error) {
      dirty = true;
      logE("saveMemoryProfiles failed:", error.message);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function flushMemoryProfilesSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
    const tmp = PROFILE_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(memoryProfiles, null, 2), "utf8");
    fs.renameSync(tmp, PROFILE_FILE);
    dirty = false;
  } catch (error) {
    logE("flushMemoryProfiles failed:", error.message);
  }
}

export function isSensitiveMemoryText(text) {
  const value = String(text || "");
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(value));
}

export function observeMemoryEvent(event, options = {}) {
  const now = options.now || Date.now();
  const normalized = normalizeMemoryEvent(event);
  if (!normalized || isSensitiveMemoryText(normalized.text)) return null;

  const userProfile = updateUserProfile(normalized, now);
  const relatedProfiles = updateRelatedProfiles(normalized, now);

  saveMemoryProfiles();
  return { userProfile, ...relatedProfiles };
}

function normalizeMemoryEvent(event) {
  const uid = String(event?.uid || "");
  if (!uid || uid === "undefined" || uid === "null") return null;
  return {
    uid,
    groupId: String(event?.groupId || event?.group_id || ""),
    text: String(event?.text || "").trim(),
    nickname: String(event?.nickname || "").trim(),
  };
}

function updateUserProfile(event, now) {
  const userProfile = ensureUserProfile(event.uid, now);
  const topics = detectTopics(event.text);
  if (event.nickname) addUnique(userProfile.nicknames, event.nickname, 8);
  updateTopics(userProfile.commonTopics, topics, 8);
  updateDislikes(userProfile.dislikes, detectDislikes(event.text), 8);
  applyTone(userProfile, detectTone(event.text));
  bumpConfidence(userProfile, event.text);
  return userProfile;
}

function updateRelatedProfiles(event, now) {
  if (!event.groupId) return { groupProfile: null, userGroupProfile: null };
  const topics = detectTopics(event.text);
  const groupProfile = ensureGroupProfile(event.groupId, now);
  updateTopics(groupProfile.activeTopics, topics, 10);
  applyGroupTone(groupProfile, event.text, now);

  const userGroupProfile = ensureUserGroupProfile(event.groupId, event.uid, now);
  updateTopics(userGroupProfile.recentTopics, topics, 8);
  applyInteractionStyle(userGroupProfile, event.text);
  bumpConfidence(userGroupProfile, event.text);
  return { groupProfile, userGroupProfile };
}

function ensureUserProfile(uid, now = Date.now()) {
  if (!memoryProfiles.userProfiles[uid]) {
    memoryProfiles.userProfiles[uid] = {
      uid,
      nicknames: [],
      preferredTone: "normal",
      commonTopics: [],
      dislikes: [],
      replyStyle: "normal",
      confidence: 0,
      evidenceCount: 0,
      updatedAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    };
  }
  refresh(memoryProfiles.userProfiles[uid], now);
  return memoryProfiles.userProfiles[uid];
}

function ensureGroupProfile(groupId, now = Date.now()) {
  if (!memoryProfiles.groupProfiles[groupId]) {
    memoryProfiles.groupProfiles[groupId] = {
      groupId,
      tone: "normal",
      activeTopics: [],
      jokeLevel: "normal",
      interjectionTolerance: "normal",
      interjectionToleranceSource: "default",
      interjectionToleranceUpdatedAt: 0,
      interjectionToleranceExpiresAt: 0,
      updatedAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    };
  }
  refresh(memoryProfiles.groupProfiles[groupId], now);
  return memoryProfiles.groupProfiles[groupId];
}

function ensureUserGroupProfile(groupId, uid, now = Date.now()) {
  const key = userGroupKey(groupId, uid);
  if (!memoryProfiles.userGroupProfiles[key]) {
    memoryProfiles.userGroupProfiles[key] = {
      groupId: String(groupId),
      uid: String(uid),
      roleInGroup: "normal",
      recentTopics: [],
      interactionStyle: "normal",
      confidence: 0,
      evidenceCount: 0,
      updatedAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    };
  }
  refresh(memoryProfiles.userGroupProfiles[key], now);
  return memoryProfiles.userGroupProfiles[key];
}

function refresh(profile, now) {
  profile.updatedAt = now;
  profile.expiresAt = now + DEFAULT_TTL_MS;
}

function detectTopics(text) {
  const topics = [];
  for (const [topic, pattern] of MEMORY_TOPIC_RULES) {
    if (pattern.test(text)) topics.push(topic);
  }
  return topics;
}

function detectTone(text) {
  if (/别贫|别闹|认真|严肃|别玩笑/.test(text)) return "serious";
  if (/代码|接口|测试|日志|报错|实现|修复|模块/.test(text)) return "technical";
  if (/哈哈|笑死|草|乐|蚌|梗/.test(text)) return "playful";
  if (/难受|烦|累|红温|委屈|救命/.test(text)) return "gentle";
  if (text.length < 12) return "concise";
  return null;
}

function detectDislikes(text) {
  const dislikes = [];
  const match = text.match(/(?:别|不要|不想|不喜欢)(?:再)?(?:叫我|说我|提)(.{1,16})/);
  if (match) dislikes.push(match[1].replace(/[，。.!！?？\s]/g, "").slice(0, 16));
  return dislikes.filter(Boolean);
}

function applyTone(profile, tone) {
  if (!tone) return;
  profile.evidenceCount = Number(profile.evidenceCount || 0) + 1;
  if (profile.confidence >= 0.35 || profile.preferredTone === "normal") {
    profile.preferredTone = tone;
  }
  if (tone === "concise") profile.replyStyle = "concise";
}

function applyGroupTone(profile, text, now) {
  if (/哈哈|笑死|草|乐|梗|整活/.test(text)) {
    profile.tone = "playful";
    profile.jokeLevel = "high";
  } else if (/别吵|安静|别插话|别刷屏/.test(text)) {
    profile.tone = "quiet";
  } else if (/报错|修复|接口|代码|测试/.test(text)) {
    profile.tone = "technical";
  }

  const tolerance = detectExplicitInterjectionTolerance(text);
  if (tolerance) setExplicitInterjectionTolerance(profile, tolerance, now);
}

function detectExplicitInterjectionTolerance(text) {
  const value = String(text || "");
  const lowPatterns = [
    /(?:别|不要|不许|禁止|停止|少).{0,6}(?:插话|接话|回复|回我|乱回|瞎回|说话|刷屏)/,
    /(?:安静点?|闭嘴|少说两句|给你禁了|再.{0,8}回我.{0,8}禁言)/,
  ];
  if (lowPatterns.some(pattern => pattern.test(value))) return "low";

  const highPatterns = [
    /(?:可以|允许|欢迎|尽管|随便|多|主动).{0,6}(?:插话|接话|回复|回话|聊天|说话)/,
    /(?:多聊(?:两句)?|活跃点|热闹点)/,
  ];
  if (highPatterns.some(pattern => pattern.test(value))) return "high";
  return "";
}

function setExplicitInterjectionTolerance(profile, tolerance, now) {
  profile.interjectionTolerance = tolerance;
  profile.interjectionToleranceSource = "explicit";
  profile.interjectionToleranceUpdatedAt = now;
  profile.interjectionToleranceExpiresAt = now + INTERJECTION_PREFERENCE_TTL_MS;
}

function applyInteractionStyle(profile, text) {
  if (/别插话|别吵|安静/.test(text)) profile.interactionStyle = "quiet";
  else if (/哈哈|笑死|草|整活/.test(text)) profile.interactionStyle = "playful";
  else if (/报错|修复|代码|测试/.test(text)) profile.interactionStyle = "technical";
}

function bumpConfidence(profile, text) {
  if (!text || text.length < 4) return;
  profile.evidenceCount = Number(profile.evidenceCount || 0) + 1;
  profile.confidence = Math.min(1, Number(profile.confidence || 0) + 0.08);
}

function updateTopics(target, topics, limit) {
  for (const topic of topics) addUnique(target, topic, limit);
}

function updateDislikes(target, dislikes, limit) {
  for (const item of dislikes) addUnique(target, item, limit);
}

function addUnique(target, item, limit) {
  if (!item || target.includes(item)) return;
  target.push(item);
  if (target.length > limit) target.splice(0, target.length - limit);
}

export function getActiveMemoryContext(uid, groupId, options = {}) {
  const now = options.now || Date.now();
  const userProfile = activeProfile(memoryProfiles.userProfiles[String(uid)], now);
  const rawGroupProfile = activeProfile(memoryProfiles.groupProfiles[String(groupId)], now);
  const groupProfile = withEffectiveInterjectionTolerance(rawGroupProfile, now);
  const userGroupProfile = activeProfile(memoryProfiles.userGroupProfiles[userGroupKey(groupId, uid)], now);
  return { userProfile, groupProfile, userGroupProfile };
}

function withEffectiveInterjectionTolerance(profile, now) {
  if (!profile) return null;
  const isExplicit = profile.interjectionToleranceSource === "explicit";
  const expiresAt = Number(profile.interjectionToleranceExpiresAt || 0);
  const value = profile.interjectionTolerance;
  const effective = isExplicit && expiresAt > now && (value === "high" || value === "low")
    ? value
    : "normal";
  return { ...profile, interjectionTolerance: effective };
}

function activeProfile(profile, now) {
  if (!profile) return null;
  if (Number(profile.expiresAt || 0) <= now) return null;
  if (Number(profile.confidence || 0) > 0 && Number(profile.confidence || 0) < 0.16) return null;
  return profile;
}

export function buildMemorySummary(uid, groupId, options = {}) {
  const ctx = getActiveMemoryContext(uid, groupId, options);
  const lines = [];
  if (ctx.userProfile) {
    lines.push("用户画像: " + compactProfile(ctx.userProfile, ["preferredTone", "replyStyle", "commonTopics", "dislikes", "confidence"]));
  }
  if (ctx.groupProfile) {
    lines.push("群画像: " + compactProfile(ctx.groupProfile, ["tone", "activeTopics", "jokeLevel", "interjectionTolerance"]));
  }
  if (ctx.userGroupProfile) {
    lines.push("群内互动画像: " + compactProfile(ctx.userGroupProfile, ["interactionStyle", "recentTopics", "confidence"]));
  }
  return lines.join("\n");
}

export function buildHumanMemorySummary(uid, groupId, options = {}) {
  const ctx = getActiveMemoryContext(uid, groupId, options);
  const lines = [];
  if (ctx.userProfile) lines.push("用户画像：" + describeUserProfile(ctx.userProfile));
  if (ctx.groupProfile) lines.push("群画像：" + describeGroupProfile(ctx.groupProfile));
  if (ctx.userGroupProfile) lines.push("群内互动画像：" + describeUserGroupProfile(ctx.userGroupProfile));
  return lines.join("\n");
}

function compactProfile(profile, keys) {
  return keys.map(key => {
    const value = profile[key];
    if (Array.isArray(value)) return key + "=" + (value.length ? value.join(",") : "无");
    if (typeof value === "number") return key + "=" + value.toFixed(2);
    return key + "=" + (value || "normal");
  }).join("; ");
}

function describeUserProfile(profile) {
  return [
    "回复偏好偏 " + toneLabel(profile.preferredTone),
    "表达长度偏 " + toneLabel(profile.replyStyle),
    "常聊主题：" + listLabel(profile.commonTopics),
    "避雷点：" + listLabel(profile.dislikes),
    "可信度：" + confidenceLabel(profile.confidence),
  ].join("；");
}

function describeGroupProfile(profile) {
  return [
    "群氛围偏 " + toneLabel(profile.tone),
    "活跃主题：" + listLabel(profile.activeTopics),
    "玩笑尺度：" + toneLabel(profile.jokeLevel),
    "插话容忍度：" + toneLabel(profile.interjectionTolerance),
  ].join("；");
}

function describeUserGroupProfile(profile) {
  return [
    "群内互动风格偏 " + toneLabel(profile.interactionStyle),
    "近期主题：" + listLabel(profile.recentTopics),
    "可信度：" + confidenceLabel(profile.confidence),
  ].join("；");
}

function listLabel(value) {
  return Array.isArray(value) && value.length ? value.join("、") : "暂无明显记录";
}

function confidenceLabel(value) {
  const score = Number(value || 0);
  if (score >= 0.75) return "较高";
  if (score >= 0.35) return "中等";
  if (score > 0) return "较低";
  return "暂无";
}

function toneLabel(value) {
  const labels = {
    normal: "自然",
    concise: "简短",
    serious: "认真",
    technical: "技术",
    playful: "轻松玩笑",
    gentle: "温和",
    quiet: "安静",
    high: "较高",
    low: "较低",
  };
  return labels[value] || "自然";
}

export function clearUserMemoryProfile(uid) {
  const id = String(uid || "");
  if (!id) return false;
  delete memoryProfiles.userProfiles[id];
  for (const key of Object.keys(memoryProfiles.userGroupProfiles)) {
    if (key.endsWith(":" + id)) delete memoryProfiles.userGroupProfiles[key];
  }
  saveMemoryProfiles();
  return true;
}

export function clearGroupMemoryProfile(groupId) {
  const gid = String(groupId || "");
  if (!gid) return false;
  delete memoryProfiles.groupProfiles[gid];
  for (const key of Object.keys(memoryProfiles.userGroupProfiles)) {
    if (key.startsWith(gid + ":")) delete memoryProfiles.userGroupProfiles[key];
  }
  saveMemoryProfiles();
  return true;
}

export function getMemoryStatus(now = Date.now()) {
  return {
    users: countActive(memoryProfiles.userProfiles, now),
    groups: countActive(memoryProfiles.groupProfiles, now),
    userGroups: countActive(memoryProfiles.userGroupProfiles, now),
  };
}

function countActive(collection, now) {
  return Object.values(collection || {}).filter(profile => Number(profile.expiresAt || 0) > now).length;
}

export function cleanupExpiredMemoryProfiles(now = Date.now()) {
  const before = getMemoryStatus(now - DEFAULT_TTL_MS * 2);
  removeExpired(memoryProfiles.userProfiles, now);
  removeExpired(memoryProfiles.groupProfiles, now);
  removeExpired(memoryProfiles.userGroupProfiles, now);
  saveMemoryProfiles();
  return before;
}

function removeExpired(collection, now) {
  for (const [key, profile] of Object.entries(collection || {})) {
    if (Number(profile.expiresAt || 0) <= now) delete collection[key];
  }
}

function userGroupKey(groupId, uid) {
  return String(groupId || "0") + ":" + String(uid || "0");
}
