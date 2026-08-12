import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../../config.mjs";
import { log, logE } from "../../logger.mjs";
import { BUILTIN_MEMES } from "./seed.mjs";
import {
  MEME_STORE_VERSION,
  createEmptyMemeStore,
  isMemeTombstoned,
  makeMemeTombstone,
  migrateMemeStore,
  normalizeMemeCandidate,
  normalizeMemeEntry,
  normalizeMemeKey,
  normalizeMemeMode,
} from "./schema.mjs";

const SAVE_DEBOUNCE_MS = 10000;
const LAST_GOOD_SUFFIX = ".last-good.json";
const MAX_CANDIDATES = 500;
const ALL_EDITABLE_FIELDS = Object.freeze([
  "name",
  "aliases",
  "triggers",
  "meaning",
  "usage",
  "examples",
  "sources",
  "confidence",
  "semanticConfidence",
  "level",
  "enabled",
  "status",
  "scope",
]);

let storePath = CFG.memeKnowledgeFile;
let state = createEmptyMemeStore(CFG.memeLearningMode);
let dirty = false;
let saveTimer = null;

cleanupStaleMemeTempFiles();
loadMemeStore();

export function getMemeStore() {
  return state;
}

export function getMemeStorePath() {
  return storePath;
}

export function setMemeStorePath(filePath) {
  cancelSaveTimer();
  storePath = String(filePath || CFG.memeKnowledgeFile);
  state = createEmptyMemeStore(CFG.memeLearningMode);
  dirty = false;
  loadMemeStore();
}

export function resetMemeStoreForTest(filePath = "") {
  cancelSaveTimer();
  storePath = String(filePath || CFG.memeKnowledgeFile);
  state = createEmptyMemeStore(CFG.memeLearningMode);
  dirty = false;
}

export function saveMemeStore() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushMemeStoreSync();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function flushMemeStoreSync() {
  cancelSaveTimer();
  if (!dirty) return false;

  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    preserveLastGoodFile();
    const tmp = storePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, storePath);
    dirty = false;
    return true;
  } catch (error) {
    dirty = true;
    logE("save meme store failed:", error.message);
    return false;
  }
}

export function cleanupStaleMemeTempFiles(options = {}) {
  const now = Number(options.now || Date.now());
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 24 * 60 * 60 * 1000));
  const directory = path.dirname(storePath);
  const prefix = path.basename(storePath) + ".tmp.";
  let removed = 0;
  let files = [];
  try {
    files = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith(prefix)) continue;
    const target = path.join(directory, file.name);
    try {
      if (now - fs.statSync(target).mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { force: true });
      removed++;
    } catch {}
  }
  if (removed) log("meme stale temp cleaned:", removed);
  return { removed };
}

export function setMemeMode(mode) {
  state.mode = normalizeMemeMode(mode);
  saveMemeStore();
  return state.mode;
}

export function upsertMeme(entry, options = {}) {
  const now = Number(options.now || Date.now());
  const normalized = normalizeMemeEntry(entry, { now });
  if (!normalized) return null;
  if (isMemeTombstoned(state, normalized.name) && options.restoreTombstone !== true) {
    return null;
  }
  const existing = findMemeByNameOrAlias(options.lookupName || normalized.name);
  if (options.recordHistory) {
    appendMemeHistory(existing?.name || normalized.name, options.historyAction || "edit", existing, now);
  }
  return existing
    ? mergeExistingMeme(existing, normalized, options, now)
    : createMemeEntry(normalized, options, now);
}

function createMemeEntry(normalized, options, now) {
  const created = normalizeMemeEntry({
    ...normalized,
    source: normalized.source || "manual",
    manualFields: options.markManual
      ? normalizeProtectedFields(options.manualFields, ALL_EDITABLE_FIELDS)
      : normalized.manualFields,
    status: normalized.status || "active",
    enabled: normalized.enabled !== false,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }, { now });
  state.entries.push(created);
  clearTombstone(created.name, options.restoreTombstone === true);
  removeCandidate(created.name);
  if (!options.deferSave) saveMemeStore();
  return created;
}

