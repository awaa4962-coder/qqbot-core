import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { monotonicNow } from "../../runtime-clock.mjs";
import { CFG } from "../../config.mjs";
import { log, logE } from "../../logger.mjs";
import {
  applyMemeUpdateBatch,
  findMemeByNameOrAlias,
  flushMemeStoreSync,
  getMemeStore,
  saveMemeStore,
} from "./store.mjs";
import { deduplicateTrendItems, selectTrendCandidates } from "./deduplicator.mjs";
import {
  evidenceDomainCount,
  filterRelevantMemeEvidence,
  searchMemeEvidence,
} from "./evidence-search.mjs";
import { verifyMemeEvidenceBatch } from "./evidence-verifier.mjs";
import { collectDailyHotTerms } from "./sources/daily-hot.mjs";
import { collectRssHubTerms } from "./sources/rsshub.mjs";

const MIN_ACCEPT_CONFIDENCE = 0.78;
const STALE_LOCK_MS = 30 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
const VERIFY_BATCH_SIZE = 5;
const SYNC_SOURCE = "public-web-trends-v1";

let runningPromise = null;
let scheduleTimer = null;

export function isMemeTrendUpdateDue(now = Date.now()) {
  const lastAttempt = Date.parse(getMemeStore().sync?.lastAttemptAt || "");
  return !Number.isFinite(lastAttempt) || Number(now) - lastAttempt >= CFG.memeUpdateIntervalMs;
}

export async function runMemeTrendUpdate(options = {}) {
  if (runningPromise) return await runningPromise;
  if (!CFG.memeAutoUpdateEnabled && options.force !== true) {
    return { ok: false, skipped: true, reason: "auto update disabled" };
  }
  if (!options.force && !isMemeTrendUpdateDue(options.now)) {
    return { ok: true, skipped: true, reason: "not due" };
  }

  runningPromise = runUpdate(options);
  try {
    return await runningPromise;
  } finally {
    runningPromise = null;
  }
}

export function scheduleMemeTrendUpdates(options = {}) {
  stopMemeTrendUpdates();
  if (!CFG.memeAutoUpdateEnabled) return () => {};

  const tick = async () => {
    try {
      await runMemeTrendUpdate(options);
    } catch (error) {
      logE("meme web update schedule failed:", error.message);
    } finally {
      scheduleTimer = setTimeout(tick, CFG.memeUpdateIntervalMs);
      scheduleTimer.unref?.();
    }
  };
  scheduleTimer = setTimeout(tick, Number(options.firstDelayMs ?? FIRST_RUN_DELAY_MS));
  scheduleTimer.unref?.();
  return stopMemeTrendUpdates;
}

export function stopMemeTrendUpdates() {
  if (!scheduleTimer) return;
  clearTimeout(scheduleTimer);
  scheduleTimer = null;
}

export async function researchMemeTerm(term, options = {}) {
  const normalizedTerm = clean(term, 40);
  if (!normalizedTerm) return { ok: false, reason: "词条不能为空", evidence: [] };
  const searchEvidence = options.searchEvidence || searchMemeEvidence;
  const verifyBatch = options.verifyBatch || verifyMemeEvidenceBatch;
  const evidence = await searchEvidence(normalizedTerm, options);
  const relevantEvidence = filterRelevantMemeEvidence(normalizedTerm, evidence);
  if (!hasEnoughEvidence(relevantEvidence, options)) {
    return { ok: false, reason: "相关的独立网页证据不足", evidence: relevantEvidence };
  }

  const candidate = {
    term: normalizedTerm,
    platforms: [],
    trendSources: [],
    evidence: relevantEvidence,
  };
  const reviews = await verifyBatch([candidate], options);
  const review = reviews.find(item => sameTerm(item.term, normalizedTerm));
  if (!acceptedReview(review, candidate, options)) {
    return {
      ok: false,
      reason: review?.reason || "网页证据无法确认这是稳定网络梗",
      evidence: relevantEvidence,
      review: review || null,
    };
  }

  const entry = buildVerifiedEntry(candidate, review, Number(options.now || Date.now()));
  if (options.save === false) return { ok: true, entry, evidence: relevantEvidence, review };
  const result = applyMemeUpdateBatch([entry], {
    now: options.now,
    runId: options.runId || "manual-research-" + crypto.randomUUID(),
  });
  saveMemeStore();
  flushMemeStoreSync();
  return {
    ok: true,
    entry: findMemeByNameOrAlias(entry.name),
    evidence: relevantEvidence,
    review,
    result,
  };
}

