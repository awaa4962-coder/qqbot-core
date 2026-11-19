export const MAX_MEMORY_DEPENDENCIES = 32;

export function normalizeMemoryExpiry(value) {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) && value > 0 && value < 8640000000000000 ? value : NaN;
}

export function earliestMemoryExpiry(...values) {
  const deadlines = values.map(normalizeMemoryExpiry).filter(value => value !== null);
  return deadlines.length ? Math.min(...deadlines) : null;
}

// Dependency metadata is lossless: unknown, contradictory or oversized sets cannot become [].
export function normalizeMemoryDependencies(value) {
  if (!Array.isArray(value) || value.length > 512) return null;
  const found = new Map();
  for (const item of value) {
    if (!item || typeof item.noteId !== "string" || !/^[a-f0-9]{12}$/.test(item.noteId) ||
        !Number.isSafeInteger(item.revision) || item.revision < 1) return null;
    if (found.has(item.noteId) && found.get(item.noteId) !== item.revision) return null;
    found.set(item.noteId, item.revision);
    if (found.size > MAX_MEMORY_DEPENDENCIES) return null;
  }
  return [...found].map(([noteId, revision]) => ({ noteId, revision }));
}

// A missing list on a stored group turn means its image provenance is unknown.
export function normalizeHistoricalImageSources(value) {
  if (!Array.isArray(value) || value.length > 512) return null;
  const sources = new Map();
  for (const item of value) {
    if (!validImageSource(item)) return null;
    const { kind, userId, messageId, at } = item;
    sources.set(JSON.stringify([kind, userId, messageId, at]), { kind, userId, messageId, at });
    if (sources.size > MAX_MEMORY_DEPENDENCIES) return null;
  }
  return [...sources.values()];
}

function validImageSource(item) {
  return item && (item.kind === "recent" || item.kind === "quote") && typeof item.userId === "string" &&
    /^\d{1,20}$/.test(item.userId) && typeof item.messageId === "string" && /^-?\d{1,20}$/.test(item.messageId) &&
    Number.isSafeInteger(item.at) && item.at > 0;
}
