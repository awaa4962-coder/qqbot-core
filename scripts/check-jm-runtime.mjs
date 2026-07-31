import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CFG } from "../bridge/config.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULT_PREFIX = "QQFRIEND_JM_RESULT ";

function parseArgs(argv) {
  return {
    install: argv.includes("--install"),
  };
}

function runPythonCheck(options) {
  const script = path.join(ROOT, "scripts", "jm_download_once.py");
  return spawnSync(CFG.jmPython, [script, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      QQBOT_JMCOMIC_SRC: CFG.jmcomicSrc || process.env.QQBOT_JMCOMIC_SRC || "",
      QQBOT_JM_DOMAINS: Array.isArray(CFG.jmDomains) ? CFG.jmDomains.join(",") : "",
      QQBOT_JM_AUTO_INSTALL: options.install ? "1" : "0",
    },
  });
}

function parseResult(stdout) {
  const line = String(stdout || "").split(/\r?\n/).reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return null;
  }
}

function bundledSevenZipPath() {
  try {
    return String(require("7zip-bin").path7za || "").trim();
  } catch {
    return "";
  }
}

function hasSevenZip() {
  if (CFG.jmSevenZipPath) return true;
  return Boolean(bundledSevenZipPath());
}

function collectFailures(result, parsed) {
  const failures = [];
  if (result.status !== 0 || !parsed?.ok) {
    failures.push("python=" + (parsed?.reason || "unknown"));
    if (parsed?.missing?.length) failures.push("missing=" + parsed.missing.join(","));
    if (parsed?.error) failures.push("error=" + String(parsed.error).slice(0, 300));
  }
  if (!hasSevenZip()) failures.push("7zip=missing");
  if (String(CFG.jmZipPassword || "") !== "FS") failures.push("zipPassword=not_FS");
  return failures;
}

function printFailure(failures, result) {
  console.error("[check:jm] failed: " + failures.join(" | "));
  if (result.stderr) console.error(result.stderr.trim());
  process.exitCode = 1;
}

function printSuccess(parsed) {
  console.log(JSON.stringify({
    ok: true,
    python: CFG.jmPython,
    source: parsed?.source || "not_configured",
    domains: parsed?.domains || 0,
    zipPassword: CFG.jmZipPassword,
    sevenZip: CFG.jmSevenZipPath || bundledSevenZipPath(),
  }, null, 2));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = runPythonCheck(options);
  const parsed = parseResult(result.stdout);
  const failures = collectFailures(result, parsed);

  if (failures.length) {
    printFailure(failures, result);
    return;
  }

  printSuccess(parsed);
}

main();
