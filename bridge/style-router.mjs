// bridge/style-router.mjs — reserved relationship-aware style hints
import { normalizeRelationship } from "./relationship.mjs";

export function buildStyleRoute(options = {}) {
  const relationship = normalizeRelationship(options.relationship);
  return {
    preferredTone: relationship.preferredTone,
    relationshipAware: true,
    promptRelationshipDebug: false,
  };
}
