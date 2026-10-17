import path from "node:path";
import { CFG } from "../config.mjs";
import { findUsableSevenZip } from "../seven-zip.mjs";
import { log, logE } from "../logger.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const RESULT_PREFIX = "QQFRIEND_JM_RESULT ";
export const PROGRESS_PREFIX = "QQFRIEND_JM_PROGRESS ";
const TIMING_KEYS = new Set(["importMs", "clientInitMs", "albumReadyMs", "firstImageMs", "lastImageMs", "observedMs",
  "downloadFinishedMs", "imageRequestsCompleted", "imageRetriesCompleted", "imageRequestMs", "imageRequestMaxMs",
  "metadataCallsCompleted", "metadataMs", "metadataMaxMs", "imageSavesCompleted", "imageSaveMs", "imageSaveMaxMs"]);

export let jmHealthCache = null;

export let jmHealthExpiresAt = 0;

export let jmHealthPromise = null;

export const JM_HEALTH_CACHE_MS = 5 * 60 * 1000;

export function peekJmRuntimeHealth() {
  return jmHealthCache ? { ...jmHealthCache, stale: jmHealthExpiresAt <= monotonicNow() }
    : { health: "unknown", reason: "checking", checkedAt: null };
}

export function runJmDownload(jmId, outputDir, options = {}) {
  const script = path.resolve("scripts", "jm_download_once.py");
  return runPythonJson({
    command: CFG.jmPython,
    args: [script, "--id", String(jmId), "--out", outputDir],
    env: { ...buildJmDownloadEnv(), QQBOT_JM_AUTO_INSTALL: "0" },
    timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

export function buildJmDownloadEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    PYTHONUTF8: "1",
    QQBOT_JMCOMIC_SRC: CFG.jmcomicSrc || baseEnv.QQBOT_JMCOMIC_SRC || "",
    QQBOT_JM_DOMAINS: Array.isArray(CFG.jmDomains) ? CFG.jmDomains.join(",") : String(baseEnv.QQBOT_JM_DOMAINS || ""),
  };
}

export function getJmRuntimeHealth(options = {}) {
  const now = Number(options.now || Date.now());
  const cacheNow = Number(options.cacheNow ?? monotonicNow());
  if (!options.force && jmHealthCache && jmHealthExpiresAt > cacheNow) return { ...jmHealthCache };
  if (isUnforcedTestProbe(options)) return buildTestJmHealth(now);
  if (options.force || options.runner) return cacheJmHealth(runJmHealthProbe(options), now, cacheNow, options);
  refreshJmRuntimeHealth({ now }).catch(error => logE("jm health refresh failed:", error.message));
  if (jmHealthCache) return { ...jmHealthCache, stale: true };
  return buildPendingJmHealth(now);
}

export async function refreshJmRuntimeHealth(options = {}) {
  const now = Number(options.now || Date.now());
  const cacheNow = Number(options.cacheNow ?? monotonicNow());
  if (!options.force && jmHealthCache && jmHealthExpiresAt > cacheNow) return { ...jmHealthCache };
  if (jmHealthPromise) return await jmHealthPromise;
  jmHealthPromise = runJmHealthProbeAsync(options)
    .then(result => cacheJmHealth(result, now, cacheNow, options))
    .finally(() => { jmHealthPromise = null; });
  return await jmHealthPromise;
}

export function isUnforcedTestProbe(options) {
  return process.env.NODE_ENV === "test" && !options.force && !options.runner;
}

export function buildTestJmHealth(now) {
  return {
    health: "ready",
    dependencyReady: true,
    pythonReady: true,
    sevenZipReady: true,
    checkedAt: new Date(now).toISOString(),
    reason: "test_mode",
  };
}

export function buildPendingJmHealth(now) {
  const sevenZipReady = Boolean(findUsableSevenZip({ configured: CFG.jmSevenZipPath }));
  return {
    health: "degraded",
    dependencyReady: false,
    pythonReady: Boolean(CFG.jmPython),
    sevenZipReady,
    checkedAt: new Date(now).toISOString(),
    source: CFG.jmcomicSrc ? "configured" : "not_configured",
    reason: "checking",
  };
}

export function runJmHealthProbe(options) {
  const runner = options.runner || spawnSync;
  const script = path.resolve("scripts", "jm_download_once.py");
  return runner(CFG.jmPython, [script, "--check"], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: Number(options.timeoutMs || 8000),
    windowsHide: true,
    env: { ...buildJmDownloadEnv(), QQBOT_JM_AUTO_INSTALL: "0" },
  });
}

export async function runJmHealthProbeAsync(options) {
  if (options.runner) return await options.runner();
  const script = path.resolve("scripts", "jm_download_once.py");
  return await spawnHealthProbe(CFG.jmPython, [script, "--check"], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: Number(options.timeoutMs || 8000),
    windowsHide: true,
    env: { ...buildJmDownloadEnv(), QQBOT_JM_AUTO_INSTALL: "0" },
  });
}

export function spawnHealthProbe(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, options);
    let stdout = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, stdout, error: new Error("timeout") });
    }, options.timeout);
    timer.unref?.();
    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.on("error", error => finish({ status: null, stdout, error }));
    child.on("close", status => finish({ status, stdout }));
  });
}

export function cacheJmHealth(result, now, cacheNow, options = {}) {
  const value = buildJmHealthValue(result, now, options);
  jmHealthCache = value;
  jmHealthExpiresAt = cacheNow + JM_HEALTH_CACHE_MS;
  return { ...value };
}

