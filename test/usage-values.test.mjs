import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as messageConvert from "../bridge/api-providers/message-convert.mjs";
import { normalizeProviderUsage, normalizeUsage } from "../bridge/api-providers/usage-values.mjs";

const MAX = 1_000_000_000;
const EMPTY = {
  promptTokens: 0,
  cachedTokens: 0,
  missTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cacheReported: false,
  usageReported: false,
  promptReported: false,
  completionReported: false,
  reasoningReported: false,
  totalReported: false,
};
const INVALID = [
  undefined, null, "", " \t\n", false, true, -1, -Infinity, NaN, Infinity, 0.5, 1.5,
  "1.5", "1e3", "+1", "-1", "0x10", "NaN", "Infinity", "1 0", [], [1], {}, 1n, Symbol("count"),
];

describe("pure provider usage values", () => {
  it("re-exports the same wire authority without dropping message helpers", () => {
    assert.equal(messageConvert.normalizeUsage, normalizeUsage);
    assert.deepEqual(Object.keys(messageConvert).sort(), [
      "contentAsText", "normalizeUsage", "normalizedRaw", "openAiToolCalls", "parseDataImage", "splitSystemMessages",
    ]);
  });

  it("keeps absent and malformed usage unknown through every conversion", () => {
    for (const input of [undefined, null, {}, [], "", "0", false, true, 0, 1, NaN, Infinity, 1n]) {
      checkUsage(input, EMPTY);
    }
    checkUsage({
      prompt_tokens: null,
      completion_tokens: false,
      total_tokens: "",
      completion_tokens_details: { reasoning_tokens: undefined },
      prompt_cache_hit_tokens: null,
      prompt_cache_miss_tokens: false,
      usage_reported: true,
      prompt_reported: true,
      completion_reported: true,
      reasoning_reported: true,
      total_reported: true,
      cache_reported: true,
    }, EMPTY);
  });

  it("preserves genuinely reported zero instead of treating it as missing", () => {
    for (const zero of [0, -0, "0", "000", " 0 "]) {
      checkUsage({
        prompt_tokens: zero,
        completion_tokens: zero,
        total_tokens: zero,
        prompt_cache_hit_tokens: zero,
        completion_tokens_details: { reasoning_tokens: zero },
      }, {
        ...EMPTY,
        cacheReported: true,
        usageReported: true,
        promptReported: true,
        completionReported: true,
        reasoningReported: true,
        totalReported: true,
      });
    }
  });

  it("retains DeepSeek cache-hit and cache-miss semantics", () => {
    checkUsage({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 25,
    }, completeUsage(100, 20, { cachedTokens: 75, missTokens: 25, cacheReported: true }));
  });

  it("retains OpenAI and MiMo cached and reasoning details", () => {
    checkUsage({
      prompt_tokens: 80, completion_tokens: 15,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 5 },
    }, completeUsage(80, 15, {
      cachedTokens: 60, missTokens: 20, cacheReported: true, reasoningTokens: 5, reasoningReported: true,
    }));
  });

  it("retains Responses input, output, cache and reasoning details", () => {
    checkUsage({
      input_tokens: 50, output_tokens: 10,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 4 },
    }, completeUsage(50, 10, {
      cachedTokens: 40, missTokens: 10, cacheReported: true, reasoningTokens: 4, reasoningReported: true,
    }));
  });

  it("includes Anthropic base, read and creation input exactly once", () => {
    checkUsage({
      input_tokens: "10", cache_read_input_tokens: "90", cache_creation_input_tokens: "20", output_tokens: "5",
    }, completeUsage(120, 5, { cachedTokens: 90, missTokens: 30, cacheReported: true }));
  });

  it("does not equate Anthropic creation with a cache read of zero", () => {
    const raw = { input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5 };
    checkUsage(raw, completeUsage(30, 5));
    checkUsage({ ...raw, cache_read_input_tokens: 0 }, completeUsage(30, 5, {
      missTokens: 30, cacheReported: true,
    }));
    checkUsage({ input_tokens: 10, cache_read_input_tokens: 90 }, {
      ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
      cachedTokens: 90, missTokens: 10, cacheReported: true,
    });
    checkUsage({ cache_creation_input_tokens: 20, cache_read_input_tokens: 90 }, EMPTY);
  });

  it("keeps invalid Anthropic input components incomplete", () => {
    for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      for (const value of INVALID.filter(item => item !== undefined)) {
        checkUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 5,
          [field]: value }, {
          ...EMPTY, completionTokens: 5, completionReported: true, usageReported: true,
        });
      }
    }
  });

  it("adds Gemini thoughts to candidates only once", () => {
    checkUsage({
      promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 5, thoughtsTokenCount: 20,
      totalTokenCount: 125,
    }, completeUsage(100, 25, {
      cachedTokens: 80, missTokens: 20, cacheReported: true, reasoningTokens: 20, reasoningReported: true,
    }));
    checkUsage({ promptTokenCount: 10, candidatesTokenCount: 5 }, completeUsage(10, 5));
    checkUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0 },
      completeUsage(10, 5, { reasoningReported: true }));
  });

  it("does not turn Gemini reasoning-only or malformed output into complete output", () => {
    checkUsage({ thoughtsTokenCount: 20 }, {
      ...EMPTY, reasoningTokens: 20, reasoningReported: true, usageReported: true,
    });
    checkUsage({ promptTokenCount: 10, thoughtsTokenCount: 20, totalTokenCount: 35 }, {
      ...EMPTY, promptTokens: 10, reasoningTokens: 20, totalTokens: 35,
      promptReported: true, reasoningReported: true, totalReported: true, usageReported: true,
    });
    for (const value of INVALID.filter(item => item !== undefined)) {
      checkUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: value }, {
        ...EMPTY, promptTokens: 10, promptReported: true, usageReported: true,
      });
      checkUsage({ candidatesTokenCount: value, thoughtsTokenCount: 20 }, {
        ...EMPTY, reasoningTokens: 20, reasoningReported: true, usageReported: true,
      });
    }
  });

  it("validates numeric values consistently across provider aliases", () => {
    const fields = [
      "prompt_tokens", "promptTokens", "input_tokens", "promptTokenCount",
      "completion_tokens", "completionTokens", "output_tokens", "candidatesTokenCount",
      "reasoning_tokens", "reasoningTokens", "thoughtsTokenCount",
      "total_tokens", "totalTokens", "totalTokenCount",
    ];
    for (const field of fields) {
      for (const value of INVALID) checkUsage({ [field]: value }, EMPTY);
    }
    for (const field of ["completion_tokens_details", "output_tokens_details"]) {
      for (const value of INVALID) checkUsage({ [field]: { reasoning_tokens: value } }, EMPTY);
    }
    checkUsage({ prompt_tokens: " 00100 ", completion_tokens: "20", reasoning_tokens: "03" },
      completeUsage(100, 20, { reasoningTokens: 3, reasoningReported: true }));
  });

  it("treats out-of-range counts and sums as unknown without fabricating reported values", () => {
    checkUsage({ prompt_tokens: MAX + 1, completion_tokens: "2000000000", reasoning_tokens: Number.MAX_VALUE },
      EMPTY);
    checkUsage({ input_tokens: Number.MAX_VALUE, cache_creation_input_tokens: Number.MAX_VALUE, output_tokens: 1 },
      { ...EMPTY, completionTokens: 1, completionReported: true, usageReported: true });
    checkUsage({ promptTokenCount: 1, candidatesTokenCount: Number.MAX_VALUE, thoughtsTokenCount: Number.MAX_VALUE },
      { ...EMPTY, promptTokens: 1, promptReported: true, usageReported: true });
    checkUsage({ total_tokens: "9".repeat(400) }, EMPTY);
    checkUsage({ total_tokens: MAX + 1 }, EMPTY);
    checkUsage({ prompt_tokens: MAX, completion_tokens: 1 }, {
      ...EMPTY, promptTokens: MAX, completionTokens: 1,
      promptReported: true, completionReported: true, usageReported: true,
    });
    checkUsage({ prompt_tokens: MAX - 1, completion_tokens: 1 }, completeUsage(MAX - 1, 1));
    checkUsage({ input_tokens: MAX, cache_read_input_tokens: 1 }, EMPTY);
    checkUsage({ candidatesTokenCount: MAX, thoughtsTokenCount: 1 }, {
      ...EMPTY, reasoningTokens: 1, reasoningReported: true, usageReported: true,
    });
    for (const value of [MAX + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
      String(MAX + 1), String(Number.MAX_SAFE_INTEGER + 1)]) {
      checkUsage({ prompt_tokens: value }, EMPTY);
    }
  });

  it("derives totals only from known input and output, including known zero", () => {
    checkUsage({ prompt_tokens: 7 }, { ...EMPTY, promptTokens: 7, promptReported: true, usageReported: true });
    checkUsage({ completion_tokens: 7 }, {
      ...EMPTY, completionTokens: 7, completionReported: true, usageReported: true,
    });
    checkUsage({ reasoning_tokens: 0 }, { ...EMPTY, reasoningReported: true, usageReported: true });
    checkUsage({ total_tokens: 0 }, { ...EMPTY, totalReported: true, usageReported: true });
    checkUsage({ prompt_tokens: 0 }, { ...EMPTY, promptReported: true, usageReported: true });
    checkUsage({ completion_tokens: 0 }, { ...EMPTY, completionReported: true, usageReported: true });
    checkUsage({ prompt_tokens: 7, completion_tokens: 0 }, completeUsage(7, 0));
    for (const value of INVALID) {
      checkUsage({ prompt_tokens: 7, completion_tokens: value }, {
        ...EMPTY, promptTokens: 7, promptReported: true, usageReported: true,
      });
      checkUsage({ prompt_tokens: value, completion_tokens: 7 }, {
        ...EMPTY, completionTokens: 7, completionReported: true, usageReported: true,
      });
      checkUsage({ prompt_tokens: 7, completion_tokens: 3, total_tokens: value }, completeUsage(7, 3));
    }
  });

  it("keeps explicit valid totals even when components are unknown or different", () => {
    checkUsage({ total_tokens: "15" }, { ...EMPTY, totalTokens: 15, totalReported: true, usageReported: true });
    checkUsage({ prompt_tokens: 10, total_tokens: 15 }, {
      ...EMPTY, promptTokens: 10, totalTokens: 15, promptReported: true, totalReported: true, usageReported: true,
    });
    checkUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 0 },
      completeUsage(10, 5, { totalTokens: 0 }));
  });

  it("infers the opposite cache side only from known input and a valid measurement", () => {
    for (const raw of [
      { prompt_cache_hit_tokens: 75 }, { prompt_cache_miss_tokens: 25 },
      { prompt_tokens_details: { cached_tokens: 75 } }, { input_tokens_details: { cached_tokens: 75 } },
      { cache_read_input_tokens: 75 }, { cachedContentTokenCount: 75 }, { cachedTokens: 75 }, { missTokens: 25 },
    ]) {
      checkUsage({ prompt_tokens: 100, ...raw }, {
        ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
        cachedTokens: 75, missTokens: 25, cacheReported: true,
      });
      checkUsage(raw, EMPTY);
    }
    checkUsage({ prompt_tokens: 100 }, { ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true });
    for (const hit of [0, 100]) {
      checkUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: hit }, {
        ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
        cachedTokens: hit, missTokens: 100 - hit, cacheReported: true,
      });
      checkUsage({ prompt_tokens: 100, prompt_cache_miss_tokens: hit }, {
        ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
        cachedTokens: 100 - hit, missTokens: hit, cacheReported: true,
      });
    }
  });

  it("rejects null, invalid, contradictory or out-of-range cache data", () => {
    const promptOnly = { ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true };
    for (const value of INVALID) {
      for (const raw of [
        { prompt_cache_hit_tokens: value }, { prompt_cache_miss_tokens: value },
        { prompt_tokens_details: { cached_tokens: value } }, { input_tokens_details: { cached_tokens: value } },
        { cache_read_input_tokens: value }, { cachedContentTokenCount: value },
      ]) checkUsage({ prompt_tokens: 100, ...raw }, promptOnly);
    }
    for (const value of INVALID.filter(item => item !== undefined)) {
      checkUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: value, prompt_cache_miss_tokens: 25 }, promptOnly);
      checkUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: value }, promptOnly);
    }
    for (const raw of [
      { prompt_cache_hit_tokens: 101 }, { prompt_cache_miss_tokens: 101 },
      { prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 24 },
      { prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 26 },
      { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 100 },
      { prompt_cache_hit_tokens: 99.9, prompt_cache_miss_tokens: 0.1 },
      { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 },
    ]) checkUsage({ prompt_tokens: 100, ...raw }, promptOnly);
    checkUsage({ prompt_tokens: 0, prompt_cache_hit_tokens: 1 }, {
      ...EMPTY, promptReported: true, usageReported: true,
    });
  });

  it("does not turn clipping or fraction rounding into fabricated full cache hits", () => {
    const promptOnly = { ...EMPTY, promptTokens: MAX, promptReported: true, usageReported: true };
    checkUsage({ prompt_tokens: MAX, prompt_cache_hit_tokens: MAX + 1 }, promptOnly);
    for (const raw of [
      { prompt_tokens: MAX + 1, prompt_cache_hit_tokens: MAX + 2 },
      { prompt_tokens: MAX + 1, prompt_cache_hit_tokens: MAX },
      { prompt_tokens: 2 * MAX, prompt_cache_hit_tokens: MAX, prompt_cache_miss_tokens: MAX },
      { prompt_tokens: 2 * MAX, prompt_cache_hit_tokens: 2 * MAX },
    ]) checkUsage(raw, EMPTY);
    checkUsage({ prompt_tokens: 100.5, prompt_cache_hit_tokens: 100 }, EMPTY);
    checkUsage({ prompt_tokens: MAX, prompt_cache_hit_tokens: MAX }, {
      ...promptOnly, cachedTokens: MAX, cacheReported: true,
    });
  });

  it("honors false wire and camel flags without allowing true flags to invent counts", () => {
    const raw = {
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      reasoning_tokens: 5, prompt_cache_hit_tokens: 75,
    };
    const complete = completeUsage(100, 20, {
      cachedTokens: 75, missTokens: 25, cacheReported: true, reasoningTokens: 5, reasoningReported: true,
    });
    for (const flag of ["usage_reported", "usageReported"]) checkUsage({ ...raw, [flag]: false }, EMPTY);
    for (const flag of ["prompt_reported", "promptReported"]) checkUsage({ ...raw, [flag]: false }, {
      ...complete, promptTokens: 0, promptReported: false, cachedTokens: 0, missTokens: 0, cacheReported: false,
    });
    for (const flag of ["completion_reported", "completionReported"]) checkUsage({ ...raw, [flag]: false }, {
      ...complete, completionTokens: 0, completionReported: false,
    });
    for (const flag of ["reasoning_reported", "reasoningReported"]) checkUsage({ ...raw, [flag]: false }, {
      ...complete, reasoningTokens: 0, reasoningReported: false,
    });
    for (const flag of ["total_reported", "totalReported"]) checkUsage({ ...raw, [flag]: false }, {
      ...complete, totalTokens: 0, totalReported: false,
    });
    for (const flag of ["cache_reported", "cacheReported"]) checkUsage({ ...raw, [flag]: false }, {
      ...complete, cachedTokens: 0, missTokens: 0, cacheReported: false,
    });
    for (const stem of ["usage", "prompt", "completion", "reasoning", "total", "cache"]) {
      checkUsage({ [stem + "_reported"]: true }, EMPTY);
      checkUsage({ [stem + "Reported"]: true }, EMPTY);
    }
    checkUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_reported: false }, {
      ...EMPTY, completionTokens: 20, completionReported: true, usageReported: true,
    });
    checkUsage({ prompt_tokens: 100, completion_tokens: 20, completionReported: false }, {
      ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
    });
  });

  it("preserves canonical precedence, including zero and invalid values", () => {
    checkUsage({ prompt_tokens: 0, input_tokens: 10, promptTokenCount: 20,
      completion_tokens: 0, output_tokens: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
    completeUsage(0, 0, { reasoningTokens: 5, reasoningReported: true }));
    checkUsage({ prompt_tokens: null, input_tokens: 10, completion_tokens: false, output_tokens: 20 }, EMPTY);
    checkUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: null, prompt_tokens_details: { cached_tokens: 100 } }, {
      ...EMPTY, promptTokens: 100, promptReported: true, usageReported: true,
    });
  });

  it("does not mutate inputs or share mutable output details", () => {
    const raw = Object.freeze({
      prompt_tokens: 100, completion_tokens: 20,
      prompt_tokens_details: Object.freeze({ cached_tokens: 50 }),
      completion_tokens_details: Object.freeze({ reasoning_tokens: 5 }),
    });
    const first = normalizeUsage(raw);
    const second = normalizeUsage(raw);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.completion_tokens_details, second.completion_tokens_details);
    first.completion_tokens_details.reasoning_tokens = 999;
    assert.equal(raw.completion_tokens_details.reasoning_tokens, 5);
    assert.equal(second.completion_tokens_details.reasoning_tokens, 5);
  });
});

