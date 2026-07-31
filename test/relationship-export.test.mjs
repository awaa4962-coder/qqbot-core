import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReplyContext } from "../bridge/context-builder.mjs";
import {
  RELATIONSHIP_EXPORT_FIELDS,
  buildRelationshipRows,
  exportRelationshipCsv,
  exportRelationshipJson,
  exportRelationshipMarkdown,
} from "../bridge/relationship-export.mjs";
import { normalizeRelationship } from "../bridge/relationship.mjs";
import { buildStyleRoute } from "../bridge/style-router.mjs";

describe("relationship export reservation", () => {
  it("declares future export fields without building real rows", () => {
    assert.ok(RELATIONSHIP_EXPORT_FIELDS.includes("familiarity"));
    assert.ok(RELATIONSHIP_EXPORT_FIELDS.includes("affinity"));
    assert.deepEqual(buildRelationshipRows({}, { group_id: 1 }), []);
  });

  it("keeps reserved exporters inert", () => {
    assert.equal(exportRelationshipCsv([]), "");
    assert.equal(exportRelationshipMarkdown([]), "");
    assert.equal(exportRelationshipJson([{ user_id: "1" }]), '[\n  {\n    "user_id": "1"\n  }\n]');
  });

  it("normalizes scores without disallowed relationship fields", () => {
    const relation = normalizeRelationship({
      familiarity: 120,
      affinity: -1,
      confidence: 2,
      preferredTone: "playful",
    });
    assert.equal(relation.familiarity, 100);
    assert.equal(relation.affinity, 0);
    assert.equal(relation.confidence, 1);
    assert.equal(relation.preferredTone, "playful");
    assert.deepEqual(Object.keys(relation).sort(), [
      "affinity",
      "confidence",
      "familiarity",
      "humorTolerance",
      "interactionScore",
      "preferredTone",
      "styleMatch",
      "trustScore",
    ]);
  });

  it("reserves reply context relationship and export flags", () => {
    const ctx = buildReplyContext();
    assert.equal(ctx.relationship.familiarity, 0);
    assert.equal(ctx.relationship.affinity, 0);
    assert.equal(ctx.relationship.preferredTone, "normal");
    assert.equal(ctx.exports.relationshipRowsAvailable, false);
  });

  it("lets style-router receive relationship data without prompt debug", () => {
    const route = buildStyleRoute({ relationship: { preferredTone: "technical" } });
    assert.equal(route.preferredTone, "technical");
    assert.equal(route.relationshipAware, true);
    assert.equal(route.promptRelationshipDebug, false);
  });
});
