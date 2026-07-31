import {
  clearMemeCandidates as clearStoredMemeCandidates,
  deleteMeme,
  findMemeByNameOrAlias,
  flushMemeStoreSync,
  getMemeHistory,
  getMemeStore,
  researchMemeTerm,
  restoreMemeHistory,
  rollbackLastMemeUpdate,
  runMemeTrendUpdate,
  runMemeDecay,
  setMemeEnabled,
  setMemeMode,
  setMemeStatus,
  upsertMeme,
} from "../knowledge/memes/index.mjs";

const LEVELS = new Set(["S", "A", "B"]);
const MANUAL_FIELDS = new Set([
  "name", "aliases", "triggers", "meaning", "usage", "examples", "sources",
  "confidence", "semanticConfidence", "level", "enabled", "status", "scope",
]);
const MEME_ACTIONS = Object.freeze({
  save: payload => saveMemeEntry(payload.entry || payload),
  enable: payload => toggleMeme(payload.name || payload.query, true),
  disable: payload => toggleMeme(payload.name || payload.query, false),
  activate: payload => changeMemeStatus(payload.name || payload.query, "active"),
  quarantine: payload => changeMemeStatus(payload.name || payload.query, "quarantined"),
  delete: payload => deleteMemeEntry(payload.name || payload.query),
  "clear-candidates": () => clearMemeCandidates(),
  "set-mode": payload => changeMemeMode(payload.mode),
  decay: () => runDecay(),
  "run-web-update": payload => runWebUpdate(payload),
  "research-web": payload => researchWebEntry(payload),
  "rollback-web-update": () => rollbackWebUpdate(),
  "restore-history": payload => restoreHistory(payload.revisionId || payload.id),
});

export function buildMemeKnowledgeSnapshot() {
  const store = getMemeStore();
  const entries = Array.isArray(store.entries) ? store.entries : [];
  const candidates = publicCandidates(store.candidates);
  return {
    version: Number(store.version || 3),
    mode: store.mode || "steady",
    count: entries.length,
    entries: entries.map(publicEntry),
    candidates,
    candidateTotal: candidates.length,
    tombstoneCount: Array.isArray(store.tombstones) ? store.tombstones.length : 0,
    counts: countStatuses(entries, candidates),
    stats: {
      observedMessages: Number(store.stats?.observedMessages || 0),
      promoted: Number(store.stats?.promoted || 0),
      quarantined: Number(store.stats?.quarantined || 0),
    },
    sync: publicSync(store.sync),
    history: getMemeHistory(30).map(publicHistory),
    updateConfig: {
      source: "web-trends",
      policy: "周期更新只采纳多来源网页证据；MiMo 审核失败时由 DeepSeek 兜底。",
    },
    editableFields: [...MANUAL_FIELDS],
    privacy: "只展示词条与聚合证据，不展示群聊原文、QQ 号或原始图片文字。",
  };
}

export async function applyMemeKnowledgeAction(payload = {}) {
  const action = String(payload.action || "save").trim();
  const handler = MEME_ACTIONS[action];
  if (!handler) throw new Error("unknown meme action");
  return await handler(payload);
}

