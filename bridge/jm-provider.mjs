import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { CFG } from "./config.mjs";
import { stripBotMention } from "./admin-commands.mjs";
import { isResourceGroupAllowed } from "./resource-transfer.mjs";
import { sendMsg, sendPrivateMsg, uploadGroupFile, uploadPrivateFile } from "./napcat.mjs";
import { log, logE } from "./logger.mjs";

const require = createRequire(import.meta.url);
const JM_RE = /^jm\s*([0-9]{3,})$/i;
const RESULT_PREFIX = "QQFRIEND_JM_RESULT ";
const JM_TEMP_PREFIX = "qqfriend-jm-";
const JM_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_ZIP_COMMON_PATHS = [
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  "7z",
  "7za",
];
let activeJmTask = null;

export function parseJmCommand(text, options = {}) {
  const source = options.requireMention
    ? stripBotMention(text, options.selfUin, options.botNames)
    : String(text || "").trim();
  const normalized = source.replace(/^[/\\]+/, "").trim();
  const match = normalized.match(JM_RE);
  if (!match) return null;
  return { ok: true, jmId: match[1] };
}

export async function handleJmTransferCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = parseJmCommand(ctx.text || ctx.rawText, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
  if (!parsed) return false;

  const sender = options.sender || sendMsg;
  if (!isResourceGroupAllowed(ctx.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist)) {
    await sender(ctx.group_id, "这个群没有开启资源转发白名单。", options.replyToId);
    return true;
  }

  if (activeJmTask) {
    await sender(ctx.group_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。", options.replyToId);
    return true;
  }

  activeJmTask = parsed.jmId;
  try {
    await transferJmToGroup({
      jmId: parsed.jmId,
      groupId: ctx.group_id,
      replyToId: options.replyToId,
      sender,
      uploader: options.uploader || uploadGroupFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    });
  } finally {
    activeJmTask = null;
  }
  return true;
}

export async function transferJmToGroup(options) {
  const sender = options.sender || sendMsg;
  const uploader = options.uploader || uploadGroupFile;
  const runner = options.runner || runJmDownload;
  const zipper = options.zipper || zipDirectory;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), JM_TEMP_PREFIX));
  const downloadDir = path.join(tempDir, "download");
  const zipPath = path.join(tempDir, "jm-" + options.jmId + ".zip");

  try {
    await fs.mkdir(downloadDir, { recursive: true });
    await sender(options.groupId, "JM " + options.jmId + " 已开始下载，完成后会转发到群。", options.replyToId);

    const result = await runner(options.jmId, downloadDir, {
      timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
    });
    if (!result.ok) {
      const error = new Error(result.reason || "download_failed");
      error.detail = result.error || "";
      error.missing = result.missing || [];
      throw error;
    }

    const summary = await summarizeDirectory(downloadDir);
    if (summary.files <= 0) throw new Error("empty_result");

    const zipPassword = getJmZipPassword(options);
    await zipper(downloadDir, zipPath, {
      password: zipPassword,
      sevenZipPath: options.sevenZipPath ?? CFG.jmSevenZipPath,
    });
    const uploadResult = await uploader(options.groupId, zipPath, "jm-" + options.jmId + ".zip");
    if (!uploadOk(uploadResult)) throw new Error("upload_failed");

    await sender(
      options.groupId,
      buildJmTransferSuccessText(options.jmId, summary, zipPassword),
      options.replyToId,
    );
    return { ok: true, jmId: options.jmId, files: summary.files, bytes: summary.bytes };
  } catch (error) {
    logE("jm transfer failed:", error.message, formatJmErrorDetail(error));
    await sender(options.groupId, jmErrorText(error.message), options.replyToId);
    return { ok: false, reason: error.message };
  } finally {
    scheduleJmTempCleanup(tempDir, options.cleanupDelayMs ?? JM_CLEANUP_DELAY_MS);
  }
}

