import { memoryProfiles } from "./store.mjs";
import { userGroupKey } from "./constants.mjs";

export function getActiveMemoryContext(uid, groupId, options = {}) {
  const now = options.now || Date.now();
  const userProfile = activeProfile(memoryProfiles.userProfiles[String(uid)], now);
  const rawGroupProfile = activeProfile(memoryProfiles.groupProfiles[String(groupId)], now);
  const groupProfile = withEffectiveInterjectionTolerance(rawGroupProfile, now);
  const userGroupProfile = activeProfile(memoryProfiles.userGroupProfiles[userGroupKey(groupId, uid)], now);
  return { userProfile, groupProfile, userGroupProfile };
}

export function withEffectiveInterjectionTolerance(profile, now) {
  if (!profile) return null;
  const isExplicit = profile.interjectionToleranceSource === "explicit";
  const expiresAt = Number(profile.interjectionToleranceExpiresAt || 0);
  const value = profile.interjectionTolerance;
  const effective = isExplicit && expiresAt > now && (value === "high" || value === "low")
    ? value
    : "normal";
  return { ...profile, interjectionTolerance: effective };
}

export function activeProfile(profile, now) {
  if (!profile) return null;
  if (Number(profile.expiresAt || 0) <= now) return null;
  if (Number(profile.confidence || 0) > 0 && Number(profile.confidence || 0) < 0.16) return null;
  return profile;
}

export function getMemoryStatus(now = Date.now()) {
  return {
    users: countActive(memoryProfiles.userProfiles, now),
    groups: countActive(memoryProfiles.groupProfiles, now),
    userGroups: countActive(memoryProfiles.userGroupProfiles, now),
  };
}

export function countActive(collection, now) {
  return Object.values(collection || {}).filter(profile => Number(profile.expiresAt || 0) > now).length;
}
