const MAX_TOKEN_VALUE = 1_000_000_000;

// Unknown counts use zero placeholders; false flags survive either representation.
export function normalizeUsage(input = {}) {
  let raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (!reported(raw, "usage_reported", "usageReported")) raw = {};

  const prompt = reported(raw, "prompt_reported", "promptReported") ? promptCount(raw) : null;
  const completion = reported(raw, "completion_reported", "completionReported") ? completionCount(raw) : null;
  const reasoning = reported(raw, "reasoning_reported", "reasoningReported") ? reasoningCount(raw) : null;
  const total = reported(raw, "total_reported", "totalReported") ?
    tokenCount(firstDefined(raw.total_tokens, raw.totalTokens, raw.totalTokenCount)) ?? sumKnown(prompt, completion) : null;
  const cache = cacheCounts(raw, prompt);

  return {
    prompt_tokens: knownOrZero(prompt),
    completion_tokens: knownOrZero(completion),
    total_tokens: knownOrZero(total),
    cache_reported: cache !== null,
    prompt_cache_hit_tokens: cache?.hit ?? 0,
    prompt_cache_miss_tokens: cache?.miss ?? 0,
    completion_tokens_details: { reasoning_tokens: knownOrZero(reasoning) },
    usage_reported: [prompt, completion, reasoning, total].some(count => count !== null),
    prompt_reported: prompt !== null,
    completion_reported: completion !== null,
    reasoning_reported: reasoning !== null,
    total_reported: total !== null,
  };
}

// This is a naming projection, not a second normalization implementation.
export function normalizeProviderUsage(input = {}) {
  const usage = normalizeUsage(input);
  return {
    promptTokens: usage.prompt_tokens,
    cachedTokens: usage.prompt_cache_hit_tokens,
    missTokens: usage.prompt_cache_miss_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details.reasoning_tokens,
    totalTokens: usage.total_tokens,
    cacheReported: usage.cache_reported,
    usageReported: usage.usage_reported,
    promptReported: usage.prompt_reported,
    completionReported: usage.completion_reported,
    reasoningReported: usage.reasoning_reported,
    totalReported: usage.total_reported,
  };
}

function promptCount(raw) {
  const direct = firstDefined(raw.prompt_tokens, raw.promptTokens);
  if (direct !== undefined) return tokenCount(direct);
  if (raw.input_tokens !== undefined) {
    // Anthropic excludes cache reads/writes from its base input count.
    return sumKnown(
      tokenCount(raw.input_tokens),
      tokenCount(raw.cache_read_input_tokens === undefined ? 0 : raw.cache_read_input_tokens),
      tokenCount(raw.cache_creation_input_tokens === undefined ? 0 : raw.cache_creation_input_tokens),
    );
  }
  return tokenCount(raw.promptTokenCount);
}

function completionCount(raw) {
  const direct = firstDefined(raw.completion_tokens, raw.completionTokens, raw.output_tokens);
  if (direct !== undefined) return tokenCount(direct);
  // Gemini candidates exclude thoughts. Missing candidates are not known zero.
  return sumKnown(
    tokenCount(raw.candidatesTokenCount),
    tokenCount(raw.thoughtsTokenCount === undefined ? 0 : raw.thoughtsTokenCount),
  );
}

function reasoningCount(raw) {
  return tokenCount(firstDefined(
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_tokens_details?.reasoning_tokens,
    raw.reasoning_tokens,
    raw.reasoningTokens,
    raw.thoughtsTokenCount,
  ));
}

function cacheCounts(raw, prompt) {
  if (!reported(raw, "cache_reported", "cacheReported") || prompt === null) return null;
  const hitInput = firstDefined(
    raw.prompt_cache_hit_tokens,
    raw.cachedTokens,
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens,
    raw.cache_read_input_tokens,
    raw.cachedContentTokenCount,
  );
  const missInput = firstDefined(raw.prompt_cache_miss_tokens, raw.missTokens);
  return consistentCacheCounts(prompt, hitInput, missInput);
}

function consistentCacheCounts(prompt, hitInput, missInput) {
  if (hitInput === undefined && missInput === undefined) return null;
  let hit = tokenCount(hitInput);
  let miss = tokenCount(missInput);
  // Invalid supplied measurements must not be replaced by an inferred counterpart.
  if ((hitInput !== undefined && hit === null) || (missInput !== undefined && miss === null)) return null;
  if (hit === null) hit = prompt - miss;
  if (miss === null) miss = prompt - hit;
  if (hit < 0 || miss < 0 || hit > prompt || miss > prompt || hit + miss !== prompt) return null;
  return { hit, miss };
}

function firstDefined(...values) {
  // Invalid present aliases must not fall back to a different provider's value.
  return values.find(value => value !== undefined);
}

function reported(raw, wireFlag, camelFlag) {
  return raw[wireFlag] !== false && raw[camelFlag] !== false;
}

function tokenCount(value) {
  if (typeof value === "string") {
    const digits = value.trim();
    if (!/^[0-9]+$/.test(digits)) return null;
    value = Number(digits);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_VALUE ?
    (value === 0 ? 0 : value) : null;
}

function sumKnown(...counts) {
  if (counts.some(count => count === null)) return null;
  const sum = counts.reduce((total, count) => total + count, 0);
  return Number.isSafeInteger(sum) && sum <= MAX_TOKEN_VALUE ? sum : null;
}

function knownOrZero(count) { return count === null ? 0 : count; }