export function isJmUserAllowed(userId, whitelist = CFG.jmUserWhitelist) {
  return whitelist.map(Number).includes(Number(userId));
}

export async function handlePrivateJmTransferCommand(ctx, options = {}) {
  const parsed = parsePrivateJmCommand(ctx, options);
  if (!parsed) return false;

  const sender = options.sender || sendPrivateMsg;
  if (!isJmUserAllowed(ctx.user_id, options.userWhitelist || CFG.jmUserWhitelist)) {
    await sender(ctx.user_id, "你没有开启私聊 JM 下载权限。");
    return true;
  }

  if (activeJmTask) {
    await sender(ctx.user_id, "已有 JM 下载任务在运行，请等当前任务完成后再试。");
    return true;
  }

  activeJmTask = parsed.jmId;
  try {
    await transferJmToPrivate({
      jmId: parsed.jmId,
      userId: ctx.user_id,
      sender,
      uploader: options.uploader || uploadPrivateFile,
      runner: options.runner || runJmDownload,
      zipper: options.zipper || zipDirectory,
    });
  } finally {
    activeJmTask = null;
  }
  return true;
}

function parsePrivateJmCommand(ctx, options) {
  const text = ctx?.text || ctx?.rawText;
  return parseJmCommand(text, { requireMention: false }) || parseJmCommand(text, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
}

export async function transferJmToPrivate(options) {
  const sender = options.sender || sendPrivateMsg;
  const uploader = options.uploader || uploadPrivateFile;
  const runner = options.runner || runJmDownload;
  const zipper = options.zipper || zipDirectory;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), JM_TEMP_PREFIX));
  const downloadDir = path.join(tempDir, "download");
  const zipPath = path.join(tempDir, "jm-" + options.jmId + ".zip");

  try {
    await fs.mkdir(downloadDir, { recursive: true });
    await sender(options.userId, "JM " + options.jmId + " 已开始下载，完成后会私聊发给你。");

    const result = await runner(options.jmId, downloadDir, {
      timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
    });
    if (!result.ok) {
      const error = new Error(result.reason || "download_failed");
      error.detail = result.error || "";
      error.missing = result.missing || [];
      throw error;
    }

    const summary = await summarizeDirectory(downloadDir);
    if (summary.files <= 0) throw new Error("empty_result");

    const zipPassword = getJmZipPassword(options);
    await zipper(downloadDir, zipPath, {
      password: zipPassword,
      sevenZipPath: options.sevenZipPath ?? CFG.jmSevenZipPath,
    });
    const uploadResult = await uploader(options.userId, zipPath, "jm-" + options.jmId + ".zip");
    if (!uploadOk(uploadResult)) throw new Error("upload_failed");

    await sender(options.userId, buildJmTransferSuccessText(options.jmId, summary, zipPassword));
    return { ok: true, jmId: options.jmId, files: summary.files, bytes: summary.bytes };
  } catch (error) {
    logE("private jm transfer failed:", error.message, formatJmErrorDetail(error));
    await sender(options.userId, jmErrorText(error.message));
    return { ok: false, reason: error.message };
  } finally {
    scheduleJmTempCleanup(tempDir, options.cleanupDelayMs ?? JM_CLEANUP_DELAY_MS);
  }
}

function formatJmErrorDetail(error) {
  const missing = Array.isArray(error.missing) && error.missing.length
    ? " missing=" + error.missing.join(",")
    : "";
  const detail = error.detail ? " detail=" + String(error.detail).slice(0, 300) : "";
  return (missing + detail).trim();
}

export function scheduleJmTempCleanup(tempDir, delayMs = JM_CLEANUP_DELAY_MS) {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true })
      .then(() => log("jm temp cleaned:", tempDir))
      .catch(error => logE("jm temp cleanup failed:", error.message));
  }, Math.max(0, delayMs));
  timer.unref?.();
  return timer;
}

