import { CFG } from "../config.mjs";
import { users, groupChats } from "../storage.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { DEFAULT_TTL_MS } from "./constants.mjs";
import { memoryCorrectionSnapshot } from "./notes.mjs";
import { bindLayerMemoryReferences, createMemoryReadGuard } from "./read-guard.mjs";
import { isUsableEvidenceSource } from "./evidence.mjs";
import { excludedMemorySource } from "./source-exclusions.mjs";
import { storedMemorySourceIndex } from "./retention.mjs";
import { detectTopics, detectTone, detectDislikes, applyGroupTone, applyInteractionStyle, addUnique } from "./inference.mjs";

const proofs = new WeakMap();
const LIMIT = 2000;
const ID = /^[1-9]\d{0,19}$/;

// Keep historical numeric counters unchanged; textual inferences need surviving source evidence.
export function projectMemoryProfiles(context, { uid, groupId, now }) {
  const read = sourceRead(uid, now);
  return {
    userProfile: project(context.userProfile, "user", () => ownRows(uid), read),
    groupProfile: project(context.groupProfile, "group", () => groupRows(groupId), read),
    userGroupProfile: project(context.userGroupProfile, "user-group", () => ownRows(uid).filter(item => String(item.group) === groupId), read),
  };
}

function ownRows(uid) {
  return (users[uid]?.chats || []).filter(item => item &&
    [item.uid, item.userId, item.user_id].every(author => author === undefined || String(author) === uid)).map(item => ({ ...item, uid }));
}

function groupRows(groupId) {
  return (groupChats[groupId] || []).filter(item => item && (item.group === undefined || String(item.group) === groupId))
    .map(item => ({ ...item, group: groupId }));
}

function sourceRead(uid, now) {
  const read = { uid, now, corrections: new Map(), privacy: null, capture: true };
  try { read.privacy = summaryPrivacy(); } catch { /* Each requested projection reports unavailable. */ }
  return read;
}

export function captureProfileReadReason(context) {
  const readers = Object.values(context || {}).map(profile => profile && proofs.get(profile)).filter(Boolean);
  return () => {
    for (const read of readers) {
      const reason = read();
      if (reason) return reason;
    }
    return "";
  };
}

export function refreshStoredProfileText(profiles, actorId, now = Date.now()) {
  // This synchronous erase rebuild shares only negative ids, never private note bodies.
  const read = sourceRead(actorId, now);
  read.capture = false;
  try { read.index = storedMemorySourceIndex(); } catch { read.privacy = null; }
  const update = (profile, type, rows) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return;
    const view = project(profile, type, rows, read);
    Object.assign(profile, Object.fromEntries(Object.keys(emptyText(type)).map(key => [key, view[key]])));
  };
  for (const [uid, profile] of Object.entries(profiles.userProfiles)) update(profile, "user", () => ownRows(uid));
  for (const [groupId, profile] of Object.entries(profiles.groupProfiles)) update(profile, "group", () => groupRows(groupId));
  for (const [key, profile] of Object.entries(profiles.userGroupProfiles)) {
    const [groupId, uid] = key.split(":");
    update(profile, "user-group", () => ownRows(uid).filter(item => String(item.group) === groupId));
  }
}

function project(profile, kind, loadRows, read) {
  if (!profile) return null;
  const { uid, now } = read;
  const view = { ...profile, ...emptyText(kind), sourceState: "unavailable", sourceCount: 0, sourceExpiresAt: null };
  try {
    if (!ID.test(uid) || !Number.isSafeInteger(now) || now <= 0) throw new Error("invalid_source_scope");
    const rows = selectRows(loadRows(), read);
    const witnesses = new Map();
    for (const row of rows) infer(view, kind, row, witnesses);
    const selected = selectedWitnesses(view, kind, witnesses);
    const guards = read.capture ? guardSources(selected, uid) : [];
    if (guards.some(guard => guard.reason())) throw new Error("memory_unavailable");
    view.sourceState = selected.length ? "available" : "empty";
    view.sourceCount = selected.length;
    applySourceLifetime(view, selected, guards, kind, now);
    proofs.set(view, () => guards.map(guard => guard.reason()).find(Boolean) || "");
  } catch {
    Object.assign(view, emptyText(kind), { sourceState: "unavailable", sourceCount: 0, sourceExpiresAt: null });
    proofs.set(view, () => "memory_unavailable");
  }
  return view;
}

function applySourceLifetime(view, selected, guards, kind, now) {
  view.sourceExpiresAt = selected.length ? Math.min(...selected.map(row => row.ts + DEFAULT_TTL_MS + 1),
    ...guards.map(guard => guard.expiry() ?? Infinity)) : null;
  if (kind === "group") {
    if (view.interjectionToleranceExpiresAt <= now) view.interjectionTolerance = "normal";
    else view.sourceExpiresAt = Math.min(view.sourceExpiresAt ?? Infinity, view.interjectionToleranceExpiresAt);
  }
  for (const guard of guards) guard.limitUntil(Math.min(view.sourceExpiresAt, Number(view.expiresAt)));
}

