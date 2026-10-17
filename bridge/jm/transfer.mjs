import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CFG } from "../config.mjs";
import { JM_CLEANUP_DELAY_MS, JM_TEMP_PREFIX, activeJmTempDirs, scheduleJmTempCleanup } from "./temporary.mjs";
import { buildJmTransferSuccessText, getJmZipPassword, summarizeDirectory, zipDirectory } from "./archive.mjs";
import { logE } from "../logger.mjs";
import { runJmDownload } from "./runtime.mjs";
import { sendMsg, sendPrivateMsg, uploadGroupFile, uploadPrivateFile } from "../napcat.mjs";
import { classifyOneBotReceipt, isOneBotResponseSuccessful } from "../onebot-receipt.mjs";
import { createJmDeadline, buildJmProgressText, JM_ACK_TIMEOUT_MS, JM_NOTICE_TIMEOUT_MS } from "./deadline.mjs";

export async function transferJmToGroup(options) {
  const sender = options.sender || sendMsg;
  const uploader = options.uploader || uploadGroupFile;
  return await transferJm(options, {
    send: (text, sendOptions) => sender(options.groupId, text, options.replyToId, sendOptions),
    upload: (zipPath, name, uploadOptions) => uploader(options.groupId, zipPath, name, uploadOptions),
    dispatchTracked: uploader === uploadGroupFile || options.trackUploadDispatch === true,
    started: "已开始下载，完成后会转发到群。",
    errorPrefix: "jm transfer failed:",
  });
}

export async function transferJmToPrivate(options) {
  const sender = options.sender || sendPrivateMsg;
  const uploader = options.uploader || uploadPrivateFile;
  return await transferJm(options, {
    send: (text, sendOptions) => sender(options.userId, text, sendOptions),
    upload: (zipPath, name, uploadOptions) => uploader(options.userId, zipPath, name, uploadOptions),
    dispatchTracked: uploader === uploadPrivateFile || options.trackUploadDispatch === true,
    started: "已开始下载，完成后会私聊发给你。",
    errorPrefix: "private jm transfer failed:",
  });
}

async function transferJm(options, destination) {
  const assertAllowed = options.assertAllowed || (() => {});
  let tempDir, downloadDir, timeoutNotice;
  let uploadMayBeSubmitted = false;
  const progressController = new AbortController();
  const budget = createJmDeadline({ startedAt: options.startedAt, timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
    progressDelayMs: options.progressDelayMs, signal: options.signal, onPhase: options.onPhase,
    onProgress: async state => {
      if (progressController.signal.aborted || budget.signal.aborted) return;
      await sendJmNotice(destination, buildJmProgressText(state), options, budget, {
        signal: AbortSignal.any([budget.signal, progressController.signal]),
      });
    },
    onDeadline: () => {
      progressController.abort();
      try { options.onPhase?.({ phase: "cancelling" }); } catch { /* Still report the deadline if task metadata is unavailable. */ }
      timeoutNotice = sendJmNotice(destination,
        jmErrorText(uploadMayBeSubmitted ? "upload_unconfirmed" : "job_timeout"), options, budget);
    },
  });

  try {
    budget.check();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), JM_TEMP_PREFIX));
    activeJmTempDirs.add(path.resolve(tempDir));
    downloadDir = path.join(tempDir, "download");
    const zipPath = path.join(tempDir, "jm-" + options.jmId + ".zip");
    await fs.mkdir(downloadDir, { recursive: true });
    budget.check();
    assertAllowed();
    if (options.startedNotice !== false) await sendJmNotice(destination,
      "JM " + options.jmId + " " + destination.started, options, budget,
      { signal: budget.signal, timeoutMs: JM_ACK_TIMEOUT_MS });

    const { summary, zipPassword } = await downloadJmArchive(options, budget, { downloadDir, zipPath, assertAllowed });
    budget.check();
    assertAllowed();
    budget.progress({ phase: "uploading" });
    // A custom uploader without dispatch tracking is conservatively treated as possibly submitted.
    uploadMayBeSubmitted = !destination.dispatchTracked;
    const uploadResult = await destination.upload(zipPath, "jm-" + options.jmId + ".zip", {
      signal: budget.signal, totalTimeoutMs: budget.remainingMs(), timeoutMs: budget.remainingMs(), chunkSize: 1024 * 1024,
      onRequestDispatched: () => { budget.check(); assertAllowed(); uploadMayBeSubmitted = true; },
      onProgress: () => budget.progress({ phase: "uploading" }),
    });
    budget.check();
    if (!uploadOk(uploadResult)) {
      assertAllowed();
      throw new Error(classifyOneBotReceipt(uploadResult) === "failed" ? "upload_failed" : "upload_unconfirmed");
    }

    budget.finish();
    progressController.abort();
    const noticeConfirmed = await sendJmNotice(destination, buildJmTransferSuccessText(options.jmId, summary, zipPassword), options, budget);
    return { ok: true, jmId: options.jmId, files: summary.files, bytes: summary.bytes, noticeConfirmed };
  } catch (error) {
    budget.finish();
    progressController.abort();
    if (budget.expired) {
      if (timeoutNotice) await timeoutNotice;
      return { ok: false, reason: uploadMayBeSubmitted ? "upload_unconfirmed" : "job_timeout" };
    }
    return reportJmFailure(error, destination, options, budget);
  } finally {
    budget.finish();
    progressController.abort();
    if (tempDir) {
      activeJmTempDirs.delete(path.resolve(tempDir));
      scheduleJmTempCleanup(tempDir, options.cleanupDelayMs ?? JM_CLEANUP_DELAY_MS);
    }
  }
}