export function buildJmHealthValue(result, now, options = {}) {
  const parsed = parseHealthResult(result?.stdout);
  const pythonReady = !result?.error && result?.status !== null;
  const dependencyReady = result?.status === 0 && parsed?.ok === true;
  const sevenZipReady = Boolean(findUsableSevenZip({
    configured: CFG.jmSevenZipPath,
    runner: options.sevenZipRunner,
  }));
  const health = dependencyReady && sevenZipReady ? "ready" : "degraded";
  const value = {
    health,
    dependencyReady,
    pythonReady,
    sevenZipReady,
    checkedAt: new Date(now).toISOString(),
    source: parsed?.source || (CFG.jmcomicSrc ? "configured" : "not_configured"),
    reason: resolveJmHealthReason({ dependencyReady, sevenZipReady, parsed, result }),
  };
  return value;
}

export function resolveJmHealthReason({ dependencyReady, sevenZipReady, parsed, result }) {
  if (dependencyReady) return sevenZipReady ? "runtime_ok" : "7zip_missing";
  if (parsed?.reason) return parsed.reason;
  return result?.error ? "python_unavailable" : "dependency_missing";
}

export function resetJmRuntimeHealthCache() {
  jmHealthCache = null;
  jmHealthExpiresAt = 0;
  jmHealthPromise = null;
}

export async function runPythonJson({ command, args, env, timeoutMs, signal, onProgress, spawnImpl = spawn }) {
  if (signal?.aborted) return { ok: false, reason: "timeout" };
  return await new Promise(resolve => {
    const detached = process.platform !== "win32";
    const child = spawnImpl(command, args, { env, windowsHide: true, detached });
    let stdout = "";
    let stderr = "";
    let pendingLine = "", settled = false, stopped = false, latestTimings = null;
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      if (stopped || settled) return;
      stopped = true;
      try {
        if (detached && Number.isSafeInteger(child.pid) && child.pid > 0) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* Keep the task locked until close confirms worker exit. */ }
      }
    };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout.on("data", chunk => {
      const text = outDecoder.write(chunk);
      stdout = (stdout + text).slice(-1024 * 1024);
      pendingLine += text;
      let newline;
      while ((newline = pendingLine.indexOf("\n")) >= 0) {
        const line = pendingLine.slice(0, newline).trim();
        pendingLine = pendingLine.slice(newline + 1);
        if (!stopped && line.startsWith(PROGRESS_PREFIX)) {
          latestTimings = dispatchJmProgress(line.slice(PROGRESS_PREFIX.length), onProgress) || latestTimings;
        }
      }
      if (pendingLine.length > 65536) pendingLine = "";
    });
    child.stderr.on("data", chunk => { stderr = (stderr + errDecoder.write(chunk)).slice(-1024 * 1024); });
    child.on("error", error => {
      // kill()/pipe errors do not prove process exit; keep the task lock until close.
      if (stopped || (Number.isSafeInteger(child.pid) && child.pid > 0)) return;
      finish({ ok: false, reason: error.code === "ENOENT" ? "missing_dependency" : "worker_start_failed" });
    });
    child.on("close", code => {
      if (settled) return;
      stdout += outDecoder.end(); stderr += errDecoder.end();
      finish(withRunnerTimings(stopped ? { ok: false, reason: "timeout" } : parseRunnerResult(stdout, stderr, code), latestTimings));
    });
  });
}

function dispatchJmProgress(text, callback) {
  try {
    const value = JSON.parse(text);
    if (!["preparing", "downloading"].includes(value.phase)) return null;
    const progress = { phase: value.phase };
    for (const key of ["completed", "total", "bytes", "failed"]) {
      if (key === "total" && value[key] === null) progress[key] = null;
      else if (Number.isSafeInteger(value[key]) && value[key] >= 0) progress[key] = value[key];
    }
    callback?.(progress);
    return sanitizeJmTimings(value.timings);
  } catch { return null; }
}

export function sanitizeJmTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const timings = Object.fromEntries(Object.entries(value).filter(([key, number]) => TIMING_KEYS.has(key) &&
    Number.isSafeInteger(number) && number >= 0 && number <= (key.endsWith("Ms") ? 86400000 : 1000000)));
  return Object.keys(timings).length ? timings : null;
}

function withRunnerTimings(result, latestTimings) {
  const timings = sanitizeJmTimings(result.timings) || latestTimings;
  const cleaned = { ...result };
  delete cleaned.timings;
  if (!timings) return cleaned;
  log("jm timings:", JSON.stringify(timings));
  return { ...cleaned, timings };
}

export function parseRunnerResult(stdout, stderr, code) {
  // Try stdout first
  let line = stdout.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  // Fallback: search stderr as well (Windows encoding issues may route output there)
  if (!line) {
    line = stderr.split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  }
  if (line) {
    try {
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
      if (parsed?.ok) return parsed;
      return normalizeRunnerFailure(parsed);
    } catch {}
  }
  log("jm runner exit:", code, "stdoutLength:", stdout.length, "stderrLength:", stderr.length);
  return { ok: false, reason: code === 0 ? "download_failed" : "missing_dependency" };
}

function normalizeRunnerFailure(parsed) {
  const value = parsed && typeof parsed === "object" ? parsed : {};
  const codes = Array.isArray(value.errorCodes) ? value.errorCodes : [value.error_category];
  return {
    ok: false, reason: value.reason || "download_failed", error: value.error || "",
    missing: value.missing || [], sourceReason: value.sourceReason || "",
    failedImages: value.failedImages ?? value.failed_images, failedPhotos: value.failedPhotos ?? value.failed_photos,
    errorCodes: codes.filter(code => typeof code === "string" && /^[a-z_]{1,32}$/.test(code)).slice(0, 8),
    ...(sanitizeJmTimings(value.timings) ? { timings: sanitizeJmTimings(value.timings) } : {}),
  };
}

export function parseHealthResult(stdout) {
  const line = String(stdout || "").split(/\r?\n/).reverse()
    .find(item => item.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return null;
  }
}
