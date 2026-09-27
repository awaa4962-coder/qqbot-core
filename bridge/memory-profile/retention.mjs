import { users, groupChats } from "../storage.mjs";
import { createMemorySourceGraph } from "./source-exclusions.mjs";

const scopeKey = ({ groupId, userId }) => groupId === "private" ? "private:" + userId : "group:" + groupId;

// Scope-wide link metadata may outlive the shared buffer in another member's archive.
export function storedScopeSourceLinks({ userId, groupId }) {
  const links = [];
  const append = (rows, owner) => {
    if (!Array.isArray(rows)) throw new Error("memory_source_store_unavailable");
    for (const row of rows) {
      if (!row || [row.group, row.groupId, row.group_id].some(id => id !== undefined && String(id) !== groupId)) continue;
      if (owner && [row.uid, row.userId, row.user_id].some(id => id !== undefined && String(id) !== owner)) continue;
      const messageId = sourceId(row.messageId);
      if (messageId) links.push({ userId: owner || String(row.uid || ""), messageId, replyToMessageId: sourceId(row.replyToMessageId),
        turnId: sourceId(row.turnId), retracted: row.retracted === true, memorySourceIds: row.memorySourceIds });
    }
  };
  if (groupId !== "private") append(groupChats[groupId] || []);
  for (const [owner, user] of Object.entries(users)) {
    if (groupId === "private" && owner !== userId) continue;
    if (user?.chats === undefined) continue;
    if (!Array.isArray(user.chats)) throw new Error("memory_source_store_unavailable");
    append(user.chats.filter(row => String(row?.group) === groupId), owner);
  }
  return links;
}

function sourceId(value) { return /^-?\d{1,20}$/.test(String(value ?? "")) ? String(value) : ""; }

// Build once per mutation/prune. Peer-owned archives can outlive the shared group window.
export function storedMemorySourceIndex() {
  const records = new Map();
  const append = (scope, rows) => {
    if (!Array.isArray(rows)) throw new Error("memory_source_store_unavailable");
    const key = scopeKey(scope);
    if (!records.has(key)) records.set(key, []);
    records.get(key).push(...rows);
  };
  for (const [groupId, rows] of Object.entries(groupChats)) {
    if (groupId !== "private") append({ groupId }, rows);
  }
  for (const [userId, user] of Object.entries(users)) {
    if (user?.chats === undefined) continue;
    if (!Array.isArray(user.chats)) throw new Error("memory_source_store_unavailable");
    for (const row of user.chats) {
      if (row?.group) append({ userId, groupId: String(row.group) }, [row]);
    }
  }
  const graphs = new Map();
  for (const [key, rows] of records) graphs.set(key, createMemorySourceGraph(rows));
  return {
    has: source => graphs.get(scopeKey(source))?.references.has(source.messageId) || false,
    expand: (scope, ids) => graphs.get(scopeKey(scope))?.expand(ids) || new Set(ids),
  };
}
