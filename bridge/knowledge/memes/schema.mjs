import crypto from "node:crypto";

export const MEME_STORE_VERSION = 3;
export const MEME_MODES = Object.freeze(["off", "shadow", "steady"]);
export const MEME_STATUSES = Object.freeze([
  "active",
  "candidate",
  "pending",
  "quarantined",
  "disabled",
  "stale",
]);
export const GLOBAL_SCOPE = Object.freeze({ type: "global", groupIds: [] });
const MAX_MEME_CANDIDATES = 500;
const MAX_MEME_HISTORY = 100;

const MANUAL_FIELDS = Object.freeze([
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

export function createEmptyMemeStore(mode = "steady", now = Date.now()) {
  return {
    version: MEME_STORE_VERSION,
    mode: normalizeMemeMode(mode),
    privacySalt: crypto.randomBytes(16).toString("hex"),
    entries: [],
    candidates: {},
    tombstones: [],
    history: [],
    stats: {
      observedMessages: 0,
      promoted: 0,
      quarantined: 0,
      contextMatches: 0,
    },
    sync: {
      source: "public-web-trends-v1",
      lastAttemptAt: "",
      lastSuccessAt: "",
      etag: "",
      lastModified: "",
      contentHash: "",
      accepted: 0,
      updated: 0,
      review: 0,
      skipped: 0,
      durationMs: 0,
      runId: "",
      sources: {},
      runs: [],
      rollback: null,
      error: "",
    },
    migration: {
      migratedAt: new Date(now).toISOString(),
      fromVersion: MEME_STORE_VERSION,
    },
  };
}

export function migrateMemeStore(raw, options = {}) {
  const now = Number(firstValue(options.now, Date.now()));
  const source = objectValue(raw);
  const sourceVersion = Number(firstValue(source.version, 1));
  const legacy = sourceVersion < MEME_STORE_VERSION;
  const state = createEmptyMemeStore(firstValue(source.mode, options.mode, "steady"), now);
  state.privacySalt = validSalt(source.privacySalt) || state.privacySalt;
  migrateCandidates(state, source.candidates, now);
  migrateEntries(state, source.entries, legacy, now);
  state.tombstones = normalizeTombstones(source.tombstones, source.deletedBuiltins, now);
  state.history = normalizeHistory(source.history);
  const legacyLineage = legacy || migrationFromVersion(source) < MEME_STORE_VERSION;
  state.stats = normalizeStats(source.stats, legacyLineage);
  state.sync = legacy ? state.sync : normalizeSyncState(source.sync);
  state.migration = migrationState(source, legacy, sourceVersion, now);
  quarantineLegacyCandidates(state, legacyLineage);
  if (sourceVersion < MEME_STORE_VERSION) state.candidates = {};
  removeCandidatesForActiveEntries(state);
  limitCandidates(state);
  return state;
}

export function normalizeMemeEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const name = cleanText(entry.name, 40);
  if (!name) return null;
  const source = cleanText(firstValue(entry.source, "auto"), 40);
  const candidate = firstValue(options.candidate, {});
  const legacyAuto = options.legacy && source === "auto";
  const legacyExternal = options.legacy &&
    ["auto", "china-meme-dictionary"].includes(source);
  const scope = normalizeMemeScope(entry.scope, {
    source,
    candidateGroups: firstValue(candidate.groupIds, candidate.groups, []),
  });
  let status = normalizeEntryStatus(entry.status, entry.enabled);
  if (legacyExternal || (source === "auto" && scope.type === "groups" && !scope.groupIds.length)) {
    status = "quarantined";
  }
  const scores = entryScores(entry, candidate, source, legacyAuto);
  const times = entryTimes(entry, candidate, options.now);
  const manualFields = normalizeManualFields(entry.manualFields, source);
  return {
    name,
    aliases: uniqueText(entry.aliases, 20, name),
    triggers: uniqueText([...(arrayValue(entry.triggers)), name], 30),
    meaning: cleanText(
      firstValue(entry.meaning, "群内常用表达，具体含义需要结合当前语境判断。"),
      220,
    ),
    usage: cleanText(
      firstValue(entry.usage, "只在当前对话明显玩梗时辅助理解，不主动硬复读。"),
      220,
    ),
    examples: normalizeExamples(entry.examples),
    sources: normalizeMemeSources(entry.sources, entry.upstream),
    ...scores,
    source,
    level: normalizeLevel(entry.level, scores.confidence),
    enabled: entry.enabled !== false && status === "active",
    status,
    scope,
    manualFields,
    evidence: normalizeEntryEvidence(entry.evidence, candidate),
    upstream: normalizeUpstream(entry.upstream),
    ...times,
  };
}

function migrateCandidates(state, candidates, now) {
  for (const [key, candidate] of Object.entries(normalizeCandidateMap(candidates))) {
    const normalized = normalizeMemeCandidate(candidate, { key, now, salt: state.privacySalt });
    if (normalized) state.candidates[normalizeMemeKey(normalized.term)] = normalized;
  }
}

function migrateEntries(state, entries, legacy, now) {
  const source = Array.isArray(entries) ? entries : [];
  for (const entry of source) {
    const candidate = state.candidates[normalizeMemeKey(field(entry, "name"))];
    const normalized = normalizeMemeEntry(entry, { candidate, legacy, now });
    if (normalized) state.entries.push(normalized);
  }
}

function migrationState(source, legacy, sourceVersion, now) {
  const nowIso = new Date(now).toISOString();
  const migration = objectValue(source.migration);
  return {
    migratedAt: legacy ? nowIso : validIso(migration.migratedAt, nowIso),
    fromVersion: legacy
      ? sourceVersion
      : Number(firstValue(migration.fromVersion, MEME_STORE_VERSION)),
  };
}

function entryScores(entry, candidate, source, legacyAuto) {
  const confidence = clampNumber(entry.confidence, 0, 1, sourceConfidence(source));
  const semanticFallback = source === "auto"
    ? (legacyAuto ? 0.35 : confidence)
    : confidence;
  return {
    confidence,
    frequencyConfidence: clampNumber(
      entry.frequencyConfidence,
      0,
      1,
      firstValue(candidate.confidence, confidence),
    ),
    semanticConfidence: clampNumber(entry.semanticConfidence, 0, 1, semanticFallback),
  };
}

function entryTimes(entry, candidate, now) {
  const nowIso = new Date(Number(firstValue(now, Date.now()))).toISOString();
  const firstSeenAt = validIso(
    firstValue(entry.firstSeenAt, entry.createdAt, candidate.firstSeen),
    nowIso,
  );
  const lastSeenAt = validIso(
    firstValue(entry.lastSeenAt, entry.lastSeen, entry.updatedAt, candidate.lastSeen),
    firstSeenAt,
  );
  const lastVerifiedAt = validIso(
    firstValue(entry.lastVerifiedAt, entry.verifiedAt),
    "",
  );
  const expiresAt = validIso(entry.expiresAt, "");
  return {
    firstSeenAt,
    lastSeenAt,
    lastVerifiedAt,
    expiresAt,
    seenCount: Math.max(0, integer(firstValue(entry.seenCount, candidate.count), 0)),
    createdAt: validIso(entry.createdAt, firstSeenAt),
    updatedAt: validIso(entry.updatedAt, lastSeenAt),
  };
}

export function normalizeMemeCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const term = cleanText(candidate.term || options.key, 40);
  if (!term) return null;
  const nowIso = new Date(Number(options.now || Date.now())).toISOString();
  const salt = options.salt || "";
  const userHashes = uniqueRaw(
    arrayValue(candidate.userHashes).length
      ? candidate.userHashes
      : arrayValue(candidate.users).map(value => hashMemeEvidence(value, salt)),
    40,
  );
  const groupIds = uniqueRaw(candidate.groupIds || candidate.groups, 30);
  const contextSignatures = uniqueRaw(
    arrayValue(candidate.contextSignatures).length
      ? candidate.contextSignatures
      : arrayValue(candidate.contexts).map(value => hashMemeEvidence(normalizeEvidenceText(value), salt)),
    20,
  );

  return {
    term,
    count: Math.max(0, integer(candidate.count, 0)),
    userHashes,
    groupIds,
    contextSignatures,
    firstSeen: validIso(candidate.firstSeen, nowIso),
    lastSeen: validIso(candidate.lastSeen, nowIso),
    confidence: clampNumber(candidate.confidence, 0, 1, 0),
    semanticConfidence: clampNumber(candidate.semanticConfidence, 0, 1, 0),
    level: normalizeLevel(candidate.level, candidate.confidence),
    source: cleanText(candidate.source || "auto", 40) || "auto",
    status: normalizeCandidateStatus(candidate.status),
    reason: cleanText(candidate.reason, 180),
    meaning: cleanText(candidate.meaning, 180),
    reviewAttempts: Math.max(0, integer(candidate.reviewAttempts, 0)),
    retryAfter: validIso(candidate.retryAfter, ""),
  };
}

