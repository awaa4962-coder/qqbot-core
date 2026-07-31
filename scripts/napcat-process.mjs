// scripts/napcat-process.mjs - path-scoped NapCat process discovery.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function hasNapCatProcess(options = {}) {
  const configuredRuntime = String(options.runtimeDir || "").trim();
  if (!configuredRuntime) return false;
  const runtimeDir = path.resolve(configuredRuntime);
  const run = options.execFileAsync || execFileAsync;
  const escapedRuntime = runtimeDir.replaceAll("'", "''");
  const script = [
    "$runtime = '" + escapedRuntime + "';",
    "Get-CimInstance Win32_Process |",
    "Where-Object { $_.ExecutablePath -and",
    "[IO.Path]::GetDirectoryName($_.ExecutablePath) -eq $runtime -and",
    "@('NapCatWinBootMain.exe', 'QQ.exe') -contains $_.Name } |",
    "Select-Object -First 1 -ExpandProperty ProcessId",
  ].join(" ");
  try {
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { windowsHide: true, timeout: 5000 });
    return Boolean(String(result.stdout || "").trim());
  } catch {
    return false;
  }
}