function mergeExistingMeme(existing, normalized, options, now) {
  const protectedFields = protectedFieldSet(existing, options);
  const merged = mergeMemeValues(existing, normalized, protectedFields, now);
  protectLocalValues(merged, existing, normalized, protectedFields, options);
  const replacement = normalizeMemeEntry(merged, { now });
  Object.assign(existing, replacement);
  clearTombstone(existing.name, options.restoreTombstone === true);
  if (existing.status === "active") removeCandidate(existing.name);
  if (!options.deferSave) saveMemeStore();
  return existing;
}

function mergeMemeValues(existing, normalized, protectedFields, now) {
  return {
    ...existing,
    ...normalized,
    aliases: uniqueText([...(existing.aliases || []), ...(normalized.aliases || [])]),
    triggers: uniqueText([...(existing.triggers || []), ...(normalized.triggers || [])]),
    examples: uniqueText([...(existing.examples || []), ...(normalized.examples || [])], 8),
    sources: uniqueSources([...(existing.sources || []), ...(normalized.sources || [])]),
    createdAt: existing.createdAt,
    firstSeenAt: earliestIso(existing.firstSeenAt, normalized.firstSeenAt),
    lastSeenAt: latestIso(existing.lastSeenAt, normalized.lastSeenAt),
    lastVerifiedAt: latestOptionalIso(existing.lastVerifiedAt, normalized.lastVerifiedAt),
    expiresAt: latestOptionalIso(existing.expiresAt, normalized.expiresAt),
    seenCount: Math.max(Number(existing.seenCount || 0), Number(normalized.seenCount || 0)),
    evidence: mergeEvidence(existing.evidence, normalized.evidence),
    manualFields: [...protectedFields],
    updatedAt: new Date(now).toISOString(),
  };
}

function protectLocalValues(merged, existing, normalized, protectedFields, options) {
  const incomingSource = normalized.source || "manual";
  const isUpstreamUpdate = options.preserveLocal === true ||
    ["auto", "china-meme-dictionary", "web-verified"].includes(incomingSource);
  if (isUpstreamUpdate) {
    for (const field of protectedFields) {
      if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field];
    }
    if (existing.source === "manual" || protectedFields.has("source")) merged.source = existing.source;
  }

  if (options.markManual) {
    merged.name = normalized.name;
    merged.aliases = normalized.aliases;
    merged.triggers = normalized.triggers;
    merged.meaning = normalized.meaning;
    merged.usage = normalized.usage;
    merged.examples = normalized.examples;
    merged.sources = normalized.sources;
    merged.confidence = normalized.confidence;
    merged.semanticConfidence = normalized.semanticConfidence;
    merged.level = normalized.level;
    merged.enabled = normalized.enabled;
    merged.status = normalized.enabled === false ? "disabled" : normalized.status;
    merged.scope = normalized.scope;
  }
}

function protectedFieldSet(existing, options) {
  const fields = new Set(options.replaceManualFields ? [] : (existing.manualFields || []));
  if (!options.markManual) return fields;
  for (const field of normalizeProtectedFields(options.manualFields, ALL_EDITABLE_FIELDS)) fields.add(field);
  return fields;
}

export function findMemeByNameOrAlias(value) {
  const needle = normalizeMemeKey(value);
  if (!needle) return null;
  return state.entries.find(entry =>
    entryKeys(entry).some(key => normalizeMemeKey(key) === needle)
  ) || null;
}

export function setMemeEnabled(value, enabled, options = {}) {
  const entry = findMemeByNameOrAlias(value);
  if (!entry) return null;
  if (options.recordHistory) {
    appendMemeHistory(entry.name, enabled ? "enable" : "disable", entry, options.now);
  }
  entry.enabled = Boolean(enabled);
  entry.status = enabled ? "active" : "disabled";
  entry.updatedAt = new Date().toISOString();
  saveMemeStore();
  return entry;
}