export function normalizeMemeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MEME_MODES.includes(mode) ? mode : "steady";
}

export function normalizeMemeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

export function normalizeMemeScope(scope, options = {}) {
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const type = scope.type === "groups" ? "groups" : "global";
    const groupIds = type === "groups" ? uniqueRaw(scope.groupIds, 30) : [];
    return { type, groupIds };
  }
  if (options.source === "auto") {
    return { type: "groups", groupIds: uniqueRaw(options.candidateGroups, 30) };
  }
  return { ...GLOBAL_SCOPE };
}

export function hashMemeEvidence(value, salt = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return crypto
    .createHash("sha256")
    .update("qqfriend-meme-v2:" + salt + ":" + text)
    .digest("hex")
    .slice(0, 20);
}

export function isActiveMemeEntry(entry, mode = "steady") {
  if (!entry || entry.enabled === false || entry.status !== "active") return false;
  if (normalizeMemeMode(mode) === "off") return false;
  if (
    normalizeMemeMode(mode) === "shadow" &&
    !["manual", "builtin"].includes(entry.source)
  ) return false;
  return true;
}

export function isMemeTombstoned(state, value) {
  const key = normalizeMemeKey(value);
  return Boolean(key && (state?.tombstones || []).some(item => item.key === key));
}

export function makeMemeTombstone(entry, now = Date.now()) {
  return {
    key: normalizeMemeKey(entry?.name),
    name: cleanText(entry?.name, 40),
    source: cleanText(entry?.source || "unknown", 40),
    deletedAt: new Date(now).toISOString(),
  };
}

