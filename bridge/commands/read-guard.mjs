import { CFG } from "../config.mjs";
import { canUsePrivateChat, isAdminUser } from "./permissions.mjs";
import { messageRouteRejection } from "../event-admission.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../memory-profile/generation.mjs";
import { createMemoryReadGuard } from "../memory-profile/read-guard.mjs";
import { isRelationshipCommand } from "../relationship-commands.mjs";

export function isPersonalReadCommand(cmd) {
  return isRelationshipCommand(cmd) || ["我的档案", "my-profile", "回复风格 推荐"].includes(cmd) || /^memory summary \d+$/.test(cmd);
}

// Read-only command builders and their sender share this guard across every await/chunk.
export function createPersonalReadGuard(options = {}) {
  const cfg = options.cfg || CFG;
  const surface = options.surface || (options.groupId && options.groupId !== "private" ? "group" : "private");
  const scope = { surface, userId: options.userId, groupId: options.groupId };
  const memory = createMemoryReadGuard(scope);
  const privacy = options.contextPrivacyGeneration ?? getMemoryPrivacyGeneration();
  const targets = new Map();
  let stopped = "";
  function trackTarget(uid, context = {}) {
    const key = String(uid);
    if (!targets.has(key)) targets.set(key, getUserMemoryGeneration(key));
    for (const profile of Object.values(context)) if (profile) memory.limitUntil(profile.expiresAt);
  }
  function stopReason() {
    if (stopped) return stopped;
    if (privacy !== getMemoryPrivacyGeneration()) stopped = "privacy_changed";
    else if ([...targets].some(([uid, revision]) => revision !== getUserMemoryGeneration(uid))) stopped = "preferences_changed";
    else if (!permitted(scope, cfg, options.admins) || (isAdminSummary(options) && !isAdminUser(scope.userId, options.admins || cfg.adminUins || []))) stopped = "permission_changed";
    else stopped = memory.reason();
    return stopped;
  }
  return { trackTarget, stopReason, expiry: memory.expiry };
}

function isAdminSummary(options) { return /^memory summary \d+$/.test(options.commandText || ""); }

function permitted(scope, cfg, admins) {
  if (!/^[1-9]\d{0,19}$/.test(String(scope.userId || ""))) return false;
  if (scope.surface === "group" && !/^[1-9]\d{0,19}$/.test(String(scope.groupId || ""))) return false;
  if (messageRouteRejection({ message_type: scope.surface, user_id: scope.userId, group_id: scope.groupId }, cfg)) return false;
  return scope.surface !== "private" || canUsePrivateChat(scope.userId, cfg) || isAdminUser(scope.userId, admins || cfg.adminUins || []);
}
