import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateUsage, tokenNumber, usageDimensions } from "../bridge/api-providers/usage-aggregate.mjs";

const MAX = 1_000_000_000;
const event = values => ({ kind: "usage", provider: "mimo", model: "test-model", task: "group_chat", ...values });

describe("usage aggregation coverage", () => {
  it("rejects oversized and unsafe persisted token numbers instead of clipping", () => {
    assert.equal(tokenNumber(MAX), MAX);
    for (const value of [MAX + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 0.5, "1"]) {
      assert.equal(tokenNumber(value), null);
    }
    const summary = aggregateUsage([event({ schema: 2, usageReported: true, promptReported: true,
      promptTokens: MAX + 1, completionReported: true, completionTokens: 3,
      totalReported: true, totalTokens: Number.MAX_SAFE_INTEGER + 1,
      cacheReported: true, cachedTokens: MAX, missTokens: 1 })]).summary;
    assert.equal(summary.calls, 1);
    assert.equal(summary.promptReportedCalls, 0);
    assert.equal(summary.completionReportedCalls, 1);
    assert.equal(summary.completionTokens, 3);
    assert.equal(summary.totalReportedCalls, 0);
    assert.equal(summary.cacheReportedCalls, 0);
  });

  it("keeps legacy zero placeholders unknown but retains positive reasoning", () => {
    const summary = aggregateUsage([
      event({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0,
        cachedTokens: 0, missTokens: 0, cacheReported: true }),
      event({ promptTokens: 10, completionTokens: 0, reasoningTokens: 2, totalTokens: 0,
        cachedTokens: 4, missTokens: 6, cacheReported: true }),
    ]).summary;
    assert.equal(summary.legacyCalls, 2);
    assert.equal(summary.usageReportedCalls, 1);
    assert.equal(summary.promptReportedCalls, 1);
    assert.equal(summary.completionReportedCalls, 0);
    assert.equal(summary.reasoningReportedCalls, 1);
    assert.equal(summary.reasoningTokens, 2);
    assert.equal(summary.totalReportedCalls, 0);
    assert.equal(summary.cacheReportedCalls, 1);
    assert.equal(summary.hitRate, 0.4);
  });

  it("honors schema 2 top-level suppression over every child count and flag", () => {
    const summary = aggregateUsage([event({ schema: 2, usageReported: false,
      promptReported: true, promptTokens: 100, completionReported: true, completionTokens: 20,
      reasoningReported: true, reasoningTokens: 5, totalReported: true, totalTokens: 120,
      cacheReported: true, cachedTokens: 80, missTokens: 20 })]).summary;
    assert.equal(summary.calls, 1);
    for (const field of ["usageReportedCalls", "promptReportedCalls", "completionReportedCalls",
      "reasoningReportedCalls", "totalReportedCalls", "cacheReportedCalls", "promptTokens",
      "completionTokens", "reasoningTokens", "totalTokens", "cachedTokens", "missTokens"]) {
      assert.equal(summary[field], 0, field);
    }
    assert.equal(summary.hitRate, null);
  });

  it("requires an explicit cache flag and two consistent original known sides", () => {
    const cases = [
      { cachedTokens: 4, missTokens: 6 },
      { cacheReported: true, cachedTokens: 4 },
      { cacheReported: true, cachedTokens: 4, missTokens: 5 },
      { cacheReported: true, cachedTokens: MAX + 1, missTokens: 6 },
      { cacheReported: true, cachedTokens: 4, missTokens: 6, promptTokens: MAX + 1 },
    ];
    for (const values of cases) {
      const summary = aggregateUsage([event({ schema: 2, usageReported: true, promptReported: true,
        promptTokens: 10, ...values })]).summary;
      assert.equal(summary.cacheReportedCalls, 0);
      assert.equal(summary.hitRate, null);
    }
    const valid = aggregateUsage([event({ schema: 2, usageReported: true, promptReported: true,
      promptTokens: 0, cacheReported: true, cachedTokens: 0, missTokens: 0 })]).summary;
    assert.equal(valid.promptReportedCalls, 1);
    assert.equal(valid.cacheReportedCalls, 1);
    assert.equal(valid.hitRate, null);
  });

  it("does not coerce malformed prompt fingerprints", () => {
    const malformed = { toString: null };
    assert.equal(usageDimensions({ promptFingerprint: malformed }).promptFingerprint, "");
    const result = aggregateUsage([event({ promptFingerprint: malformed })]);
    assert.equal(result.summary.calls, 1);
    assert.equal(result.rows[0].promptFingerprint, "");
  });
});