function normalizeEntryStatus(value, enabled) {
  if (["quarantined", "disabled", "stale"].includes(value)) return value;
  if (enabled === false) return "disabled";
  return "active";
}

function normalizeCandidateStatus(value) {
  if (value === "pending") return "candidate";
  return ["candidate", "quarantined"].includes(value) ? value : "candidate";
}

function normalizeStats(stats, legacyLineage) {
  const source = stats && typeof stats === "object" && !Array.isArray(stats) ? stats : {};
  return {
    observedMessages: Math.max(0, integer(source.observedMessages, 0)),
    promoted: legacyLineage ? 0 : Math.max(0, integer(source.promoted, 0)),
    quarantined: Math.max(0, integer(source.quarantined, 0)),
    contextMatches: Math.max(0, integer(source.contextMatches, 0)),
  };
}

function normalizeSyncState(sync) {
  const source = sync && typeof sync === "object" && !Array.isArray(sync) ? sync : {};
  return {
    source: cleanText(source.source || "public-web-trends-v1", 80),
    lastAttemptAt: validIso(source.lastAttemptAt, ""),
    lastSuccessAt: validIso(source.lastSuccessAt, ""),
    etag: cleanText(source.etag, 160),
    lastModified: cleanText(source.lastModified, 160),
    contentHash: /^[a-f0-9]{64}$/i.test(String(source.contentHash || ""))
      ? String(source.contentHash).toLowerCase()
      : "",
    accepted: Math.max(0, integer(source.accepted, 0)),
    updated: Math.max(0, integer(source.updated, 0)),
    review: Math.max(0, integer(source.review, 0)),
    skipped: Math.max(0, integer(source.skipped, 0)),
    durationMs: Math.max(0, integer(source.durationMs, 0)),
    runId: cleanText(source.runId, 80),
    sources: normalizeSourceStatuses(source.sources),
    runs: normalizeSyncRuns(source.runs),
    rollback: normalizeUpdateRollback(source.rollback),
    error: cleanText(source.error, 180),
  };
}

