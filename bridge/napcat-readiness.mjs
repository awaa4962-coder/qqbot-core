import { CFG } from "./config.mjs";
import { buildNapCatHeaders } from "./napcat-auth.mjs";
import { monotonicNow } from "./runtime-clock.mjs";

const CACHE_MS = 5000;
let cached = initialStatus();
let cacheExpiresAt = 0;
let probePromise = null;

export async function refreshNapCatReadiness(options = {}) {
  const cacheNow = Number(options.cacheNow ?? monotonicNow());
  if (!options.force && cacheExpiresAt > cacheNow) return { ...cached };
  if (probePromise) return await probePromise;
  probePromise = runProbe(options)
    .then(result => {
      cached = result;
      cacheExpiresAt = cacheNow + CACHE_MS;
      return { ...cached };
    })
    .finally(() => { probePromise = null; });
  return await probePromise;
}

export function getCachedNapCatReadiness() {
  return { ...cached };
}

export function resetNapCatReadinessForTest() {
  cached = initialStatus();
  cacheExpiresAt = 0;
  probePromise = null;
}

async function runProbe(options) {
  const fetcher = options.fetcher || fetch;
  try {
    const response = await fetcher(CFG.napcatApi + "/get_login_info", {
      method: "POST",
      headers: buildNapCatHeaders(),
      signal: AbortSignal.timeout(Number(options.timeoutMs || 3000)),
    });
    const payload = await response.json();
    return normalizeProbe(response, payload);
  } catch {
    return status(false, "api_unreachable", 0, false);
  }
}

function normalizeProbe(response, payload) {
  const userId = Number(payload?.data?.user_id || 0);
  const apiOk = response.ok !== false && (payload?.status === "ok" || Number(payload?.retcode) === 0);
  if (!apiOk || !Number.isSafeInteger(userId) || userId <= 0) {
    return status(false, "not_logged_in", 0, false);
  }
  const userMatches = !CFG.selfUin || Number(CFG.selfUin) === userId;
  return status(userMatches, userMatches ? "ready" : "unexpected_account", userId, userMatches);
}

function status(ready, reason, userId, userMatches) {
  return {
    ready,
    loggedIn: userId > 0,
    userMatches,
    reason,
    checkedAt: new Date().toISOString(),
  };
}

function initialStatus() {
  return {
    ready: false,
    loggedIn: false,
    userMatches: false,
    reason: "not_checked",
    checkedAt: null,
  };
}