export function setMemeStatus(value, status, options = {}) {
  if (!["active", "quarantined", "disabled", "stale"].includes(status)) return null;
  const entry = findMemeByNameOrAlias(value);
  if (!entry) return null;
  if (options.recordHistory) appendMemeHistory(entry.name, status, entry, options.now);
  entry.status = status;
  entry.enabled = status === "active";
  entry.updatedAt = new Date().toISOString();
  if (status === "active") removeCandidate(entry.name);
  saveMemeStore();
  return entry;
}

export function deleteMeme(value, options = {}) {
  const entry = findMemeByNameOrAlias(value);
  if (!entry) return null;
  if (options.recordHistory) appendMemeHistory(entry.name, "delete", entry, options.now);
  state.entries = state.entries.filter(item => item !== entry);
  for (const key of entryKeys(entry)) removeCandidate(key);
  const tombstone = makeMemeTombstone(entry, options.now);
  state.tombstones = [
    ...(state.tombstones || []).filter(item => item.key !== tombstone.key),
    tombstone,
  ];
  saveMemeStore();
  return entry;
}

export function getMemeCandidate(value) {
  return state.candidates[normalizeMemeKey(value)] || null;
}

export function upsertMemeCandidate(candidate, options = {}) {
  const normalized = normalizeMemeCandidate(candidate, {
    now: options.now,
    salt: state.privacySalt,
  });
  if (!normalized || isMemeTombstoned(state, normalized.term)) return null;
  state.candidates[normalizeMemeKey(normalized.term)] = normalized;
  enforceCandidateLimit();
  saveMemeStore();
  return normalized;
}

export function removeMemeCandidate(value) {
  const removed = removeCandidate(value);
  if (removed) saveMemeStore();
  return removed;
}

export function clearMemeCandidates() {
  const count = Object.keys(state.candidates || {}).length;
  state.candidates = {};
  if (count) saveMemeStore();
  return count;
}

export function getMemeHistory(limit = 20) {
  const count = Math.min(100, Math.max(1, Number(limit || 20)));
  return cloneValue((state.history || []).slice(-count).reverse());
}

export function restoreMemeHistory(revisionId) {
  const revision = (state.history || []).find(item => item.id === String(revisionId || ""));
  if (!revision) return null;
  const current = findMemeByNameOrAlias(revision.term);
  appendMemeHistory(revision.term, "restore", current);
  if (!revision.before) {
    if (current) state.entries = state.entries.filter(item => item !== current);
    saveMemeStore();
    return { action: "removed", term: revision.term };
  }

  const restored = normalizeMemeEntry(revision.before);
  if (!restored) return null;
  if (current) Object.assign(current, restored);
  else state.entries.push(restored);
  clearTombstone(restored.name, true);
  saveMemeStore();
  return { action: "restored", entry: restored };
}

export function applyMemeUpdateBatch(entries, options = {}) {
  const now = Number(options.now || Date.now());
  const runId = String(options.runId || crypto.randomUUID());
  const rollback = [];
  let accepted = 0;
  let updated = 0;
  let skipped = 0;

  for (const input of Array.isArray(entries) ? entries : []) {
    const result = applySingleMemeUpdate(input, now);
    if (result.rollback) rollback.push(result.rollback);
    accepted += result.accepted;
    updated += result.updated;
    skipped += result.skipped;
  }

  if (rollback.length) {
    state.sync.rollback = {
      id: runId,
      createdAt: new Date(now).toISOString(),
      entries: rollback,
    };
  }
  if (rollback.length) saveMemeStore();
  return { runId, accepted, updated, skipped, changed: rollback.length };
}

function applySingleMemeUpdate(input, now) {
  const normalized = normalizeMemeEntry({
    ...input,
    source: "web-verified",
    status: "active",
    enabled: true,
  }, { now });
  if (!normalized) return updateResult("skipped");

  const existing = findMemeByNameOrAlias(normalized.name);
  const rollback = {
    name: existing?.name || normalized.name,
    before: existing ? cloneValue(existing) : null,
  };
  const before = existing ? entryFingerprint(existing) : "";
  const saved = upsertMeme(normalized, {
    now,
    preserveLocal: true,
    deferSave: true,
  });
  if (!saved) return updateResult("skipped");
  if (!existing) return { ...updateResult("accepted"), rollback };
  if (entryFingerprint(saved) !== before) return { ...updateResult("updated"), rollback };
  return updateResult("unchanged");
}