async function runUpdate(options) {
  const now = Number(options.now || Date.now());
  const startedAt = new Date(now).toISOString();
  const startedClock = monotonicNow();
  const runId = String(options.runId || crypto.randomUUID());
  const releaseLock = options.lock === false
    ? () => {}
    : acquireUpdateLock(options.lockFile || CFG.memeUpdateLockFile, now);
  if (!releaseLock) return { ok: false, skipped: true, reason: "another update is running" };

  const sync = getMemeStore().sync;
  sync.source = SYNC_SOURCE;
  sync.lastAttemptAt = startedAt;
  sync.runId = runId;
  sync.error = "";
  sync.sources = {};
  saveMemeStore();
  flushMemeStoreSync();

  try {
    const collected = await collectTrendSources(options);
    sync.sources = collected.statuses;
    if (!collected.items.length) {
      return finishFailedRun({
        runId,
        startedAt,
        startedClock,
        error: "所有趋势来源均不可用或未返回数据",
      });
    }

    const trends = deduplicateTrendItems(collected.items);
    const candidates = selectTrendCandidates(trends, getMemeStore().entries, {
      now,
      limit: options.limit || CFG.memeUpdateLimit,
    });
    const researched = await collectCandidateEvidence(candidates, options);
    const reviewable = researched.filter(item => hasEnoughEvidence(item.evidence, options));
    const reviews = await reviewCandidates(reviewable, options);
    const entries = buildAcceptedEntries(reviewable, reviews, now, options);
    const batch = applyMemeUpdateBatch(entries, { now, runId });
    const stale = expireOldWebEntries(now, runId);
    const sourceFailures = Object.values(collected.statuses).filter(item => !item.ok).length;
    const status = sourceFailures ? "partial" : "success";
    const skipped = Math.max(0, candidates.length - entries.length) + batch.skipped;
    const durationMs = Math.max(0, monotonicNow() - startedClock);

    Object.assign(sync, {
      lastSuccessAt: new Date(now).toISOString(),
      accepted: batch.accepted,
      updated: batch.updated,
      review: reviewable.length,
      skipped,
      durationMs,
      error: "",
    });
    appendSyncRun(sync, {
      id: runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      status,
      accepted: batch.accepted,
      updated: batch.updated,
      review: reviewable.length,
      skipped,
      error: "",
    });
    saveMemeStore();
    flushMemeStoreSync();
    log(
      "meme web update:",
      `${status}, accepted=${batch.accepted}, updated=${batch.updated}, stale=${stale}`,
    );
    return {
      ok: true,
      runId,
      status,
      candidates: candidates.length,
      reviewed: reviewable.length,
      accepted: batch.accepted,
      updated: batch.updated,
      stale,
      skipped,
    };
  } catch (error) {
    return finishFailedRun({
      runId,
      startedAt,
      startedClock,
      error: String(error?.message || error),
    });
  } finally {
    releaseLock();
  }
}

async function collectTrendSources(options) {
  const collectors = options.collectors || [
    { name: "daily-hot", collect: collectDailyHotTerms },
    { name: "rsshub", collect: collectRssHubTerms },
  ];
  const results = await Promise.allSettled(collectors.map(item =>
    item.collect(options.sourceOptions || {})
  ));
  const items = [];
  const statuses = {};
  results.forEach((result, index) =>
    mergeCollectorResult(result, collectors[index], index, items, statuses)
  );
  return { items, statuses };
}

function mergeCollectorResult(result, collector, index, items, statuses) {
  const name = collector.name || `source-${index + 1}`;
  if (result.status !== "fulfilled") {
    statuses[name] = sourceStatus(false, 0, result.reason?.message || result.reason);
    return;
  }

  const sourceItems = result.value?.items || [];
  const sourceStatuses = result.value?.statuses || {};
  items.push(...sourceItems);
  Object.assign(statuses, sourceStatuses);
  if (!Object.keys(sourceStatuses).length) {
    statuses[name] = sourceStatus(Boolean(sourceItems.length), sourceItems.length);
  }
}

async function collectCandidateEvidence(candidates, options) {
  const searchEvidence = options.searchEvidence || searchMemeEvidence;
  return await mapConcurrent(candidates, Number(options.searchConcurrency || 3), async candidate => {
    const evidence = await searchEvidence(candidate.term, options);
    return {
      ...candidate,
      evidence: filterRelevantMemeEvidence(candidate.term, evidence),
    };
  });
}

async function reviewCandidates(candidates, options) {
  const verifyBatch = options.verifyBatch || verifyMemeEvidenceBatch;
  const reviews = [];
  for (let index = 0; index < candidates.length; index += VERIFY_BATCH_SIZE) {
    const batch = candidates.slice(index, index + VERIFY_BATCH_SIZE);
    reviews.push(...await verifyBatch(batch, options));
  }
  return reviews;
}

function buildAcceptedEntries(candidates, reviews, now, options) {
  const candidatesByKey = new Map(candidates.map(item => [keyOf(item.term), item]));
  const entries = [];
  for (const review of reviews) {
    const candidate = candidatesByKey.get(keyOf(review.term));
    if (!candidate || !acceptedReview(review, candidate, options)) continue;
    entries.push(buildVerifiedEntry(candidate, review, now));
  }
  return entries;
}