function normalizeEntryEvidence(evidence, candidate) {
  const source = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
  return {
    count: Math.max(0, integer(source.count ?? candidate?.count, 0)),
    users: Math.max(0, integer(source.users, candidate?.userHashes?.length || 0)),
    groups: Math.max(0, integer(source.groups, candidate?.groupIds?.length || 0)),
    contexts: Math.max(0, integer(source.contexts, candidate?.contextSignatures?.length || 0)),
  };
}

function normalizeManualFields(value, source) {
  if (source === "manual") return [...MANUAL_FIELDS];
  const allowed = new Set(MANUAL_FIELDS);
  return uniqueRaw(value, MANUAL_FIELDS.length).filter(item => allowed.has(item));
}

function normalizeUpstream(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = cleanText(value.source, 80);
  if (!source) return null;
  return {
    source,
    sourceId: cleanText(value.sourceId, 80),
    sourceUrl: cleanText(value.sourceUrl, 240),
    updatedAt: validIso(value.updatedAt, ""),
  };
}

function normalizeExamples(value) {
  return uniqueRaw(value, 8)
    .map(item => cleanText(item, 220))
    .filter(Boolean);
}

export function normalizeMemeSources(value, legacyUpstream = null) {
  const raw = Array.isArray(value)
    ? [...value]
    : (value && typeof value === "object" ? [value] : []);
  if (!raw.length && legacyUpstream) raw.push({
    platform: legacyUpstream.source,
    url: legacyUpstream.sourceUrl,
    title: legacyUpstream.sourceId,
    fetchedAt: legacyUpstream.updatedAt,
  });
  const normalized = raw
    .map(normalizeMemeSource)
    .filter(Boolean);
  return [...new Map(normalized.map(item => [sourceIdentity(item), item])).values()].slice(0, 12);
}

function normalizeMemeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = normalizeHttpUrl(value.url || value.sourceUrl);
  const title = cleanText(value.title || value.sourceId, 160);
  const platform = cleanText(value.platform || value.source || "web", 40) || "web";
  if (!url && !title) return null;
  return {
    platform,
    url,
    title,
    snippet: cleanText(value.snippet, 280),
    kind: ["web", "manual"].includes(value.kind) ? value.kind : "web",
    fetchedAt: validIso(value.fetchedAt || value.updatedAt, ""),
    publishedAt: validIso(value.publishedAt, ""),
  };
}

function sourceIdentity(source) {
  return source.url || `${source.platform}:${normalizeMemeKey(source.title)}`;
}

function normalizeSourceStatuses(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, status] of Object.entries(value).slice(0, 20)) {
    const name = cleanText(key, 40);
    if (!name) continue;
    const item = objectValue(status);
    output[name] = {
      ok: item.ok === true,
      count: Math.max(0, integer(item.count, 0)),
      fetchedAt: validIso(item.fetchedAt, ""),
      error: cleanText(item.error, 160),
    };
  }
  return output;
}

function normalizeSyncRuns(value) {
  return arrayValue(value)
    .slice(-20)
    .map(item => {
      const source = objectValue(item);
      const id = cleanText(source.id, 80);
      if (!id) return null;
      return {
        id,
        startedAt: validIso(source.startedAt, ""),
        finishedAt: validIso(source.finishedAt, ""),
        durationMs: Math.max(0, integer(source.durationMs, 0)),
        status: ["success", "partial", "failed", "skipped", "rolled-back"].includes(source.status)
          ? source.status
          : "failed",
        rolledBackAt: validIso(source.rolledBackAt, ""),
        accepted: Math.max(0, integer(source.accepted, 0)),
        updated: Math.max(0, integer(source.updated, 0)),
        review: Math.max(0, integer(source.review, 0)),
        skipped: Math.max(0, integer(source.skipped, 0)),
        error: cleanText(source.error, 180),
      };
    })
    .filter(Boolean);
}

function normalizeUpdateRollback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanText(value.id, 80);
  const entries = arrayValue(value.entries)
    .slice(0, 100)
    .map(item => {
      const source = objectValue(item);
      const name = cleanText(source.name || source.before?.name, 40);
      if (!name) return null;
      return {
        name,
        before: source.before ? normalizeMemeEntry(source.before) : null,
      };
    })
    .filter(Boolean);
  if (!id || !entries.length) return null;
  return {
    id,
    createdAt: validIso(value.createdAt, ""),
    entries,
  };
}

