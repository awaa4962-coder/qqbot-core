// Stable public entrypoint; implementation is separated by responsibility.
export { memoryProfiles, saveMemoryProfiles, flushMemoryProfilesSync } from "./memory-profile/store.mjs";
export { isSensitiveMemoryText, observeMemoryEvent, clearUserMemoryProfile, clearGroupMemoryProfile, cleanupExpiredMemoryProfiles } from "./memory-profile/updates.mjs";
export { getActiveMemoryContext, getMemoryStatus } from "./memory-profile/query.mjs";
export { buildMemorySummary, buildHumanMemorySummary } from "./memory-profile/presentation.mjs";
