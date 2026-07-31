// bridge/relationship-export.mjs — reserved relationship export surface
import { RELATIONSHIP_EXPORT_FIELDS } from "./relationship.mjs";

export { RELATIONSHIP_EXPORT_FIELDS };

export function buildRelationshipRows(_storage, _options = {}) {
  return [];
}

export function exportRelationshipCsv(_rows) {
  return "";
}

export function exportRelationshipJson(rows) {
  return JSON.stringify(Array.isArray(rows) ? rows : [], null, 2);
}

export function exportRelationshipMarkdown(_rows) {
  return "";
}