async function downloadJmArchive(options, budget, paths) {
  budget.check();
  budget.progress({ phase: "downloading" });
  const result = await (options.runner || runJmDownload)(options.jmId, paths.downloadDir, {
    timeoutMs: budget.remainingMs(), signal: budget.signal, onProgress: state => budget.progress(state),
  });
  budget.check();
  if (!result.ok || result.all_success === false) throw jmDownloadError(result);
  paths.assertAllowed();
  const summary = await summarizeDirectory(paths.downloadDir, { signal: budget.signal });
  if (summary.files <= 0) throw new Error("empty_result");
  budget.check();
  budget.progress({ phase: "packing", completed: summary.files, bytes: summary.bytes });
  const zipPassword = getJmZipPassword(options);
  await (options.zipper || zipDirectory)(paths.downloadDir, paths.zipPath, {
    password: zipPassword, sevenZipPath: options.sevenZipPath ?? CFG.jmSevenZipPath,
    timeoutMs: Math.min(options.zipTimeoutMs || budget.remainingMs(), budget.remainingMs()), signal: budget.signal,
  });
  return { summary, zipPassword };
}

function jmDownloadError(result) {
  return Object.assign(new Error(result.reason || "download_failed"), {
    missing: result.missing || [], failedImages: result.failedImages,
    failedPhotos: result.failedPhotos, errorCodes: result.errorCodes,
  });
}

async function reportJmFailure(error, destination, options, budget) {
  const reason = /^[a-z_]{1,64}$/.test(error.message) ? error.message : "download_failed";
  logE(destination.errorPrefix, reason, formatJmErrorDetail(error));
  if (reason !== "permission_changed" && !options.signal?.aborted) await sendJmNotice(destination, jmErrorText(reason), options, budget);
  return { ok: false, reason };
}

async function sendJmNotice(destination, text, options, budget, limits = {}) {
  try {
    options.assertAllowed?.();
    options.signal?.throwIfAborted();
    const timeoutMs = Math.max(0, Math.min(limits.timeoutMs || JM_NOTICE_TIMEOUT_MS, budget.responseRemainingMs()));
    if (timeoutMs < 1) return false;
    const timeout = AbortSignal.timeout(Math.trunc(timeoutMs));
    const signals = [timeout, options.signal, limits.signal].filter(Boolean);
    const signal = signals.length === 1 ? timeout : AbortSignal.any(signals);
    if (signal.aborted) return false;
    return classifyOneBotReceipt(await destination.send(text, { signal, timeoutMs, maxAttempts: 1,
      stopReason: () => signal.aborted ? "cancelled" : "" })) === "sent";
  } catch { return false; }
}

export function formatJmErrorDetail(error) {
  const missing = Array.isArray(error.missing) && error.missing.length
    ? " missing=" + error.missing.filter(item => /^[a-zA-Z0-9_.-]{1,64}$/.test(item)).join(",")
    : "";
  const counts = ["failedImages", "failedPhotos"].filter(key => Number.isSafeInteger(error[key]) && error[key] >= 0)
    .map(key => key + "=" + error[key]).join(" ");
  const codes = Array.isArray(error.errorCodes) ? error.errorCodes.filter(code => /^[a-z_]{1,32}$/.test(code)).slice(0, 8) : [];
  return [missing.trim(), counts, codes.length ? "codes=" + codes.join(",") : ""].filter(Boolean).join(" ");
}

export function jmErrorText(reason) {
  if (reason === "job_timeout") return "JM 已到本次处理时限（最多90秒），已禁止后续转发并请求停止后台任务。临时文件保留约1天。";
  if (reason === "missing_jmcomic_source") return "JM 运行依赖不完整，缺少 jmcomic 源码文件，已停止任务，没有保存文件。";
  if (reason === "missing_python_dependency") return "JM Python 依赖缺失或安装失败，已停止任务，没有保存文件。";
  if (reason === "jmcomic_import_failed") return "JM 模块导入失败，可能是源码版本不完整或依赖不匹配。";
  if (reason === "missing_dependency") return "JM 依赖还没安装或不可用，已回退，没有保存文件。";
  if (reason === "timeout") return "JM 下载超时，已停止任务，临时文件会在约 1 天后自动清理。";
  if (reason === "empty_result") return "JM 下载没有产出文件，临时目录会在约 1 天后自动清理。";
  if (reason === "upload_failed") return "JM 已下载但转发失败，临时文件会在约 1 天后自动清理。";
  if (reason === "upload_unconfirmed") return "JM 转发结果未确认，请先在 QQ 核实，不会自动重发；临时文件仍保留约 1 天。";
  if (reason === "zip_tool_missing") return "JM 已下载但缺少 7-Zip，无法生成带密码压缩包。";
  if (reason === "zip_failed") return "JM 已下载但打包失败，临时文件会在约 1 天后自动清理。";
  if (reason === "zip_timeout") return "JM 打包超时，已停止打包，临时文件会在约 1 天后自动清理。";
  return "JM 下载失败，临时文件会在约 1 天后自动清理。";
}

export function uploadOk(result) {
  return isOneBotResponseSuccessful(result);
}
