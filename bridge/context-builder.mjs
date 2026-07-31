// bridge/context-builder.mjs — reserved reply context builder
import { recentHistoryWeighted } from "./context/history.mjs";
import { createDefaultRelationship, createDefaultRelationshipExports } from "./relationship.mjs";

export function buildReplyContext(options = {}) {
  const { group_id, userId } = options;
  const weighted = userId && group_id ? recentHistoryWeighted(userId, group_id) : { history: [], mood: "" };

  return {
    messages: weighted.history,
    mood: weighted.mood,
    debug: {},
    memoryRefs: [],
    relationship: createDefaultRelationship(),
    exports: createDefaultRelationshipExports(),
  };
}
