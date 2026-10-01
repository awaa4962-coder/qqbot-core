import { CFG } from "../config.mjs";
import { logE } from "../logger.mjs";
import { createJsonSaver, readJsonFile } from "../persistence/json-file.mjs";
import { redactMemoryTextFields } from "./privacy.mjs";

export const SAVE_DEBOUNCE_MS = 30000;

export const PROFILE_FILE = CFG.memoryProfileFile;

let needsRedactionSave = false;
let loadFailed = false;
let persistenceUnknown = false;
export const memoryProfiles = loadProfiles();

const saver = createJsonSaver(PROFILE_FILE, () => memoryProfiles, {
  debounceMs: SAVE_DEBOUNCE_MS,
  durable: true,
  onError: error => logE("saveMemoryProfiles failed:", error.message),
});
export function persistLoadedProfileRepairs() {
  if (needsRedactionSave && !loadFailed && !persistenceUnknown) { saver.markDirty(); needsRedactionSave = false; }
}

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
    if (!plainCollection(parsed) || ["userProfiles", "groupProfiles", "userGroupProfiles"].some(key => parsed[key] !== undefined && !plainCollection(parsed[key]))) {
      throw new Error("Invalid memory profile collections");
    }
    const profiles = {
      ...createRoot(),
      ...parsed,
      userProfiles: parsed.userProfiles || {},
      groupProfiles: parsed.groupProfiles || {},
      userGroupProfiles: parsed.userGroupProfiles || {},
    };
    needsRedactionSave = redactMemoryTextFields(profiles);
    return profiles;
  } catch {
    loadFailed = true;
    return createRoot();
  }
}

export function saveMemoryProfiles() {
  if (loadFailed || persistenceUnknown) return false;
  saver.markDirty();
  return true;
}

export function flushMemoryProfilesSync() {
  if (loadFailed || persistenceUnknown) return false;
  persistLoadedProfileRepairs();
  return saver.flushSync();
}

export function latchMemoryProfilePersistenceUnknown() {
  persistenceUnknown = true;
  // Cancel queued checkpoints and invalidate staged asynchronous writes until process replacement.
  saver.dispose();
}

export function memoryProfilesAvailable() { return !loadFailed && !persistenceUnknown; }

function plainCollection(value) { return value && typeof value === "object" && !Array.isArray(value); }
