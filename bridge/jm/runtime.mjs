import path from "node:path";
import { CFG } from "../config.mjs";
import { findUsableSevenZip } from "../seven-zip.mjs";
import { log, logE } from "../logger.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
import { spawn, spawnSync } from "node:child_process";

export const RESULT_PREFIX = "QQFRIEND_JM_RESULT ";

export let jmHealthCache = null;

export let jmHealthExpiresAt = 0;

export let jmHealthPromise = null;

export const JM_HEALTH_CACHE_MS = 5 * 60 * 1000;

export function runJmDownload(jmId, outputDir, options = {}) {
  const script = path.resolve("scripts", "jm_download_once.py");
  return runPythonJson({
    command: CFG.jmPython,
    args: [script, "--id", String(jmId), "--out", outputDir],
    env: buildJmDownloadEnv(),
    timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
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

export async function runPythonJson({ command, args, env, timeoutMs }) {
  return await new Promise(resolve => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: error.code === "ENOENT" ? "missing_dependency" : error.message });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseRunnerResult(stdout, stderr, code));
    });
  });
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
      return {
        ok: false,
        reason: parsed?.reason || "download_failed",
        error: parsed?.error || "",
        missing: parsed?.missing || [],
        sourceReason: parsed?.sourceReason || "",
      };
    } catch {}
  }
  // Log context for debugging when result line is missing
  const stdoutTail = stdout.split(/\r?\n/).slice(-10).join("\\n").slice(0, 800);
  const stderrTail = stderr.slice(-500);
  log("jm runner exit:", code, "stdout_last_lines:", stdoutTail, "stderr:", stderrTail);
  return { ok: false, reason: code === 0 ? "download_failed" : "missing_dependency" };
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
