import { CFG } from "../config.mjs";
import { logE } from "../logger.mjs";
import { createJsonSaver, readJsonFile } from "../persistence/json-file.mjs";

export const SAVE_DEBOUNCE_MS = 30000;

export const PROFILE_FILE = CFG.memoryProfileFile;

export const memoryProfiles = loadProfiles();

const saver = createJsonSaver(PROFILE_FILE, () => memoryProfiles, {
  debounceMs: SAVE_DEBOUNCE_MS,
  onError: error => logE("saveMemoryProfiles failed:", error.message),
});

export function createRoot() {
  return {
    userProfiles: {},
    groupProfiles: {},
    userGroupProfiles: {},
  };
}

export function loadProfiles() {
  try {
    const parsed = readJsonFile(PROFILE_FILE, {}, { maxBytes: 64 * 1024 * 1024 });
    return {
      ...createRoot(),
      ...parsed,
      userProfiles: parsed.userProfiles || {},
      groupProfiles: parsed.groupProfiles || {},
      userGroupProfiles: parsed.userGroupProfiles || {},
    };
  } catch {
    return createRoot();
  }
}

export function saveMemoryProfiles() {
  saver.markDirty();
}

export function flushMemoryProfilesSync() {
  saver.flushSync();
}
