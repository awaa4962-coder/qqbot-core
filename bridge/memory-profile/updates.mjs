import { DEFAULT_TTL_MS, INTERJECTION_PREFERENCE_TTL_MS, SENSITIVE_PATTERNS, userGroupKey } from "./constants.mjs";
import { MEMORY_TOPIC_RULES } from "../knowledge/topic-rules.mjs";
import { getMemoryStatus } from "./query.mjs";
import { memoryProfiles, saveMemoryProfiles } from "./store.mjs";

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

export function normalizeMemoryEvent(event) {
  const uid = String(event?.uid || "");
  if (!uid || uid === "undefined" || uid === "null") return null;
  return {
    uid,
    groupId: String(event?.groupId || event?.group_id || ""),
    text: String(event?.text || "").trim(),
    nickname: String(event?.nickname || "").trim(),
  };
}

export function updateUserProfile(event, now) {
  const userProfile = ensureUserProfile(event.uid, now);
  const topics = detectTopics(event.text);
  if (event.nickname) addUnique(userProfile.nicknames, event.nickname, 8);
  updateTopics(userProfile.commonTopics, topics, 8);
  updateDislikes(userProfile.dislikes, detectDislikes(event.text), 8);
  applyTone(userProfile, detectTone(event.text));
  bumpConfidence(userProfile, event.text);
  return userProfile;
}

export function updateRelatedProfiles(event, now) {
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

export function ensureUserProfile(uid, now = Date.now()) {
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

export function ensureGroupProfile(groupId, now = Date.now()) {
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

export function ensureUserGroupProfile(groupId, uid, now = Date.now()) {
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

export function refresh(profile, now) {
  profile.updatedAt = now;
  profile.expiresAt = now + DEFAULT_TTL_MS;
}

export function detectTopics(text) {
  const topics = [];
  for (const [topic, pattern] of MEMORY_TOPIC_RULES) {
    if (pattern.test(text)) topics.push(topic);
  }
  return topics;
}

export function detectTone(text) {
  if (/别贫|别闹|认真|严肃|别玩笑/.test(text)) return "serious";
  if (/代码|接口|测试|日志|报错|实现|修复|模块/.test(text)) return "technical";
  if (/哈哈|笑死|草|乐|蚌|梗/.test(text)) return "playful";
  if (/难受|烦|累|红温|委屈|救命/.test(text)) return "gentle";
  if (text.length < 12) return "concise";
  return null;
}

export function detectDislikes(text) {
  const dislikes = [];
  const match = text.match(/(?:别|不要|不想|不喜欢)(?:再)?(?:叫我|说我|提)(.{1,16})/);
  if (match) dislikes.push(match[1].replace(/[，。.!！?？\s]/g, "").slice(0, 16));
  return dislikes.filter(Boolean);
}

export function applyTone(profile, tone) {
  if (!tone) return;
  profile.evidenceCount = Number(profile.evidenceCount || 0) + 1;
  if (profile.confidence >= 0.35 || profile.preferredTone === "normal") {
    profile.preferredTone = tone;
  }
  if (tone === "concise") profile.replyStyle = "concise";
}

export function applyGroupTone(profile, text, now) {
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

export function detectExplicitInterjectionTolerance(text) {
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

export function setExplicitInterjectionTolerance(profile, tolerance, now) {
  profile.interjectionTolerance = tolerance;
  profile.interjectionToleranceSource = "explicit";
  profile.interjectionToleranceUpdatedAt = now;
  profile.interjectionToleranceExpiresAt = now + INTERJECTION_PREFERENCE_TTL_MS;
}

export function applyInteractionStyle(profile, text) {
  if (/别插话|别吵|安静/.test(text)) profile.interactionStyle = "quiet";
  else if (/哈哈|笑死|草|整活/.test(text)) profile.interactionStyle = "playful";
  else if (/报错|修复|代码|测试/.test(text)) profile.interactionStyle = "technical";
}

export function bumpConfidence(profile, text) {
  if (!text || text.length < 4) return;
  profile.evidenceCount = Number(profile.evidenceCount || 0) + 1;
  profile.confidence = Math.min(1, Number(profile.confidence || 0) + 0.08);
}

export function updateTopics(target, topics, limit) {
  for (const topic of topics) addUnique(target, topic, limit);
}

export function updateDislikes(target, dislikes, limit) {
  for (const item of dislikes) addUnique(target, item, limit);
}

export function addUnique(target, item, limit) {
  if (!item || target.includes(item)) return;
  target.push(item);
  if (target.length > limit) target.splice(0, target.length - limit);
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

export function cleanupExpiredMemoryProfiles(now = Date.now()) {
  const before = getMemoryStatus(now - DEFAULT_TTL_MS * 2);
  removeExpired(memoryProfiles.userProfiles, now);
  removeExpired(memoryProfiles.groupProfiles, now);
  removeExpired(memoryProfiles.userGroupProfiles, now);
  saveMemoryProfiles();
  return before;
}

export function removeExpired(collection, now) {
  for (const [key, profile] of Object.entries(collection || {})) {
    if (Number(profile.expiresAt || 0) <= now) delete collection[key];
  }
}
