import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CFG } from "./config.mjs";
import { prepareCommandText } from "./commands/normalize.mjs";
import { fetchSafeResponse, validateSafeUrl } from "./safe-url.mjs";
import { sendMsg, uploadGroupFile } from "./napcat.mjs";
import { log, logE } from "./logger.mjs";
import { classifyOneBotReceipt } from "./onebot-receipt.mjs";
import { createTaskRunner, taskEventKey } from "./tasks/runner.mjs";
import { messageRouteRejection } from "./event-admission.mjs";

const COMMAND_RE = /^(download|dl|fetch|下载)\s*(.*)$/i;
const DEFAULT_TIMEOUT_MS = 120000;
const RESOURCE_TEMP_PREFIX = "qqfriend-resource-";
const DEFAULT_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const activeResourceTempDirs = new Set();
const resourceShutdown = new AbortController();
const resourceTasks = createTaskRunner({ filename: path.join(CFG.dataRoot, ".qqfriend", "tasks",
  process.env.NODE_ENV === "test" ? `resource-transfers-${process.pid}.json` : "resource-transfers.json"),
  maxConcurrent: 1, historyLimit: 256, busyMessage: "已有资源转发任务在运行，请稍后再试。",
  resultError: result => resourceErrorText(result.reason) });

export function waitResourceTasks() { return resourceTasks.wait(); }
export function listResourceTasks() { return resourceTasks.list(); }
export async function stopResourceTasks() {
  resourceShutdown.abort();
  await waitResourceTasks();
  return true;
}

export function isResourceGroupAllowed(groupId, whitelist = CFG.resourceGroupWhitelist) {
  return whitelist.map(Number).includes(Number(groupId));
}

export function parseResourceTransferCommand(text, options = {}) {
  const normalized = prepareCommandText(text, options);
  const match = normalized.match(COMMAND_RE);
  if (!match) return null;

  const url = extractFirstUrl(match[2] || "");
  if (!url) return { ok: false, reason: "missing_url", url: "" };

  const safe = validateSafeUrl(url);
  if (!safe.ok) return { ok: false, reason: safe.reason, url };
  return { ok: true, reason: "", url: safe.url.href };
}

export async function handleResourceTransferCommand(ctx, options = {}) {
  if (!ctx?.isAtMe) return false;
  const parsed = options.parsedCommand || parseResourceTransferCommand(ctx.text || ctx.rawText, {
    requireMention: true,
    selfUin: options.selfUin ?? CFG.selfUin,
    botNames: options.botNames ?? CFG.botNames,
  });
  if (!parsed) return false;
  if (resourceShutdown.signal.aborted) return true;

  const scope = { message_type: "group", group_id: ctx.group_id, user_id: ctx.user_id };
  const routeAllowed = () => !messageRouteRejection(scope);
  const groupAllowed = () => isResourceGroupAllowed(scope.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist);
  const delivery = { groupId: scope.group_id, replyToId: options.replyToId, sender: options.sender, signal: resourceShutdown.signal };
  if (!routeAllowed()) return true;
  if (!groupAllowed()) {
    await notifyResource({ ...delivery, assertAllowed: () => requireResourcePermission(routeAllowed) }, "这个群没有开启资源转发白名单。");
    return true;
  }
  delivery.assertAllowed = () => requireResourcePermission(() => routeAllowed() && groupAllowed());

  if (!parsed.ok) {
    await notifyResource(delivery, resourceErrorText(parsed.reason));
    return true;
  }

  await launchResourceTask(ctx.message_id, { ...delivery, url: parsed.url, uploader: options.uploader,
    trackUploadDispatch: options.trackUploadDispatch, maxBytes: options.maxBytes });
  return true;
}

function requireResourcePermission(allowed) {
  if (!allowed()) throw new Error("permission_changed");
}

