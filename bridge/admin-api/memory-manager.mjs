import { CFG } from "../config.mjs";
import { memoryNotesSnapshot, applyMemoryNoteAction, normalizeNoteScope } from "../memory-profile/notes.mjs";
import { recentTopicEvidence } from "../memory-profile/evidence.mjs";
import { getUserPreferences, formatStyle } from "../user-preferences.mjs";

export function buildMemoryManagerSnapshot(payload = {}) {
  const scope = allowedScope(payload);
  const snapshot = memoryNotesSnapshot(scope);
  const preferences = getUserPreferences(scope.userId);
  return { ...snapshot, preferences: { displayName: preferences.displayName, styleText: formatStyle(preferences.style) },
    inferences: recentTopicEvidence(scope.userId, scope.groupId).map(({ label, sourceCount, latestAt }) => ({ label, sourceCount, latestAt })) };
}

export function applyMemoryManagerAction(payload = {}) {
  const scope = allowedScope(payload);
  applyMemoryNoteAction({ ...payload, ...scope }, { origin: "operator" });
  return buildMemoryManagerSnapshot(scope);
}

function allowedScope(payload) {
  const scope = normalizeNoteScope(payload);
  if (scope.groupId !== "private" && !CFG.groupWhitelist.map(String).includes(scope.groupId)) {
    throw Object.assign(new Error("该群不在当前群白名单内，未读取或修改记忆。"), { statusCode: 403 });
  }
  return scope;
}
