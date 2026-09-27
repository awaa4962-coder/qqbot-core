import { DEFAULT_TTL_MS, userGroupKey } from "./constants.mjs";
import { detectTopics, detectTone, detectDislikes, applyTone, applyGroupTone, detectExplicitInterjectionTolerance, setExplicitInterjectionTolerance, applyInteractionStyle, bumpConfidence, updateTopics, updateDislikes, addUnique } from "./inference.mjs";
export { detectTopics, detectTone, detectDislikes, applyTone, applyGroupTone, detectExplicitInterjectionTolerance, setExplicitInterjectionTolerance, applyInteractionStyle, bumpConfidence, updateTopics, updateDislikes, addUnique };
import { getMemoryStatus } from "./query.mjs";
import { memoryProfiles, memoryProfilesAvailable, saveMemoryProfiles, flushMemoryProfilesSync } from "./store.mjs";
import { memoryNoteService } from "./notes.mjs";
import { logE } from "../logger.mjs";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";
import { invalidateMemoryPrivacyGeneration, invalidateUserMemoryGeneration } from "./generation.mjs";
import { users, saveUsers, flushSavesSync } from "../storage.mjs";
import { refreshStoredProfileText } from "./projection.mjs";

export function isSensitiveMemoryText(text) {
  return containsSensitiveText(text);
}

export function observeMemoryEvent(event, options = {}) {
  if (!memoryProfilesAvailable()) return null;
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
    nickname: redactSensitiveText(event?.nickname).trim(),
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
  if (!isUnexpired(memoryProfiles.userProfiles[uid], now)) {
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
  if (!isUnexpired(memoryProfiles.groupProfiles[groupId], now)) {
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
  if (!isUnexpired(memoryProfiles.userGroupProfiles[key], now)) {
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

function isUnexpired(profile, now) {
  return profile && Number(profile.expiresAt || 0) > now;
}


export function clearUserMemoryProfile(uid, options = {}) {
  const id = String(uid || "");
  if (!id) return false;
  invalidateUserMemoryGeneration(id);
  if (users[id]) {
    users[id].profile = "";
    users[id].description = "";
    users[id].relationshipComments = {};
    users[id].profileGeneratedAt = 0;
    users[id].profileGeneratedChatCount = 0;
    saveUsers();
  }
  delete memoryProfiles.userProfiles[id];
  for (const key of Object.keys(memoryProfiles.userGroupProfiles)) {
    if (key.endsWith(":" + id)) delete memoryProfiles.userGroupProfiles[key];
  }
  // Rebuild automatic text caches without removing other members' source messages or counters.
  refreshStoredProfileText(memoryProfiles, id);
  saveMemoryProfiles();
  if (options.persist) confirmProfileClear();
  return true;
}

export function clearGroupMemoryProfile(groupId, options = {}) {
  const gid = String(groupId || "");
  if (!gid) return false;
  invalidateMemoryPrivacyGeneration();
  for (const user of Object.values(users)) {
    if (!user?.relationshipComments?.[gid]) continue;
    delete user.relationshipComments[gid];
    saveUsers();
  }
  delete memoryProfiles.groupProfiles[gid];
  for (const key of Object.keys(memoryProfiles.userGroupProfiles)) {
    if (key.startsWith(gid + ":")) delete memoryProfiles.userGroupProfiles[key];
  }
  saveMemoryProfiles();
  if (options.persist) confirmProfileClear();
  return true;
}

function confirmProfileClear() {
  const usersSaved = flushSavesSync({ durable: true });
  const profilesSaved = flushMemoryProfilesSync();
  if (!usersSaved || !profilesSaved) throw new Error("profile_clear_unconfirmed");
}

export function cleanupExpiredMemoryProfiles(now = Date.now()) {
  const before = getMemoryStatus(now - DEFAULT_TTL_MS * 2);
  removeExpired(memoryProfiles.userProfiles, now);
  removeExpired(memoryProfiles.groupProfiles, now);
  removeExpired(memoryProfiles.userGroupProfiles, now);
  try { memoryNoteService.prune(now); } catch { logE("memory note cleanup unavailable"); }
  saveMemoryProfiles();
  return before;
}

export function removeExpired(collection, now) {
  for (const [key, profile] of Object.entries(collection || {})) {
    if (Number(profile.expiresAt || 0) <= now) delete collection[key];
  }
}