function saveMemeEntry(input) {
  const originalName = String(input?.originalName || "").trim();
  const existing = findMemeByNameOrAlias(originalName || input?.name);
  const entry = normalizeEditableEntry(input, existing);
  const nameMatch = findMemeByNameOrAlias(entry.name);
  if (nameMatch && existing && nameMatch !== existing) {
    throw new Error("another meme entry already uses this name or alias");
  }
  const saved = upsertMeme(entry, {
    lookupName: originalName || entry.name,
    markManual: true,
    manualFields: normalizeManualFields(input.manualFields),
    replaceManualFields: true,
    recordHistory: true,
    historyAction: existing ? "edit" : "create",
    restoreTombstone: true,
  });
  if (!saved) throw new Error("meme entry could not be saved");
  flushMemeStoreSync();
  return {
    ok: true,
    action: "save",
    entry: publicEntry(saved),
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function toggleMeme(name, enabled) {
  const entry = setMemeEnabled(requiredName(name), enabled, { recordHistory: true });
  if (!entry) throw new Error("meme entry not found");
  flushMemeStoreSync();
  return {
    ok: true,
    action: enabled ? "enable" : "disable",
    entry: publicEntry(entry),
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function changeMemeStatus(name, status) {
  const entry = setMemeStatus(requiredName(name), status, { recordHistory: true });
  if (!entry) throw new Error("meme entry not found");
  flushMemeStoreSync();
  return {
    ok: true,
    action: status,
    entry: publicEntry(entry),
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function changeMemeMode(mode) {
  const value = setMemeMode(mode);
  flushMemeStoreSync();
  return {
    ok: true,
    action: "set-mode",
    mode: value,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function runDecay() {
  const result = runMemeDecay();
  flushMemeStoreSync();
  return {
    ok: true,
    action: "decay",
    result,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function deleteMemeEntry(name) {
  const entry = deleteMeme(requiredName(name), { recordHistory: true });
  if (!entry) throw new Error("meme entry not found");
  flushMemeStoreSync();
  return {
    ok: true,
    action: "delete",
    deleted: publicEntry(entry),
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

async function runWebUpdate(payload) {
  const result = await runMemeTrendUpdate({
    force: true,
    limit: payload.limit,
  });
  if (!result.ok) throw new Error(result.error || result.reason || "联网更新失败");
  return {
    ok: true,
    action: "run-web-update",
    result,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

async function researchWebEntry(payload) {
  const query = requiredName(payload.query || payload.name || payload.term);
  const result = await researchMemeTerm(query, { save: false });
  return {
    ok: result.ok === true,
    action: "research-web",
    query,
    ...result,
    entry: result.entry ? publicEntry(result.entry) : null,
  };
}

function rollbackWebUpdate() {
  const result = rollbackLastMemeUpdate();
  if (!result.restored) throw new Error("没有可以回退的联网更新");
  flushMemeStoreSync();
  return {
    ok: result.restored > 0,
    action: "rollback-web-update",
    result,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function restoreHistoryRevision(revisionId) {
  const result = restoreMemeHistory(String(revisionId || ""));
  if (!result) throw new Error("meme history revision not found");
  flushMemeStoreSync();
  return {
    ok: true,
    action: "restore-history",
    result,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function restoreHistory(revisionId) {
  return restoreHistoryRevision(revisionId);
}

function clearMemeCandidates() {
  const cleared = clearStoredMemeCandidates();
  flushMemeStoreSync();
  return {
    ok: true,
    action: "clear-candidates",
    cleared,
    snapshot: buildMemeKnowledgeSnapshot(),
  };
}

function normalizeEditableEntry(input, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("meme entry must be an object");
  const name = requiredName(input.name);
  const aliases = normalizeTextList(input.aliases, 20);
  const triggers = normalizeTextList(input.triggers, 30);
  const meaning = normalizeLongText(input.meaning, "meaning", 220);
  const usage = normalizeLongText(input.usage, "usage", 220);
  const examples = normalizeExamples(input.examples);
  const sources = normalizeSources(input.sources);
  const confidence = normalizeConfidence(input.confidence);
  const level = normalizeLevel(input.level, confidence);
  const status = normalizeStatus(input.status, input.enabled);
  return {
    name,
    aliases,
    triggers: triggers.length ? triggers : [name],
    meaning,
    usage,
    examples,
    sources,
    confidence,
    semanticConfidence: confidence,
    level,
    enabled: status === "active",
    status,
    source: normalizeEntrySource(input.source, existing),
    scope: normalizeScope(input.scope ?? existing?.scope),
    lastVerifiedAt: textField(existing || {}, "lastVerifiedAt"),
    expiresAt: textField(existing || {}, "expiresAt"),
  };
}

function publicEntry(entry) {
  const source = entry || {};
  return {
    name: textField(source, "name"),
    aliases: safeArray(source.aliases),
    triggers: safeArray(source.triggers),
    meaning: textField(source, "meaning"),
    usage: textField(source, "usage"),
    examples: safeArray(source.examples),
    sources: publicSources(source.sources),
    confidence: numberField(source, "confidence"),
    semanticConfidence: numberField(source, "semanticConfidence"),
    frequencyConfidence: numberField(source, "frequencyConfidence"),
    level: textField(source, "level", "B"),
    enabled: source.enabled !== false,
    status: textField(source, "status", source.enabled === false ? "disabled" : "active"),
    source: textField(source, "source"),
    scope: publicScope(source.scope),
    evidence: publicEvidence(source.evidence),
    manualFields: safeArray(source.manualFields),
    manualProtected: safeArray(source.manualFields).length > 0,
    createdAt: textField(source, "createdAt"),
    updatedAt: textField(source, "updatedAt"),
    lastSeen: textField(source, "lastSeenAt", textField(source, "lastSeen")),
    lastVerifiedAt: textField(source, "lastVerifiedAt"),
    expiresAt: textField(source, "expiresAt"),
    seenCount: numberField(source, "seenCount"),
  };
}

function publicCandidates(candidates) {
  return Object.values(candidates || {})
    .map(item => ({
      term: String(item.term || ""),
      count: Number(item.count || 0),
      confidence: Number(item.confidence || 0),
      semanticConfidence: Number(item.semanticConfidence || 0),
      users: Array.isArray(item.userHashes) ? item.userHashes.length : 0,
      groups: Array.isArray(item.groupIds) ? item.groupIds.length : 0,
      contextCount: Array.isArray(item.contextSignatures) ? item.contextSignatures.length : 0,
      level: String(item.level || "B"),
      status: String(item.status || "candidate"),
      source: String(item.source || ""),
      reason: String(item.reason || ""),
      meaning: String(item.meaning || ""),
      firstSeen: String(item.firstSeen || ""),
      lastSeen: String(item.lastSeen || ""),
    }))
    .filter(item => item.term)
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count);
}

function countStatuses(entries, candidates) {
  return {
    active: entries.filter(item => item.status === "active" && item.enabled !== false).length,
    quarantined: entries.filter(item => item.status === "quarantined").length,
    disabled: entries.filter(item => item.status === "disabled").length,
    stale: entries.filter(item => item.status === "stale").length,
    candidate: candidates.filter(item => item.status === "candidate").length,
    candidateQuarantined: candidates.filter(item => item.status === "quarantined").length,
  };
}

function publicScope(scope) {
  if (!scope || scope.type !== "groups") return { type: "global", groupIds: [], groupCount: 0 };
  const groupIds = safeArray(scope.groupIds);
  return {
    type: "groups",
    groupIds,
    groupCount: groupIds.length,
  };
}

function publicSources(value) {
  return (Array.isArray(value) ? value : []).map(item => ({
    platform: textField(item || {}, "platform", "web"),
    url: textField(item || {}, "url"),
    title: textField(item || {}, "title"),
    snippet: textField(item || {}, "snippet"),
    kind: textField(item || {}, "kind", "web"),
    fetchedAt: textField(item || {}, "fetchedAt"),
    publishedAt: textField(item || {}, "publishedAt"),
  }));
}

function publicHistory(revision) {
  return {
    id: textField(revision || {}, "id"),
    term: textField(revision || {}, "term"),
    action: textField(revision || {}, "action", "edit"),
    at: textField(revision || {}, "at"),
    before: revision?.before ? publicEntry(revision.before) : null,
  };
}

function publicSync(value) {
  const sync = value || {};
  return {
    source: textField(sync, "source", "web-trends"),
    lastAttemptAt: textField(sync, "lastAttemptAt"),
    lastSuccessAt: textField(sync, "lastSuccessAt"),
    accepted: numberField(sync, "accepted"),
    updated: numberField(sync, "updated"),
    review: numberField(sync, "review"),
    skipped: numberField(sync, "skipped"),
    durationMs: numberField(sync, "durationMs"),
    runId: textField(sync, "runId"),
    sources: sync.sources && typeof sync.sources === "object" ? { ...sync.sources } : {},
    runs: Array.isArray(sync.runs) ? sync.runs.map(item => ({ ...item })) : [],
    rollbackAvailable: Boolean(sync.rollback?.entries?.length),
    rollbackId: textField(sync.rollback || {}, "id"),
    rollbackCount: Array.isArray(sync.rollback?.entries) ? sync.rollback.entries.length : 0,
    error: textField(sync, "error"),
  };
}

function publicEvidence(evidence) {
  const value = evidence || {};
  return {
    count: Number(value.count || 0),
    users: Number(value.users || 0),
    groups: Number(value.groups || 0),
    contexts: Number(value.contexts || 0),
  };
}

function requiredName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 40 || /[\r\n\t]/.test(text)) throw new Error("invalid meme name");
  return text;
}

function normalizeTextList(value, limit) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\s,;，；、]+/);
  const result = [];
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;
    if (text.length > 40 || /[\r\n\t]/.test(text)) throw new Error("invalid meme list item");
    if (!result.includes(text)) result.push(text);
  }
  if (result.length > limit) throw new Error("too many meme list items");
  return result;
}

function normalizeLongText(value, field, maxLen) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(field + " cannot be empty");
  if (text.length > maxLen) throw new Error(field + " too long");
  return text;
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.6;
  if (number > 1 && number <= 100) return Number((number / 100).toFixed(3));
  return Math.min(1, Math.max(0, Number(number.toFixed(3))));
}

function normalizeLevel(value, confidence) {
  if (LEVELS.has(value)) return value;
  return confidence >= 0.8 ? "A" : "B";
}

function normalizeEntrySource(value, existing) {
  return String(value || existing?.source || "manual").trim().slice(0, 40) || "manual";
}

function normalizeExamples(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const result = [...new Set(source.map(item =>
    String(item || "").replace(/\s+/g, " ").trim()
  ).filter(Boolean))];
  if (result.length > 8) throw new Error("too many meme examples");
  if (result.some(item => item.length > 220)) throw new Error("meme example too long");
  return result;
}

function normalizeSources(value) {
  const source = Array.isArray(value) ? value : [];
  if (source.length > 12) throw new Error("too many meme sources");
  return source.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid meme source");
    }
    const url = normalizeHttpUrl(item.url);
    const title = String(item.title || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!url && !title) throw new Error("meme source needs a title or URL");
    return {
      platform: String(item.platform || "manual").trim().slice(0, 40) || "manual",
      url,
      title,
      snippet: String(item.snippet || "").replace(/\s+/g, " ").trim().slice(0, 280),
      kind: item.kind === "web" ? "web" : "manual",
      fetchedAt: String(item.fetchedAt || ""),
      publishedAt: String(item.publishedAt || ""),
    };
  });
}

function normalizeScope(value) {
  if (!value || value.type !== "groups") return { type: "global", groupIds: [] };
  const groupIds = normalizeTextList(value.groupIds, 30)
    .filter(item => /^\d{5,20}$/.test(item));
  return { type: "groups", groupIds };
}

function normalizeStatus(value, enabled) {
  if (["quarantined", "disabled", "stale"].includes(value)) return value;
  if (enabled === false) return "disabled";
  return "active";
}

function normalizeManualFields(value) {
  const source = Array.isArray(value) ? value : [...MANUAL_FIELDS];
  return [...new Set(source.map(String).filter(field => MANUAL_FIELDS.has(field)))];
}

function normalizeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid source protocol");
    return url.href;
  } catch {
    throw new Error("invalid meme source URL");
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

function textField(source, field, fallback = "") {
  return String(source[field] || fallback);
}

function numberField(source, field) {
  return Number(source[field] || 0);
}
