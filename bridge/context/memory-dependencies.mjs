export const MAX_MEMORY_DEPENDENCIES = 32;

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
