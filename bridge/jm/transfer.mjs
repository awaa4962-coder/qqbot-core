import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CFG } from "../config.mjs";
import { JM_CLEANUP_DELAY_MS, JM_TEMP_PREFIX, activeJmTempDirs, scheduleJmTempCleanup } from "./temporary.mjs";
import { buildJmTransferSuccessText, getJmZipPassword, summarizeDirectory, zipDirectory } from "./archive.mjs";
import { log, logE } from "../logger.mjs";
import { monotonicNow } from "../runtime-clock.mjs";
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
  const timings = jmPhaseTimings(options.startedAt ?? monotonicNow());
  const progressController = new AbortController();
  const budget = createJmDeadline({ startedAt: timings.startedAt, timeoutMs: options.timeoutMs || CFG.jmTimeoutMs,
    progressDelayMs: options.progressDelayMs, signal: options.signal, onPhase: state => {
      timings.enter(state.phase);
      options.onPhase?.(state);
    },
    onProgress: async state => {
      if (progressController.signal.aborted || budget.signal.aborted) return;
      await sendJmNotice(destination, buildJmProgressText(state), options, budget, {
        signal: AbortSignal.any([budget.signal, progressController.signal]),
      });
    },
    onDeadline: () => {
      progressController.abort();
      timings.enter("cancelling");
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
    uploadMayBeSubmitted = mayHaveSubmitted(uploadResult, uploadMayBeSubmitted);
    budget.check();
    requireUploadReceipt(uploadResult, uploadMayBeSubmitted, assertAllowed);

    budget.finish();
    progressController.abort();
    timings.enter("notification");
    const noticeConfirmed = await sendJmNotice(destination, buildJmTransferSuccessText(options.jmId, summary, zipPassword), options, budget);
    return { ok: true, jmId: options.jmId, files: summary.files, bytes: summary.bytes, noticeConfirmed };
  } catch (error) {
    budget.finish();
    progressController.abort();
    if (budget.expired) {
      if (timeoutNotice) await timeoutNotice;
      return { ok: false, reason: uploadMayBeSubmitted ? "upload_unconfirmed" : "job_timeout" };
    }
    if (options.signal?.aborted) return { ok: false, reason: uploadMayBeSubmitted ? "upload_unconfirmed" : "cancelled" };
    timings.enter("notification");
    return await reportJmFailure(uploadFailure(error, uploadMayBeSubmitted), destination, options, budget);
  } finally {
    budget.finish();
    progressController.abort();
    log("jm transfer timings:", JSON.stringify(timings.finish()));
    if (tempDir) {
      activeJmTempDirs.delete(path.resolve(tempDir));
      scheduleJmTempCleanup(tempDir, options.cleanupDelayMs ?? JM_CLEANUP_DELAY_MS);
    }
  }
}

function mayHaveSubmitted(receipt, tracked) {
  if (receipt?.uploadDispatched === true) return true;
  return tracked && !(receipt?.status === "cancelled" && receipt.uploadDispatched === false);
}

function requireUploadReceipt(uploadResult, uploadMayBeSubmitted, assertAllowed) {
  if (uploadOk(uploadResult)) return;
  if (!uploadMayBeSubmitted) assertAllowed();
  const rejected = !uploadMayBeSubmitted || classifyOneBotReceipt(uploadResult) === "failed";
  if (rejected) throw Object.assign(new Error("upload_failed"), { code: "JM_UPLOAD_REJECTED" });
  throw new Error("upload_unconfirmed");
}

function uploadFailure(error, mayBeSubmitted) {
  return mayBeSubmitted && error?.code !== "JM_UPLOAD_REJECTED" ? new Error("upload_unconfirmed") : error;
}

function jmPhaseTimings(startedAt) {
  const measured = {};
  let phase = "preparing", milestone = startedAt;
  function enter(next) {
    if (next === phase) return;
    const now = monotonicNow();
    const key = phase + "Ms";
    measured[key] = (measured[key] || 0) + Math.max(0, Math.round(now - milestone));
    phase = next;
    milestone = now;
  }
  return { startedAt, enter, finish: () => { enter("done"); return measured; } };
}

async function downloadJmArchive(options, budget, paths) {
  budget.check();
  budget.progress({ phase: "downloading" });
  const result = await (options.runner || runJmDownload)(options.jmId, paths.downloadDir, {
    timeoutMs: budget.remainingMs(), signal: budget.signal, onProgress: state => budget.progress(state),
  });
  budget.check();
  if (!result.ok) throw jmDownloadError(result);
  if (result.all_success === false) throw new Error("incomplete_result");
  paths.assertAllowed();
  const summary = await summarizeDirectory(paths.downloadDir, { signal: budget.signal });
  if (summary.files <= 0) throw new Error("empty_result");
  if (["files", "bytes"].some(key => result[key] !== undefined && result[key] !== summary[key])) {
    throw new Error("incomplete_result");
  }
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
  const codes = result.errorCodes || [];
  const reason = codes.includes("incomplete") ? "incomplete_result"
    : codes.includes("metadata_retry_limit") ? "metadata_retry_limit" : result.reason || "download_failed";
  return Object.assign(new Error(reason), {
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

const JM_ERROR_TEXT = {
  job_timeout: "JM 已到本次处理时限（最多90秒），已禁止后续转发并请求停止后台任务。临时文件保留约1天。",
  missing_jmcomic_source: "JM 运行依赖不完整，缺少 jmcomic 源码文件，已停止任务，没有保存文件。",
  missing_python_dependency: "JM Python 依赖缺失或安装失败，已停止任务，没有保存文件。",
  jmcomic_import_failed: "JM 模块导入失败，可能是源码版本不完整或依赖不匹配。",
  missing_dependency: "JM 依赖还没安装或不可用，已回退，没有保存文件。",
  timeout: "JM 下载超时，已停止任务，临时文件会在约 1 天后自动清理。",
  metadata_retry_limit: "JM 没能在重试上限内取得目录或章节信息，已停止下载。",
  incomplete_result: "JM 没有下载完整，未打包或转发。临时文件会在约 1 天后自动清理。",
  worker_exited: "JM 下载进程未能正常运行，没有转发文件。",
  worker_start_failed: "JM 下载进程未能正常运行，没有转发文件。",
  cancelled: "JM 任务已取消，没有提交文件转发。",
  permission_changed: "JM 权限已变化，已停止后续处理。",
  empty_result: "JM 下载没有产出文件，临时目录会在约 1 天后自动清理。",
  upload_failed: "JM 已下载但转发失败，临时文件会在约 1 天后自动清理。",
  upload_unconfirmed: "JM 转发结果未确认，请先在 QQ 核实，不会自动重发；临时文件仍保留约 1 天。",
  zip_tool_missing: "JM 已下载但缺少 7-Zip，无法生成带密码压缩包。",
  zip_failed: "JM 已下载但打包失败，临时文件会在约 1 天后自动清理。",
  zip_timeout: "JM 打包超时，已停止打包，临时文件会在约 1 天后自动清理。",
};

export function jmErrorText(reason) {
  return Object.hasOwn(JM_ERROR_TEXT, reason) ? JM_ERROR_TEXT[reason] : "JM 下载失败，临时文件会在约 1 天后自动清理。";
}

export function uploadOk(result) {
  return isOneBotResponseSuccessful(result);
}
