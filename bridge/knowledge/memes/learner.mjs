import {
  getMemeStore,
  saveMemeStore,
} from "./store.mjs";
import { matchMemes } from "./matcher.mjs";
import { isMemeLearningExcluded } from "./message-policy.mjs";

const CANDIDATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function observeMemeUsage(event = {}) {
  const store = getMemeStore();
  if (store.mode === "off") return [];
  const text = String(event.text || "").trim();
  if (isMemeLearningExcluded(text, event)) return [];

  const now = Number(event.now || Date.now());
  store.stats.observedMessages = Number(store.stats.observedMessages || 0) + 1;
  const touched = touchKnownMemes(text, event, now);
  saveMemeStore();
  return touched;
}

export function runMemeDecay(now = Date.now()) {
  const store = getMemeStore();
  const removedCandidates = removeExpiredCandidates(store, now);
  const quarantinedEntries = quarantineLegacyEntries(store, now);
  if (removedCandidates || quarantinedEntries) saveMemeStore();
  return { removedCandidates, quarantinedEntries };
}

function touchKnownMemes(text, event, now) {
  const touched = [];
  for (const match of matchMemes(text, {
    groupId: event.groupId || event.group_id,
    limit: 8,
  })) {
    const entry = getMemeStore().entries.find(item => item.name === match.name);
    if (!entry || touched.includes(entry.name)) continue;
    entry.lastSeenAt = new Date(now).toISOString();
    entry.seenCount = Number(entry.seenCount || 0) + 1;
    entry.evidence = {
      ...(entry.evidence || {}),
      count: Number(entry.evidence?.count || 0) + 1,
    };
    touched.push(entry.name);
  }
  return touched;
}

function removeExpiredCandidates(store, now) {
  let removed = 0;
  for (const [key, candidate] of Object.entries(store.candidates || {})) {
    if (!isOlderThan(candidate.lastSeen, now, CANDIDATE_MAX_AGE_MS)) continue;
    delete store.candidates[key];
    removed += 1;
  }
  return removed;
}

function quarantineLegacyEntries(store, now) {
  let quarantined = 0;
  for (const entry of store.entries || []) {
    if (!shouldQuarantineLegacyEntry(entry, now)) continue;
    entry.status = "quarantined";
    entry.enabled = false;
    entry.updatedAt = new Date(now).toISOString();
    quarantined += 1;
  }
  return quarantined;
}

function shouldQuarantineLegacyEntry(entry, now) {
  if (!["auto", "china-meme-dictionary"].includes(entry.source)) return false;
  if (entry.status !== "active") return false;
  if (hasManualStatusProtection(entry)) return false;
  if (entry.source === "china-meme-dictionary") return true;
  return isOlderThan(entry.lastSeenAt || entry.updatedAt, now, AUTO_STALE_MS);
}

function hasManualStatusProtection(entry) {
  return (entry.manualFields || []).some(field => field === "status" || field === "enabled");
}

function isOlderThan(value, now, maxAgeMs) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && Number(now) - timestamp > maxAgeMs;
}
