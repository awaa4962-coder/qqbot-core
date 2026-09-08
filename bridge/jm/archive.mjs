import fs from "node:fs/promises";
import path from "node:path";
import { CFG } from "../config.mjs";
import { getSevenZipCommands } from "../seven-zip.mjs";
import { spawn } from "node:child_process";

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
  const password = String(options.password || "").trim();
  if (password) {
    const commands = getSevenZipCommands({ configured: options.sevenZipPath });
    for (const command of commands) {
      const ok = await runZipCommand(sourceDir, zipPath, command, buildSevenZipArgs(zipPath, password));
      if (ok) return;
    }
    throw new Error("zip_tool_missing");
  }

  const ok = await runZipCommand(sourceDir, zipPath, "tar", ["-a", "-cf", zipPath, "."]);
  if (ok) return;
  const ps = [
    "Compress-Archive",
    "-Path",
    "'*'",
    "-DestinationPath",
    "'" + zipPath.replace(/'/g, "''") + "'",
    "-Force",
  ].join(" ");
  const psOk = await runZipCommand(sourceDir, zipPath, "powershell", ["-NoProfile", "-Command", ps]);
  if (!psOk) throw new Error("zip_failed");
}

export function runZipCommand(cwd, zipPath, command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", async code => {
      if (code !== 0) return resolve(false);
      try {
        const stat = await fs.stat(zipPath);
        resolve(stat.size > 0);
      } catch {
        resolve(false);
      }
      return true;
    });
  });
}

export async function summarizeDirectory(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
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
