// scripts/runtime-paths.mjs - shared runtime executable discovery.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONED_SHELL_PATTERN = /^NapCat\.v(\d+)\.(\d+)\.(\d+)\.Shell$/i;

export function resolveNapCatExe(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const explicit = String(options.explicit || process.env.QQBOT_NAPCAT_EXE || "").trim();
  if (explicit) return path.resolve(explicit);

  const configured = readOptionalPath(path.join(root, ".env_napcat_exe"));
  if (configured) return path.resolve(configured);

  const napcatRoot = path.join(root, "NapCat");
  const versioned = listVersionedShells(napcatRoot);
  const candidates = versioned.concat([
    path.join(napcatRoot, "NapCat.44498.Shell", "NapCatWinBootMain.exe"),
  ]);
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

export function prepareNapCatLaunch(options = {}) {
  const executable = resolveNapCatExe(options);
  const runtimeDir = path.dirname(executable);
  const mainModule = path.join(runtimeDir, "napcat.mjs");
  const hook = path.join(runtimeDir, "NapCatWinBootHook.dll");
  const qqExecutable = path.join(runtimeDir, "QQ.exe");
  if (![mainModule, hook, qqExecutable].every(filename => fs.existsSync(filename))) {
    return { executable, args: [], cwd: runtimeDir, env: process.env, mode: "legacy-shell" };
  }

  const loadModule = path.join(runtimeDir, "loadNapCat.js");
  const patchPackage = path.join(runtimeDir, "qqnt.json");
  const importUrl = pathToImportUrl(mainModule);
  fs.writeFileSync(loadModule, `(async () => {await import("${importUrl}")})()\n`, "utf8");

  const account = readQuickLoginAccount(path.join(runtimeDir, "config", "webui.json"));
  const args = [qqExecutable, hook];
  if (account) args.push("-q", account);
  return {
    executable,
    args,
    cwd: runtimeDir,
    mode: "official-injection",
    env: {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: patchPackage,
      NAPCAT_LOAD_PATH: loadModule,
      NAPCAT_INJECT_PATH: hook,
      NAPCAT_LAUNCHER_PATH: executable,
      NAPCAT_MAIN_PATH: mainModule,
    },
  };
}

export function listVersionedShells(napcatRoot) {
  try {
    return fs.readdirSync(napcatRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && VERSIONED_SHELL_PATTERN.test(entry.name))
      .map(entry => {
        const match = entry.name.match(VERSIONED_SHELL_PATTERN);
        return {
          path: path.join(napcatRoot, entry.name, "NapCatWinBootMain.exe"),
          version: match.slice(1).map(Number),
          complete: isCompleteOfficialRuntime(path.join(napcatRoot, entry.name)),
        };
      })
      .sort((left, right) =>
        Number(right.complete) - Number(left.complete) ||
        compareVersion(right.version, left.version)
      )
      .map(entry => entry.path);
  } catch {
    return [];
  }
}

export function isCompleteOfficialRuntime(runtimeDir) {
  return [
    "NapCatWinBootMain.exe",
    "NapCatWinBootHook.dll",
    "QQ.exe",
    "napcat.mjs",
  ].every(filename => fs.existsSync(path.join(runtimeDir, filename)));
}

function pathToImportUrl(filename) {
  return "file:///" + filename.replaceAll("\\", "/");
}

function readQuickLoginAccount(filename) {
  try {
    const config = JSON.parse(fs.readFileSync(filename, "utf8"));
    const account = String(config?.autoLoginAccount || "").trim();
    return /^\d+$/.test(account) ? account : "";
  } catch {
    return "";
  }
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function readOptionalPath(filename) {
  try {
    return fs.readFileSync(filename, "utf8").trim();
  } catch {
    return "";
  }
}
