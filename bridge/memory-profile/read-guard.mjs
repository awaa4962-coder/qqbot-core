import { memoryReadMetadata } from "./notes.mjs";
import { getMemoryPrivacyGeneration } from "./generation.mjs";
import { normalizeMemoryDependencies, normalizeMemoryExpiry } from "../context/memory-dependencies.mjs";
import { sourceMessageParents, normalizeSourceMessageIds } from "./source-exclusions.mjs";

export function bindLayerMemoryReferences(layers, scope) {
  let metadata;
  try { metadata = memoryReadMetadata(scope, { withLinks: true }); } catch { metadata = null; }
  const lookup = sourceLookup(metadata);
  return layers.map(layer => {
    const sources = layer.contextSources || [];
    if (sources.some(source => normalizeSourceMessageIds(source.memorySourceIds) === null)) return { ...layer, contextMemorySources: null };
    if (!metadata && sources.length) return { ...layer, contextMemorySources: null };
    const matched = sources.flatMap(lookup);
    if (matched.some(item => !item.active)) return { ...layer, contextMemorySources: null };
    const inherited = layer.contextMemorySources === undefined ? [] : layer.contextMemorySources;
    const deps = Array.isArray(inherited) ? normalizeMemoryDependencies([...inherited,
      ...matched.map(({ noteId, revision }) => ({ noteId, revision }))]) : null;
    return { ...layer, contextMemorySources: deps };
  });
}

function sourceLookup(metadata) {
  const byMessage = new Map();
  for (const item of metadata?.entries || []) {
    if (item.messageId) byMessage.set(item.messageId, [...(byMessage.get(item.messageId) || []), item]);
  }
  const links = new Map();
  for (const item of metadata?.links || []) links.set(item.messageId, [...(links.get(item.messageId) || []), item]);
  return source => {
    const matched = [];
    const seen = new Set();
    const queue = [source];
    // Only explicit source links carry dependencies; similar wording is not provenance.
    for (let index = 0; index < queue.length; index++) {
      const row = queue[index];
      const id = row.messageId;
      const key = String(row.userId || "") + ":" + id;
      if (!id || seen.has(key)) continue;
      seen.add(key);
      matched.push(...(byMessage.get(id) || []).filter(item => !row.userId || item.userId === row.userId));
      const parents = [row, ...(links.get(id) || []).filter(item => !row.userId || item.userId === row.userId)];
      for (const parent of parents) for (const messageId of sourceMessageParents(parent)) {
        if (messageId) queue.push({ messageId });
      }
    }
    return matched;
  };
}

export function createMemoryReadGuard(scope = {}, options = {}) {
  const now = options.now || Date.now;
  const read = options.read || memoryReadMetadata;
  const privacy = getMemoryPrivacyGeneration();
  let dependencies = [];
  let expiresAt = Infinity;
  let readAt = null;
  let invalid = "";

  function reason() {
    if (invalid) return invalid;
    if (privacy !== getMemoryPrivacyGeneration()) return (invalid = "privacy_changed");
    if (expiresAt === Infinity) return "";
    const current = now();
    if (!Number.isSafeInteger(current) || current < readAt) return (invalid = "memory_unavailable");
    if (current >= expiresAt) return (invalid = "memory_expired");
    readAt = current;
    return "";
  }

  function track(value = []) {
    const merged = normalizeMemoryDependencies([...dependencies, ...(Array.isArray(value) ? value : [null])]);
    if (!merged) { invalid = "memory_unavailable"; return; }
    if (!merged.length || reason()) return;
    try {
      const current = now();
      if (!Number.isSafeInteger(current) || current <= 0) throw new Error("invalid_time");
      const groupId = scope.surface === "private" ? "private" : String(scope.groupId);
      const entries = read({ userId: String(scope.userId), groupId }).entries;
      expiresAt = Math.min(expiresAt, earliestExpiry(merged, entries, current));
      dependencies = merged;
      readAt = current;
    } catch (error) { invalid = error.code === "MEMORY_EXPIRED" ? "memory_expired" : "memory_unavailable"; }
  }

  function assertCurrent() {
    const problem = reason();
    if (problem) throw Object.assign(new Error(problem), { code: "CHAT_MEMORY_CHANGED" });
  }
  function limitUntil(value) {
    const expiry = normalizeMemoryExpiry(value);
    if (expiry === null || reason()) return;
    const current = now();
    if (!Number.isFinite(expiry) || !Number.isSafeInteger(current) || current <= 0) { invalid = "memory_unavailable"; return; }
    expiresAt = Math.min(expiresAt, expiry);
    readAt = current;
  }
  return { track, limitUntil, reason, assertCurrent, sources: () => dependencies.map(item => ({ ...item })),
    expiry: () => expiresAt === Infinity ? null : expiresAt };
}

function earliestExpiry(sources, entries, now) {
  const byId = new Map(entries.map(item => [item.noteId, item]));
  return Math.min(...sources.map(source => {
    const entry = byId.get(source.noteId);
    if (!entry || entry.revision !== source.revision || !Number.isSafeInteger(entry.expiresAt)) throw new Error("invalid_source");
    if (entry.expiresAt <= now) throw Object.assign(new Error("expired_source"), { code: "MEMORY_EXPIRED" });
    if (!entry.active) throw new Error("invalid_source");
    return entry.expiresAt;
  }));
}