function completeUsage(promptTokens, completionTokens, overrides = {}) {
  return {
    ...EMPTY, promptTokens, completionTokens, totalTokens: Math.min(MAX, promptTokens + completionTokens),
    usageReported: true, promptReported: true, completionReported: true, totalReported: true,
    ...overrides,
  };
}

function checkUsage(raw, expected) {
  const camel = normalizeProviderUsage(raw);
  const wire = normalizeUsage(raw);
  assert.deepEqual(camel, expected);
  assert.deepEqual(wire, {
    prompt_tokens: expected.promptTokens,
    completion_tokens: expected.completionTokens,
    total_tokens: expected.totalTokens,
    cache_reported: expected.cacheReported,
    prompt_cache_hit_tokens: expected.cachedTokens,
    prompt_cache_miss_tokens: expected.missTokens,
    completion_tokens_details: { reasoning_tokens: expected.reasoningTokens },
    usage_reported: expected.usageReported,
    prompt_reported: expected.promptReported,
    completion_reported: expected.completionReported,
    reasoning_reported: expected.reasoningReported,
    total_reported: expected.totalReported,
  });
  for (const value of [wire, camel, JSON.parse(JSON.stringify(wire)), JSON.parse(JSON.stringify(camel))]) {
    assert.deepEqual(normalizeUsage(value), wire);
    assert.deepEqual(normalizeProviderUsage(value), camel);
  }
  for (const field of ["promptTokens", "cachedTokens", "missTokens", "completionTokens", "reasoningTokens", "totalTokens"]) {
    assert.ok(Number.isInteger(camel[field]) && camel[field] >= 0 && camel[field] <= MAX);
  }
  if (camel.cacheReported) {
    assert.equal(camel.promptReported, true);
    assert.equal(camel.cachedTokens + camel.missTokens, camel.promptTokens);
  } else {
    assert.equal(camel.cachedTokens, 0);
    assert.equal(camel.missTokens, 0);
  }
}
