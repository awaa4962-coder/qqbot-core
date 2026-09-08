import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CFG } from "../config.mjs";
import { JM_CLEANUP_DELAY_MS, JM_TEMP_PREFIX, activeJmTempDirs, scheduleJmTempCleanup } from "./temporary.mjs";
import { buildJmTransferSuccessText, getJmZipPassword, summarizeDirectory, zipDirectory } from "./archive.mjs";
import { logE } from "../logger.mjs";
import { runJmDownload } from "./runtime.mjs";
import { sendMsg, sendPrivateMsg, uploadGroupFile, uploadPrivateFile } from "../napcat.mjs";

export async function transferJmToGroup(options) {
  const sender = options.sender || sendMsg;
  const uploader = options.uploader || uploadGroupFile;
  return await transferJm(options, {
    send: text => sender(options.groupId, text, options.replyToId),
    upload: (zipPath, name) => uploader(options.groupId, zipPath, name),
    started: "已开始下载，完成后会转发到群。",
    errorPrefix: "jm transfer failed:",
  });
}

export async function transferJmToPrivate(options) {
  const sender = options.sender || sendPrivateMsg;
  const uploader = options.uploader || uploadPrivateFile;
  return await transferJm(options, {
    send: text => sender(options.userId, text),
    upload: (zipPath, name) => uploader(options.userId, zipPath, name),
    started: "已开始下载，完成后会私聊发给你。",
    errorPrefix: "private jm transfer failed:",
  });
}

async function transferJm(options, destination) {
  const runner = options.runner || runJmDownload;
  const zipper = options.zipper || zipDirectory;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), JM_TEMP_PREFIX));
  activeJmTempDirs.add(path.resolve(tempDir));
  const downloadDir = path.join(tempDir, "download");
  const zipPath = path.join(tempDir, "jm-" + options.jmId + ".zip");

  try {
    await fs.mkdir(downloadDir, { recursive: true });
    await destination.send("JM " + options.jmId + " " + destination.started);

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
    const uploadResult = await destination.upload(zipPath, "jm-" + options.jmId + ".zip");
    if (!uploadOk(uploadResult)) throw new Error("upload_failed");

    await destination.send(buildJmTransferSuccessText(options.jmId, summary, zipPassword));
    return { ok: true, jmId: options.jmId, files: summary.files, bytes: summary.bytes };
  } catch (error) {
    logE(destination.errorPrefix, error.message, formatJmErrorDetail(error));
    await destination.send(jmErrorText(error.message));
    return { ok: false, reason: error.message };
  } finally {
    activeJmTempDirs.delete(path.resolve(tempDir));
    scheduleJmTempCleanup(tempDir, options.cleanupDelayMs ?? JM_CLEANUP_DELAY_MS);
  }
}

export function formatJmErrorDetail(error) {
  const missing = Array.isArray(error.missing) && error.missing.length
    ? " missing=" + error.missing.join(",")
    : "";
  const detail = error.detail ? " detail=" + String(error.detail).slice(0, 300) : "";
  return (missing + detail).trim();
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

export function uploadOk(result) {
  return result?.status === "ok" || result?.retcode === 0;
}