function updateResult(outcome) {
  return {
    accepted: outcome === "accepted" ? 1 : 0,
    updated: outcome === "updated" ? 1 : 0,
    skipped: outcome === "skipped" ? 1 : 0,
    rollback: null,
  };
}

export function rollbackLastMemeUpdate() {
  const rollback = state.sync?.rollback;
  if (!rollback?.entries?.length) return { restored: 0, runId: "" };
  let restored = 0;
  for (const item of rollback.entries) {
    const current = findMemeByNameOrAlias(item.name);
    if (!item.before) {
      if (current) {
        state.entries = state.entries.filter(entry => entry !== current);
        restored += 1;
      }
      continue;
    }
    const replacement = normalizeMemeEntry(item.before);
    if (!replacement) continue;
    if (current) Object.assign(current, replacement);
    else state.entries.push(replacement);
    restored += 1;
  }
  const runId = rollback.id;
  const run = (state.sync.runs || []).find(item => item.id === runId);
  if (run) {
    run.status = "rolled-back";
    run.rolledBackAt = new Date().toISOString();
  }
  state.sync.source = "public-web-trends-v1";
  state.sync.accepted = 0;
  state.sync.updated = 0;
  state.sync.rollback = null;
  saveMemeStore();
  return { restored, runId };
}

function loadMemeStore() {
  let loaded = readStoreFile(storePath);
  let recovered = false;

  if (!loaded.ok && loaded.exists) {
    preserveCorruptFile();
    const backup = readStoreFile(storePath + LAST_GOOD_SUFFIX);
    if (backup.ok) {
      loaded = backup;
      recovered = true;
      log("meme store recovered from last-good snapshot");
    } else {
      logE("meme store is unreadable; starting with a clean v3 store");
    }
  }

  const raw = loaded.ok ? loaded.value : createEmptyMemeStore(CFG.memeLearningMode);
  const fromVersion = Number(raw?.version || 1);
  const governanceRewrite = needsGovernanceRewrite(raw);
  if (loaded.ok && fromVersion < MEME_STORE_VERSION) preserveMigrationBackup(fromVersion);
  state = migrateMemeStore(raw, { mode: CFG.memeLearningMode });
  if (process.env.QQBOT_MEME_MODE) {
    state.mode = normalizeMemeMode(CFG.memeLearningMode);
  }
  ensureBuiltinMemes();

  if (fromVersion < MEME_STORE_VERSION || recovered || governanceRewrite) {
    dirty = true;
    flushMemeStoreSync();
  }
}

function needsGovernanceRewrite(raw) {
  const candidates = raw?.candidates || {};
  const migratedFrom = migratedStoreVersion(raw);
  if (Object.keys(candidates).length > MAX_CANDIDATES) return true;
  if (migratedFrom >= MEME_STORE_VERSION) return false;
  if (Number(raw?.stats?.promoted || 0) > 0) return true;
  return Object.values(candidates).some(candidate =>
    (candidate?.source || "auto") === "auto" && candidate?.status !== "quarantined"
  );
}

function migratedStoreVersion(raw) {
  if (raw?.migration?.fromVersion !== undefined) return Number(raw.migration.fromVersion);
  if (raw?.version !== undefined) return Number(raw.version);
  return 1;
}

function ensureBuiltinMemes() {
  let changed = false;
  for (const item of BUILTIN_MEMES) {
    if (isMemeTombstoned(state, item.name)) continue;
    if (findMemeByNameOrAlias(item.name)) continue;
    const entry = normalizeMemeEntry({
      ...item,
      source: "builtin",
      level: "S",
      enabled: true,
      status: "active",
    });
    if (!entry) continue;
    state.entries.push(entry);
    changed = true;
  }
  if (changed) saveMemeStore();
}

function readStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, exists: false, value: null };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return { ok: true, exists: true, value };
  } catch (error) {
    return { ok: false, exists: true, value: null, error };
  }
}

function preserveLastGoodFile() {
  const current = readStoreFile(storePath);
  if (!current.ok) return;
  fs.copyFileSync(storePath, storePath + LAST_GOOD_SUFFIX);
}

function preserveMigrationBackup(fromVersion) {
  try {
    const backupPath = storePath + ".v" + Number(fromVersion || 1) + "-backup.json";
    if (!fs.existsSync(backupPath)) fs.copyFileSync(storePath, backupPath);
  } catch (error) {
    logE("meme migration backup failed:", error.message);
  }
}

function preserveCorruptFile() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(storePath, storePath + ".corrupt-" + stamp + ".json");
  } catch (error) {
    logE("meme corrupt snapshot failed:", error.message);
  }
}

function removeCandidate(value) {
  const key = normalizeMemeKey(value);
  if (!key || !Object.prototype.hasOwnProperty.call(state.candidates, key)) return false;
  delete state.candidates[key];
  return true;
}

function enforceCandidateLimit() {
  const entries = Object.entries(state.candidates);
  if (entries.length <= MAX_CANDIDATES) return;
  entries.sort((left, right) => storedCandidateScore(right[1]) - storedCandidateScore(left[1]));
  state.candidates = Object.fromEntries(entries.slice(0, MAX_CANDIDATES));
}

function storedCandidateScore(candidate) {
  const active = candidate.status === "candidate" ? 2 : 0;
  const dictionary = candidate.source === "china-meme-dictionary" ? 1 : 0;
  const confidence = Number(candidate.confidence || 0);
  const recency = Date.parse(candidate.lastSeen || "") / 1e13 || 0;
  return active + dictionary + confidence + recency;
}

function clearTombstone(value, allowed) {
  if (!allowed) return;
  const key = normalizeMemeKey(value);
  state.tombstones = (state.tombstones || []).filter(item => item.key !== key);
}

function cancelSaveTimer() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

function entryKeys(entry) {
  return [entry.name, ...(entry.aliases || []), ...(entry.triggers || [])];
}

function mergeEvidence(left = {}, right = {}) {
  return {
    count: Math.max(Number(left.count || 0), Number(right.count || 0)),
    users: Math.max(Number(left.users || 0), Number(right.users || 0)),
    groups: Math.max(Number(left.groups || 0), Number(right.groups || 0)),
    contexts: Math.max(Number(left.contexts || 0), Number(right.contexts || 0)),
  };
}

function appendMemeHistory(term, action, before, now = Date.now()) {
  state.history = [
    ...(state.history || []),
    {
      id: crypto.randomUUID(),
      term: String(term || "").trim(),
      action: String(action || "edit").trim(),
      at: new Date(Number(now || Date.now())).toISOString(),
      before: before ? cloneValue(before) : null,
    },
  ].slice(-100);
}

function normalizeProtectedFields(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const allowed = new Set(ALL_EDITABLE_FIELDS);
  return [...new Set(source.map(String).filter(item => allowed.has(item)))];
}

function uniqueText(items, limit = 30) {
  return [...new Set(items.map(item => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function uniqueSources(items) {
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const key = String(item.url || `${item.platform || "web"}:${item.title || ""}`).trim();
    if (key) map.set(key, item);
  }
  return [...map.values()].slice(0, 12);
}

function earliestIso(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestIso(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function latestOptionalIso(left, right) {
  if (!left) return right || "";
  if (!right) return left || "";
  return latestIso(left, right);
}

function entryFingerprint(entry) {
  return JSON.stringify({
    name: entry?.name,
    aliases: entry?.aliases,
    triggers: entry?.triggers,
    meaning: entry?.meaning,
    usage: entry?.usage,
    examples: entry?.examples,
    sources: entry?.sources,
    confidence: entry?.confidence,
    status: entry?.status,
    expiresAt: entry?.expiresAt,
    lastVerifiedAt: entry?.lastVerifiedAt,
  });
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