async function launchResourceTask(messageId, options) {
  const eventKey = taskEventKey("group", options.groupId, messageId);
  try {
    if (resourceTasks.hasEvent(eventKey)) {
      await notifyResource(options, "这条资源任务已经受理过，请先核实原任务结果，不会自动重做。");
      return;
    }
  } catch {
    await notifyResource(options, "资源任务没能启动，请稍后检查运行状态。");
    return;
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    resourceTasks.start({ scope: "resource", action: "transfer", meta: { kind: "group", eventKey }, run: async ({ signal }) => {
      const taskSignal = AbortSignal.any([signal, resourceShutdown.signal]);
      if (taskSignal.aborted) return { ok: false, reason: "cancelled" };
      // Cancellation also opens the gate when a start notice has not settled yet.
      taskSignal.addEventListener("abort", release, { once: true });
      try { await gate; }
      finally { taskSignal.removeEventListener("abort", release); }
      return transferResourceToGroup({ ...options, signal: taskSignal });
    } });
  } catch (error) {
    const busy = error.message === "已有资源转发任务在运行，请稍后再试。" || error.message === "后台任务已满，请稍后再试";
    await notifyResource(options, busy ? "已有资源转发任务在运行，请稍后再试。" :
      "资源任务没能启动，请稍后检查运行状态。");
    return;
  }
  try { await notifyResource(options, "资源下载已开始，完成后会转发到群。"); }
  finally { release(); }
}

function assertResourceAllowed(options) {
  options.signal?.throwIfAborted();
  options.assertAllowed?.();
  options.signal?.throwIfAborted();
}

async function notifyResource(options, text) {
  try {
    assertResourceAllowed(options);
    const receipt = await (options.sender || sendMsg)(options.groupId, text, options.replyToId, {
      signal: options.signal, maxAttempts: 1, stopReason: () => {
        try { assertResourceAllowed(options); return ""; }
        catch { return options.signal?.aborted ? "cancelled" : "permission_changed"; }
      },
    });
    return classifyOneBotReceipt(receipt) === "sent";
  } catch { return false; }
}

export async function transferResourceToGroup(options) {
  let downloaded = null;
  let reason = "";
  try {
    assertResourceAllowed(options);
    downloaded = await downloadResourceToTemp(options.url, {
      maxBytes: options.maxBytes || CFG.resourceMaxBytes,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
    await uploadResource(options, downloaded);
  } catch (error) {
    reason = resourceFailureReason(error, options.signal);
  } finally {
    if (downloaded?.tempDir) await tryCleanupTempDir(downloaded.tempDir);
  }
  if (reason) {
    logE("resource transfer failed:", reason);
    if (reason !== "permission_changed" && reason !== "cancelled") await notifyResource(options, resourceErrorText(reason));
    return { ok: false, reason };
  }
  const noticeConfirmed = await notifyResource(options, "资源已转发，大小 " + formatBytes(downloaded.bytes) + "。");
  return { ok: true, bytes: downloaded.bytes, fileName: downloaded.fileName, noticeConfirmed };
}

async function uploadResource(options, downloaded) {
  assertResourceAllowed(options);
  const uploader = options.uploader || uploadGroupFile;
  // Without a transport dispatch hook, invoking a custom uploader may already submit the file.
  let mayHaveDispatched = uploader !== uploadGroupFile && options.trackUploadDispatch !== true;
  let blocked = false;
  let receipt;
  try {
    receipt = await uploader(options.groupId, downloaded.filePath, downloaded.fileName, {
      signal: options.signal,
      onRequestDispatched() {
        try { assertResourceAllowed(options); }
        catch (error) { blocked = true; throw error; }
        mayHaveDispatched = true;
      },
    });
  } catch { /* Classify transport failures using the dispatch boundary. */ }
  if (blocked) throw new Error(options.signal?.aborted ? "cancelled" : "permission_changed");
  requireUploadReceipt(receipt, mayHaveDispatched, options.signal);
}

function requireUploadReceipt(receipt, mayHaveDispatched, signal) {
  const delivery = classifyOneBotReceipt(receipt, { allowIdOnly: false });
  if (delivery === "sent") return;
  if (delivery === "failed") throw new Error("upload_failed");
  if (delivery === "cancelled" && receipt.uploadDispatched === false) throw new Error("cancelled");
  if (mayHaveDispatched || receipt?.uploadDispatched === true) throw new Error("upload_unconfirmed");
  throw new Error(signal?.aborted ? "cancelled" : "upload_failed");
}

function resourceFailureReason(error, signal) {
  const reason = error?.message;
  if (reason === "upload_unconfirmed" || reason === "upload_failed") return reason;
  if (signal?.aborted) return "cancelled";
  return /^[a-z_]{1,64}$/.test(reason || "") ? reason : "download_failed";
}

export async function downloadResourceToTemp(url, options = {}) {
  const maxBytes = options.maxBytes || CFG.resourceMaxBytes;
  options.signal?.throwIfAborted();
  const result = await fetchSafeResponse(url, { timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal });
  const response = await validateDownloadResponse(result, maxBytes, options.signal);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), RESOURCE_TEMP_PREFIX));
  activeResourceTempDirs.add(path.resolve(tempDir));
  const fileName = safeFileName(response, result.url);
  const filePath = path.join(tempDir, fileName);
  let bytes;
  try {
    bytes = await writeBodyToFile(response.body, filePath, maxBytes, options.signal);
  } catch (error) {
    await tryCleanupTempDir(tempDir);
    throw error;
  }

  if (bytes <= 0) {
    await tryCleanupTempDir(tempDir);
    throw new Error("empty_body");
  }
  log("resource downloaded:", fileName, formatBytes(bytes));
  return { tempDir, filePath, fileName, bytes, url: result.url?.href || url };
}