function buildVerifiedEntry(candidate, review, now) {
  const existing = findMemeByNameOrAlias(candidate.term);
  const canonicalName = clean(existing?.name || review.canonicalName || candidate.term, 40);
  const candidateAlias = sameTerm(canonicalName, candidate.term) ? [] : [candidate.term];
  const reviewedEvidence = review.evidenceIndexes
    .map(index => candidate.evidence?.[index])
    .filter(Boolean);
  const sources = uniqueSources([
    ...(candidate.trendSources || []),
    ...reviewedEvidence,
  ]);
  return {
    name: canonicalName,
    aliases: uniqueText([...candidateAlias, ...(review.aliases || [])], 20),
    triggers: uniqueText([canonicalName, candidate.term, ...(review.aliases || [])], 30),
    meaning: review.meaning,
    usage: review.usage,
    examples: review.examples || [],
    sources,
    source: "web-verified",
    confidence: review.confidence,
    semanticConfidence: review.confidence,
    level: review.confidence >= 0.9 ? "S" : "A",
    enabled: true,
    status: "active",
    scope: { type: "global", groupIds: [] },
    evidence: {
      count: sources.length,
      users: 0,
      groups: 0,
      contexts: evidenceDomainCount(reviewedEvidence),
    },
    lastVerifiedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CFG.memeExpiryDays * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function expireOldWebEntries(now, runId) {
  let count = 0;
  for (const entry of getMemeStore().entries) {
    if (entry.source !== "web-verified" || entry.status !== "active") continue;
    if ((entry.manualFields || []).some(field => field === "status" || field === "enabled")) continue;
    const expiresAt = Date.parse(entry.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    appendRollbackEntry(runId, entry, now);
    entry.status = "stale";
    entry.enabled = false;
    entry.updatedAt = new Date(now).toISOString();
    count += 1;
  }
  if (count) saveMemeStore();
  return count;
}

function appendRollbackEntry(runId, entry, now) {
  const sync = getMemeStore().sync;
  if (sync.rollback?.id !== runId) {
    sync.rollback = {
      id: runId,
      createdAt: new Date(now).toISOString(),
      entries: [],
    };
  }
  if (sync.rollback.entries.some(item => sameTerm(item.name, entry.name))) return;
  sync.rollback.entries.push({
    name: entry.name,
    before: JSON.parse(JSON.stringify(entry)),
  });
}

function finishFailedRun({ runId, startedAt, startedClock, error }) {
  const sync = getMemeStore().sync;
  const durationMs = Math.max(0, monotonicNow() - startedClock);
  const message = clean(error, 180) || "unknown error";
  Object.assign(sync, {
    accepted: 0,
    updated: 0,
    review: 0,
    skipped: 0,
    durationMs,
    error: message,
  });
  appendSyncRun(sync, {
    id: runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    status: "failed",
    accepted: 0,
    updated: 0,
    review: 0,
    skipped: 0,
    error: message,
  });
  saveMemeStore();
  flushMemeStoreSync();
  logE("meme web update failed:", message);
  return { ok: false, runId, error: message };
}

function appendSyncRun(sync, run) {
  sync.runs = [...(sync.runs || []), run].slice(-20);
}

function hasEnoughEvidence(evidence, options) {
  const minItems = Number(options.minEvidenceItems || CFG.memeEvidenceMinItems);
  const minDomains = Number(options.minEvidenceSources || CFG.memeEvidenceMinSources);
  return evidence.length >= minItems && evidenceDomainCount(evidence) >= minDomains;
}

function acceptedReview(review, candidate, options = {}) {
  const citedEvidence = (review?.evidenceIndexes || [])
    .map(index => candidate?.evidence?.[index])
    .filter(Boolean);
  const minDomains = Number(options.minEvidenceSources || CFG.memeEvidenceMinSources);
  return Boolean(
    review?.isMeme === true &&
    review.confidence >= MIN_ACCEPT_CONFIDENCE &&
    review.meaning &&
    review.usage &&
    citedEvidence.length >= minDomains &&
    evidenceDomainCount(citedEvidence) >= minDomains
  );
}

function acquireUpdateLock(filePath, now) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    removeStaleLock(filePath, now);
    const descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
    }), "utf8");
    fs.closeSync(descriptor);
    return () => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // The lock may have been cleaned up by process shutdown.
      }
    };
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

function removeStaleLock(filePath, now) {
  try {
    const stat = fs.statSync(filePath);
    const age = Number(now) - stat.mtimeMs;
    if (age > STALE_LOCK_MS || age < -5 * 60 * 1000) fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const count = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

function sourceStatus(ok, count, error = "") {
  return {
    ok,
    count: Number(count || 0),
    fetchedAt: new Date().toISOString(),
    error: clean(error, 160),
  };
}

function uniqueSources(items) {
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const key = String(item.url || `${item.platform || "web"}:${item.title || ""}`);
    if (key) map.set(key, item);
  }
  return [...map.values()].slice(0, 12);
}

function uniqueText(items, limit) {
  return [...new Set(items.map(item => clean(item, 40)).filter(Boolean))].slice(0, limit);
}

function keyOf(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

function sameTerm(left, right) {
  return Boolean(keyOf(left) && keyOf(left) === keyOf(right));
}

function clean(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}
