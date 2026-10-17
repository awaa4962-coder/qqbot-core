import fs from "node:fs/promises";
import path from "node:path";
import { CFG } from "../config.mjs";
import { getSevenZipCommands } from "../seven-zip.mjs";
import { spawn } from "node:child_process";
import { monotonicNow } from "../runtime-clock.mjs";

const DEFAULT_ZIP_TIMEOUT_MS = 120000;

export function getJmZipPassword(options) {
  if (Object.prototype.hasOwnProperty.call(options, "zipPassword")) {
    return String(options.zipPassword || "").trim();
  }
  return String(CFG.jmZipPassword || "").trim();
}

export function buildJmTransferSuccessText(jmId, summary, password) {
  const passwordText = password ? "解压密码：" + password + "。" : "";
  return "JM " + jmId + " 已转发，文件 " + summary.files + " 个，约 " + formatBytes(summary.bytes) + "。" +
    passwordText + "临时文件会在约 1 天后自动清理。";
}

export function buildSevenZipArgs(zipPath, password) {
  return ["a", "-tzip", "-mx=0", "-mem=AES256", "-p" + password, zipPath, "."];
}

export async function zipDirectory(sourceDir, zipPath, options = {}) {
  const deadline = monotonicNow() + zipTimeout(options.timeoutMs);
  const run = (command, args) => {
    options.signal?.throwIfAborted();
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) throw new Error("zip_timeout");
    return runZipCommand(sourceDir, zipPath, command, args, { ...options, timeoutMs: remaining });
  };
  const password = String(options.password || "").trim();
  options.signal?.throwIfAborted();
  if (password) {
    const commands = getSevenZipCommands({ configured: options.sevenZipPath });
    for (const command of commands) {
      const ok = await run(command, buildSevenZipArgs(zipPath, password));
      if (ok) return;
    }
    throw new Error("zip_tool_missing");
  }

  const ok = await run("tar", ["-a", "-cf", zipPath, "."]);
  if (ok) return;
  const ps = [
    "Compress-Archive",
    "-Path",
    "'*'",
    "-DestinationPath",
    "'" + zipPath.replace(/'/g, "''") + "'",
    "-Force",
  ].join(" ");
  const psOk = await run("powershell", ["-NoProfile", "-Command", ps]);
  if (!psOk) throw new Error("zip_failed");
}

export function runZipCommand(cwd, zipPath, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(Object.assign(new Error("zip_timeout"), { code: "JM_DEADLINE" })); return; }
    const detached = process.platform !== "win32";
    const child = (options.spawnImpl || spawn)(command, args, { cwd, windowsHide: true, detached });
    let settled = false;
    let stopped = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      if (settled || stopped) return;
      stopped = true;
      try {
        if (detached && Number.isSafeInteger(child.pid) && child.pid > 0) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch { /* Wait for close before releasing this task. */ } }
    };
    const timer = setTimeout(abort, zipTimeout(options.timeoutMs));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => {
      if (stopped || (Number.isSafeInteger(child.pid) && child.pid > 0)) return;
      finish(false);
    });
    child.on("close", async code => {
      if (settled) return;
      if (stopped) { finish(false, new Error("zip_timeout")); return; }
      if (code !== 0) {
        finish(false);
        return;
      }
      try {
        const stat = await fs.stat(zipPath);
        finish(stat.size > 0);
      } catch {
        finish(false);
      }
    });
  });
}

function zipTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(1, timeout) : DEFAULT_ZIP_TIMEOUT_MS;
}

export async function summarizeDirectory(dir, options = {}) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    options.signal?.throwIfAborted();
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      options.signal?.throwIfAborted();
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        const stat = await fs.stat(full);
        files++;
        bytes += stat.size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

export function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + "GB";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return mb.toFixed(mb >= 10 ? 0 : 1) + "MB";
  const kb = bytes / 1024;
  return kb >= 1 ? kb.toFixed(kb >= 10 ? 0 : 1) + "KB" : bytes + "B";
}
