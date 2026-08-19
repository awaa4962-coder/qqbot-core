import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const COMMON_COMMANDS = [
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  "7z",
  "7za",
];

export function getBundledSevenZipPath() {
  try {
    return String(require("7zip-bin").path7za || "").trim();
  } catch {
    return "";
  }
}

export function getSevenZipCommands(options = {}) {
  const configured = String(options.configured || "").trim();
  if (configured) return [configured];
  const bundled = Object.prototype.hasOwnProperty.call(options, "bundledPath")
    ? String(options.bundledPath || "").trim()
    : getBundledSevenZipPath();
  const common = Array.isArray(options.commonCommands) ? options.commonCommands : COMMON_COMMANDS;
  return [...new Set([bundled, ...common].map(String).map(item => item.trim()).filter(Boolean))];
}

export function findUsableSevenZip(options = {}) {
  const runner = options.runner || spawnSync;
  for (const command of getSevenZipCommands(options)) {
    const result = runner(command, ["i"], {
      stdio: "ignore",
      timeout: Number(options.timeoutMs || 5000),
      windowsHide: true,
    });
    if (!result?.error && result?.status === 0) return command;
  }
  return "";
}