export async function cleanupExpiredJmTempDirs(options = {}) {
  const root = options.root || os.tmpdir();
  const maxAgeMs = options.maxAgeMs ?? JM_CLEANUP_DELAY_MS;
  const now = options.now || Date.now();
  let items;
  try {
    items = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    logE("jm temp scan failed:", error.message);
    return 0;
  }

  let cleaned = 0;
  for (const item of items) {
    if (!item.isDirectory() || !item.name.startsWith(JM_TEMP_PREFIX)) continue;
    const fullPath = path.join(root, item.name);
    try {
      const stat = await fs.stat(fullPath);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.rm(fullPath, { recursive: true, force: true });
      cleaned++;
    } catch (error) {
      logE("jm temp cleanup failed:", error.message);
    }
  }
  if (cleaned) log("jm expired temp cleaned:", cleaned);
  return cleaned;
}

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

export function jmErrorText(reason) {
  if (reason === "missing_jmcomic_source") return "JM 运行依赖不完整，缺少 jmcomic 源码文件，已停止任务，没有保存文件。";
  if (reason === "missing_python_dependency") return "JM Python 依赖缺失或安装失败，已停止任务，没有保存文件。";
  if (reason === "jmcomic_import_failed") return "JM 模块导入失败，可能是源码版本不完整或依赖不匹配。";
  if (reason === "missing_dependency") return "JM 依赖还没安装或不可用，已回退，没有保存文件。";
  if (reason === "timeout") return "JM 下载超时，已停止任务，临时文件会在约 1 天后自动清理。";
  if (reason === "empty_result") return "JM 下载没有产出文件，临时目录会在约 1 天后自动清理。";
  if (reason === "upload_failed") return "JM 已下载但转发失败，临时文件会在约 1 天后自动清理。";
  if (reason === "zip_tool_missing") return "JM 已下载但缺少 7-Zip，无法生成带密码压缩包。";
  if (reason === "zip_failed") return "JM 已下载但打包失败，临时文件会在约 1 天后自动清理。";
  return "JM 下载失败，临时文件会在约 1 天后自动清理。";
}

async function runPythonJson({ command, args, env, timeoutMs }) {
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

function parseRunnerResult(stdout, stderr, code) {
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

function getJmZipPassword(options) {
  if (Object.prototype.hasOwnProperty.call(options, "zipPassword")) {
    return String(options.zipPassword || "").trim();
  }
  return String(CFG.jmZipPassword || "").trim();
}

function buildJmTransferSuccessText(jmId, summary, password) {
  const passwordText = password ? "解压密码：" + password + "。" : "";
  return "JM " + jmId + " 已转发，文件 " + summary.files + " 个，约 " + formatBytes(summary.bytes) + "。" +
    passwordText + "临时文件会在约 1 天后自动清理。";
}

export function buildSevenZipArgs(zipPath, password) {
  return ["a", "-tzip", "-mx=0", "-mem=AES256", "-p" + password, zipPath, "."];
}

function getSevenZipCommands(options = {}) {
  const configured = String(options.sevenZipPath || "").trim();
  if (configured) return [configured];
  const bundled = getBundledSevenZipPath();
  return bundled ? [...SEVEN_ZIP_COMMON_PATHS, bundled] : SEVEN_ZIP_COMMON_PATHS;
}

export function getBundledSevenZipPath() {
  try {
    return String(require("7zip-bin").path7za || "").trim();
  } catch {
    return "";
  }
}

export async function zipDirectory(sourceDir, zipPath, options = {}) {
  const password = String(options.password || "").trim();
  if (password) {
    const commands = getSevenZipCommands(options);
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

function runZipCommand(cwd, zipPath, command, args) {
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

async function summarizeDirectory(dir) {
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

function uploadOk(result) {
  return result?.status === "ok" || result?.retcode === 0;
}

function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + "GB";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return mb.toFixed(mb >= 10 ? 0 : 1) + "MB";
  const kb = bytes / 1024;
  return kb >= 1 ? kb.toFixed(kb >= 10 ? 0 : 1) + "KB" : bytes + "B";
}