function normalizeHistory(value) {
  return arrayValue(value)
    .slice(-MAX_MEME_HISTORY)
    .map(item => {
      const source = objectValue(item);
      const id = cleanText(source.id, 80);
      const term = cleanText(source.term || source.before?.name, 40);
      if (!id || !term) return null;
      return {
        id,
        term,
        action: cleanText(source.action || "edit", 40),
        at: validIso(source.at, ""),
        before: source.before ? normalizeMemeEntry(source.before) : null,
      };
    })
    .filter(Boolean);
}

function normalizeTombstones(tombstones, deletedBuiltins, now) {
  const items = Array.isArray(tombstones) ? tombstones : [];
  const legacy = arrayValue(deletedBuiltins).map(name => ({
    key: normalizeMemeKey(name),
    name: cleanText(name, 40),
    source: "builtin",
    deletedAt: new Date(now).toISOString(),
  }));
  const merged = [...items, ...legacy]
    .map(item => ({
      key: normalizeMemeKey(item?.key || item?.name),
      name: cleanText(item?.name || item?.key, 40),
      source: cleanText(item?.source || "unknown", 40),
      deletedAt: validIso(item?.deletedAt, new Date(now).toISOString()),
    }))
    .filter(item => item.key);
  return [...new Map(merged.map(item => [item.key, item])).values()];
}

function removeCandidatesForActiveEntries(state) {
  for (const entry of state.entries) {
    if (entry.status !== "active") continue;
    delete state.candidates[normalizeMemeKey(entry.name)];
  }
}

function quarantineLegacyCandidates(state, required) {
  if (!required) return;
  for (const candidate of Object.values(state.candidates)) {
    if (candidate.source !== "auto") continue;
    candidate.status = "quarantined";
    candidate.reason = candidate.reason || "旧版候选已隔离，需要人工确认或重新学习。";
    candidate.retryAfter = "";
  }
}

function limitCandidates(state) {
  const entries = Object.entries(state.candidates);
  if (entries.length <= MAX_MEME_CANDIDATES) return;
  entries.sort((left, right) => candidateRetentionScore(right[1]) - candidateRetentionScore(left[1]));
  state.candidates = Object.fromEntries(entries.slice(0, MAX_MEME_CANDIDATES));
}

function candidateRetentionScore(candidate) {
  const active = candidate.status === "candidate" ? 2 : 0;
  const dictionary = candidate.source === "china-meme-dictionary" ? 1 : 0;
  const confidence = Number(candidate.confidence || 0);
  const recency = Date.parse(candidate.lastSeen || "") / 1e13 || 0;
  return active + dictionary + confidence + recency;
}

function migrationFromVersion(source) {
  const migration = objectValue(source.migration);
  return Number(firstValue(migration.fromVersion, source.version, 1));
}

function normalizeCandidateMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeLevel(level, confidence) {
  if (["S", "A", "B"].includes(level)) return level;
  return Number(confidence || 0) >= 0.82 ? "A" : "B";
}

function sourceConfidence(source) {
  if (source === "builtin") return 0.98;
  if (source === "manual") return 0.95;
  if (source === "web-verified") return 0.9;
  if (source === "china-meme-dictionary") return 0.55;
  if (source === "auto") return 0.35;
  return 0.5;
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href.slice(0, 500) : "";
  } catch {
    return "";
  }
}

function normalizeEvidenceText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function uniqueText(value, limit, excluded = "") {
  const excludedKey = normalizeMemeKey(excluded);
  return uniqueRaw(value, limit)
    .map(item => cleanText(item, 40))
    .filter(item => item && normalizeMemeKey(item) !== excludedKey);
}

function uniqueRaw(value, limit) {
  return [...new Set(arrayValue(value).map(item => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[\s,;，；、]+/);
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Number(number.toFixed(3))));
}

function validIso(value, fallback) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function validSalt(value) {
  const salt = String(value || "");
  return /^[a-f0-9]{32,128}$/i.test(salt) ? salt : "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function field(source, key) {
  return source && typeof source === "object" ? source[key] : undefined;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return values.at(-1);
}
