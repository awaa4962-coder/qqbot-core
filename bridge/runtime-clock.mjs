import { performance } from "node:perf_hooks";

export function monotonicNow() {
  return performance.now();
}

export function wallAgeMs(timestamp, now = Date.now(), options = {}) {
  const value = Number(timestamp);
  const current = Number(now);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(current)) return Number.POSITIVE_INFINITY;
  const age = current - value;
  const futureToleranceMs = Math.max(0, Number(options.futureToleranceMs ?? 5000));
  if (age < -futureToleranceMs) return Number.POSITIVE_INFINITY;
  return Math.max(0, age);
}

export function createFixedWindowLimiter(options = {}) {
  const limit = Math.max(1, Number(options.limit || 1));
  const windowMs = Math.max(1, Number(options.windowMs || 1000));
  const maxScopes = Math.max(1, Number(options.maxScopes || 1000));
  const now = options.now || monotonicNow;
  const buckets = new Map();
  let totalDropped = 0;

  function take(scope = "global") {
    const key = String(scope || "global");
    const current = Number(now());
    let bucket = buckets.get(key);
    if (!bucket || shouldResetWindow(bucket.startedAt, current, windowMs)) {
      bucket = { startedAt: current, lastSeenAt: current, count: 0, dropped: 0 };
      buckets.set(key, bucket);
    }
    bucket.lastSeenAt = current;
    bucket.count++;
    if (bucket.count <= limit) {
      pruneBuckets(buckets, maxScopes);
      return { ok: true, count: bucket.count, remaining: limit - bucket.count };
    }
    bucket.dropped++;
    totalDropped++;
    pruneBuckets(buckets, maxScopes);
    return { ok: false, count: bucket.count, remaining: 0, dropped: bucket.dropped };
  }

  function status() {
    return { limit, windowMs, scopes: buckets.size, totalDropped };
  }

  function reset() {
    buckets.clear();
    totalDropped = 0;
  }

  return { take, status, reset };
}

export function createClockJumpMonitor(options = {}) {
  const wallNow = options.wallNow || Date.now;
  const monoNow = options.monoNow || monotonicNow;
  const thresholdMs = Math.max(100, Number(options.thresholdMs || 2000));
  let previousWall = Number(wallNow());
  let previousMono = Number(monoNow());
  let jumps = 0;
  let lastJump = null;

  function sample() {
    const wall = Number(wallNow());
    const mono = Number(monoNow());
    const wallDelta = wall - previousWall;
    const monoDelta = mono - previousMono;
    const offsetMs = wallDelta - monoDelta;
    previousWall = wall;
    previousMono = mono;
    if (Math.abs(offsetMs) < thresholdMs) return null;
    jumps++;
    lastJump = {
      direction: offsetMs < 0 ? "backward" : "forward",
      offsetMs: Math.round(offsetMs),
      detectedAt: new Date(wall).toISOString(),
    };
    return { ...lastJump };
  }

  function status() {
    return { jumps, lastJump: lastJump ? { ...lastJump } : null };
  }

  return { sample, status };
}

function shouldResetWindow(startedAt, now, windowMs) {
  const elapsed = now - startedAt;
  return elapsed < 0 || elapsed >= windowMs;
}

function pruneBuckets(buckets, maxScopes) {
  if (buckets.size <= maxScopes) return;
  const oldest = [...buckets.entries()]
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, buckets.size - maxScopes);
  for (const [key] of oldest) buckets.delete(key);
}
