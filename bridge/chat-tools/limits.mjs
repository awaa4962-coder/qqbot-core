export const CHAT_TOOL_LIMITS = Object.freeze({ modelRounds: 4, transportAttempts: 8, toolCalls: 4,
  slotRounds: 3, durationMs: 90000, requestChars: 24000, resultChars: 2000, totalResultChars: 6000, maxTokens: 1536,
  responseBytes: 262144, replyChars: 6000 });

export const TOOL_LIMIT_PROFILES = Object.freeze({
  standard: CHAT_TOOL_LIMITS,
  extended: Object.freeze({ ...CHAT_TOOL_LIMITS, modelRounds: 8, transportAttempts: 16, toolCalls: 12,
    slotRounds: 7, durationMs: 120000, requestChars: 32000, totalResultChars: 12000 }),
  light: Object.freeze({ ...CHAT_TOOL_LIMITS, modelRounds: 3, transportAttempts: 6, toolCalls: 2,
    slotRounds: 2, durationMs: 30000, resultChars: 1000, totalResultChars: 2000, maxTokens: 512 }),
});

export const TOOL_LIMIT_BOUNDS = Object.freeze({
  modelRounds: [3, 16], transportAttempts: [2, 32], toolCalls: [1, 24], slotRounds: [2, 15],
  durationMs: [5000, 180000], requestChars: [8000, 64000], resultChars: [256, 4000],
  totalResultChars: [1000, 24000], maxTokens: [128, 8192], responseBytes: [16384, 1048576], replyChars: [256, 12000],
});

export function resolveToolLimits(profile = "standard", overrides = {}) {
  if (!Object.hasOwn(TOOL_LIMIT_PROFILES, profile)) throw new TypeError("tool_profile_invalid");
  if (!overrides || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) throw new TypeError("tool_limits_invalid");
  const result = { ...TOOL_LIMIT_PROFILES[profile] };
  applyLimitOverrides(result, overrides);
  if (Object.hasOwn(overrides, "modelRounds") && !Object.hasOwn(overrides, "slotRounds")) result.slotRounds = Math.max(2, result.modelRounds - 1);
  if (result.slotRounds >= result.modelRounds || result.transportAttempts < 2 * result.modelRounds ||
      result.totalResultChars < result.resultChars) throw new TypeError("tool_limits_invalid");
  return Object.freeze(result);
}

function applyLimitOverrides(result, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    const range = Object.hasOwn(TOOL_LIMIT_BOUNDS, key) ? TOOL_LIMIT_BOUNDS[key] : null;
    if (!range || !Number.isSafeInteger(value) || value < range[0] || value > range[1]) throw new TypeError("tool_limits_invalid");
    result[key] = value;
  }
}
