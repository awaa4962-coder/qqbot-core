import { groupChats, users } from "../storage.mjs";
import { getPreferredDisplayName } from "../user-preferences.mjs";

export function resolveMentionDisplayName(qq, options = {}) {
  const mentionName = resolveMentionName(options.mention);
  if (mentionName) return mentionName;
  const uid = String(qq || "");
  if (!uid || uid === "all") return uid === "all" ? "@all" : "";
  const userStore = options.users || users;
  const chatStore = options.groupChats || groupChats;
  const groupId = String(options.groupId || options.group_id || "");
  const user = userStore[uid];
  const localName = resolveLocalName(uid, user, userStore);
  if (localName) return localName;
  const recentName = findRecentNickname(uid, groupId, chatStore);
  if (recentName) return recentName;
  return "QQ:" + uid;
}

function resolveMentionName(mention) {
  if (!mention) return "";
  return safeName(mention.displayName) ||
    safeName(mention.groupCard) ||
    safeName(mention.nickname);
}

function resolveLocalName(uid, user, userStore) {
  const preferred = getPreferredDisplayName(uid, "", { users: userStore });
  if (preferred && preferred !== "unknown") return preferred;
  const alias = safeName(user?.alias);
  if (alias) return alias;
  return lastSafe(user?.nicknames);
}

function findRecentNickname(uid, groupId, chatStore) {
  const groups = groupId && chatStore[groupId] ? [chatStore[groupId]] : Object.values(chatStore || {});
  for (const entries of groups) {
    if (!Array.isArray(entries)) continue;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (String(entry?.uid) !== uid) continue;
      const name = safeName(entry.nickname);
      if (name) return name;
    }
  }
  return "";
}

function lastSafe(values) {
  if (!Array.isArray(values)) return "";
  for (let i = values.length - 1; i >= 0; i--) {
    const value = safeName(values[i]);
    if (value) return value;
  }
  return "";
}

function safeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}