async function validateDownloadResponse(result, maxBytes, signal) {
  if (!result.ok) throw new Error(result.reason || "blocked_url");
  const { response } = result;
  const rejection = resourceResponseRejection(response, maxBytes);
  if (signal?.aborted || rejection) {
    try { await response?.body?.cancel(); } catch {}
    signal?.throwIfAborted();
    throw new Error(rejection);
  }
  return response;
}

function resourceResponseRejection(response, maxBytes) {
  if (!response?.ok || response.status !== 200 || response.headers.has("content-range")) return "download_failed";
  if (Number(response.headers.get("content-length") || 0) > maxBytes) return "size_limit";
  return response.body ? "" : "empty_body";
}

async function writeBodyToFile(body, filePath, maxBytes, signal) {
  let bytes = 0;
  const handle = await fs.open(filePath, "w");
  try {
    for await (const chunk of body) {
      signal?.throwIfAborted();
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error("size_limit");
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

export async function cleanupTempDir(tempDir) {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } finally {
    activeResourceTempDirs.delete(path.resolve(tempDir));
  }
}

async function tryCleanupTempDir(tempDir) {
  try { await cleanupTempDir(tempDir); }
  catch { logE("resource temp cleanup failed"); }
}

export async function cleanupExpiredResourceTempDirs(options = {}) {
  const root = options.root || os.tmpdir();
  const now = Number(options.now || Date.now());
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_TEMP_MAX_AGE_MS);
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RESOURCE_TEMP_PREFIX)) continue;
    const target = path.join(root, entry.name);
    if (activeResourceTempDirs.has(path.resolve(target))) continue;
    try {
      const age = now - (await fs.stat(target)).mtimeMs;
      if (age >= 0 && age < maxAgeMs) continue;
      if (age < 0 && age > -FUTURE_SKEW_MS) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

export function resourceErrorText(reason) {
  if (reason === "missing_url") return "请在下载命令后面放一个 http/https 链接。";
  if (reason === "invalid_url" || reason === "unsupported_protocol") return "这个链接格式不支持，只能转发 http/https 资源。";
  if (reason === "private_address" || reason === "blocked_url") return "这个链接被安全策略拦截。";
  if (reason === "size_limit") return "资源超过 500MB 上限，已取消转发。";
  if (reason === "upload_failed") return "资源已下载但转发失败。";
  if (reason === "upload_unconfirmed") return "资源转发结果未确认，请先在 QQ 核实，不会自动重发。";
  if (reason === "permission_changed") return "资源转发权限已变化，后续处理已停止。";
  if (reason === "cancelled") return "资源任务已取消，没有提交文件转发。";
  if (reason === "download_failed" || reason === "empty_body") return "资源下载失败，未转发文件。";
  return "资源转发失败。";
}

function extractFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[)\]}>，。！？!?]+$/g, "") : "";
}

function safeFileName(response, url) {
  const fromHeader = fileNameFromDisposition(response.headers.get("content-disposition") || "");
  const fromUrl = url?.pathname ? path.basename(decodePath(url.pathname)) : "";
  const raw = fromHeader || fromUrl || "resource.bin";
  const cleaned = sanitizeFileName(raw).slice(0, 120).trim();
  return cleaned || "resource.bin";
}

function sanitizeFileName(value) {
  const blocked = '<>:"/\\|?*';
  return String(value || "")
    .split("")
    .map(function(ch) {
      return ch.charCodeAt(0) < 32 || blocked.includes(ch) ? "_" : ch;
    })
    .join("");
}

function fileNameFromDisposition(value) {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodePath(utf8Match[1]);
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : "";
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return mb.toFixed(mb >= 10 ? 0 : 1) + "MB";
  const kb = bytes / 1024;
  return kb >= 1 ? kb.toFixed(kb >= 10 ? 0 : 1) + "KB" : bytes + "B";
}
