import { users, groupChats } from "../storage.mjs";
import { createMemorySourceGraph } from "./source-exclusions.mjs";

const scopeKey = ({ groupId, userId }) => groupId === "private" ? "private:" + userId : "group:" + groupId;

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