function selectRows(rows, { uid, now, privacy, corrections, index }) {
  if (!Array.isArray(rows)) throw new Error("invalid_source_rows");
  if (!privacy?.users || typeof privacy.users !== "object" || Array.isArray(privacy.users)) throw new Error("privacy_unavailable");
  const seen = new Set(), selected = [];
  for (const raw of rows.slice(-2000).reverse().sort((a, b) => b.ts - a.ts)) {
    const row = usableRow(raw, privacy, uid, now, corrections, index);
    if (!row) continue;
    const textKey = "text:" + row.uid + ":" + row.text.normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, "").toLowerCase();
    const sourceKey = "id:" + row.group + ":" + row.messageId;
    if (!row.text.trim() || seen.has(textKey) || seen.has(sourceKey)) continue;
    seen.add(textKey); seen.add(sourceKey);
    selected.push(row);
    if (selected.length >= LIMIT) break;
  }
  return selected.reverse();
}

function usableRow(raw, privacy, uid, now, corrections, index) {
  const row = { ...raw, uid: String(raw?.uid || ""), group: String(raw?.group || "") };
  if (!validSourceIdentity(raw, row)) return null;
  const cutoff = privacy.users[row.uid] ?? 0;
  if (!Number.isFinite(cutoff) || cutoff < 0) throw new Error("privacy_unavailable");
  if (!isUsableEvidenceSource(row, row.group, now, cutoff, DEFAULT_TTL_MS)) return null;
  if (!corrections.has(row.group)) {
    const scope = { userId: uid, groupId: row.group };
    const ids = memoryCorrectionSnapshot(scope).excludedMessageIds;
    corrections.set(row.group, index ? index.expand(scope, ids) : ids);
  }
  return excludedMemorySource(row, corrections.get(row.group)) ? null : { ...row, text: redactSensitiveText(row.text) };
}

function validSourceIdentity(raw, row) {
  return ID.test(row.uid) && ID.test(row.group) && row.role !== "assistant" && row.uid !== String(CFG.selfUin) &&
    [raw.userId, raw.user_id].every(author => author === undefined || String(author) === row.uid) &&
    [raw.groupId, raw.group_id].every(group => group === undefined || String(group) === row.group);
}

function guardSources(rows, uid) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push({ userId: row.uid, messageId: String(row.messageId), replyToMessageId: row.replyToMessageId, turnId: row.turnId });
  }
  return [...groups].map(([groupId, contextSources]) => {
    const scope = { userId: uid, groupId, surface: "group" };
    const [layer] = bindLayerMemoryReferences([{ contextSources }], scope);
    if (!layer.contextMemorySources) throw new Error("memory_unavailable");
    const guard = createMemoryReadGuard(scope);
    guard.track(layer.contextMemorySources);
    return guard;
  });
}

function emptyText(kind) {
  if (kind === "user") return { commonTopics: [], dislikes: [], nicknames: [], preferredTone: "normal", replyStyle: "normal" };
  if (kind === "user-group") return { recentTopics: [], interactionStyle: "normal" };
  return { activeTopics: [], tone: "normal", jokeLevel: "normal", interjectionTolerance: "normal",
    interjectionToleranceSource: "default", interjectionToleranceUpdatedAt: 0, interjectionToleranceExpiresAt: 0 };
}

function infer(profile, kind, row, witnesses) {
  const topicKey = kind === "user" ? "commonTopics" : kind === "group" ? "activeTopics" : "recentTopics";
  rememberList(profile, topicKey, detectTopics(row.text), row, witnesses, kind === "group" ? 10 : 8);
  if (kind === "group") {
    const before = { tone: profile.tone, jokeLevel: profile.jokeLevel, interjectionTolerance: profile.interjectionTolerance,
      interjectionToleranceUpdatedAt: profile.interjectionToleranceUpdatedAt };
    applyGroupTone(profile, row.text, row.ts);
    for (const key of Object.keys(before)) if (profile[key] !== before[key]) witnesses.set(key, row);
  } else if (kind === "user-group") {
    const before = profile.interactionStyle;
    applyInteractionStyle(profile, row.text);
    if (before !== profile.interactionStyle) witnesses.set("interactionStyle", row);
  }
  else {
    rememberList(profile, "dislikes", detectDislikes(row.text), row, witnesses);
    if (row.nickname) rememberList(profile, "nicknames", [redactSensitiveText(row.nickname)], row, witnesses);
    const tone = detectTone(row.text);
    if (tone) { profile.preferredTone = tone; witnesses.set("preferredTone", row); }
    if (tone === "concise") { profile.replyStyle = "concise"; witnesses.set("replyStyle", row); }
  }
}

function rememberList(profile, key, values, row, witnesses, limit = 8) {
  for (const value of values) {
    addUnique(profile[key], value, limit);
    witnesses.set(key + ":" + value, row);
  }
}

function selectedWitnesses(profile, kind, witnesses) {
  const selected = new Set();
  for (const key of Object.keys(emptyText(kind))) {
    const names = Array.isArray(profile[key]) ? profile[key].map(value => key + ":" + value) : [key];
    for (const name of names) if (witnesses.has(name)) selected.add(witnesses.get(name));
  }
  return [...selected];
}
