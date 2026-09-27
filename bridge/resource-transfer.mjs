import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CFG } from "./config.mjs";
import { prepareCommandText } from "./commands/normalize.mjs";
import { fetchSafeResponse, validateSafeUrl } from "./safe-url.mjs";
import { sendMsg, uploadGroupFile } from "./napcat.mjs";
import { log, logE } from "./logger.mjs";
import { classifyOneBotReceipt, isDefiniteOneBotRejection, isOneBotResponseSuccessful } from "./onebot-receipt.mjs";
import { createTaskRunner, taskEventKey } from "./tasks/runner.mjs";

const COMMAND_RE = /^(download|dl|fetch|下载)\s*(.*)$/i;
const DEFAULT_TIMEOUT_MS = 120000;
const RESOURCE_TEMP_PREFIX = "qqfriend-resource-";
const DEFAULT_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const activeResourceTempDirs = new Set();
const resourceTasks = createTaskRunner({ filename: path.join(CFG.dataRoot, ".qqfriend", "tasks",
  process.env.NODE_ENV === "test" ? `resource-transfers-${process.pid}.json` : "resource-transfers.json"),
  maxConcurrent: 1, historyLimit: 256, busyMessage: "已有资源转发任务在运行，请稍后再试。" });

export function waitResourceTasks() { return resourceTasks.wait(); }
export function listResourceTasks() { return resourceTasks.list(); }

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

  const sender = options.sender || sendMsg;
  if (!isResourceGroupAllowed(ctx.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist)) {
    await sender(ctx.group_id, "这个群没有开启资源转发白名单。", options.replyToId);
    return true;
  }

  if (!parsed.ok) {
    await sender(ctx.group_id, resourceErrorText(parsed.reason), options.replyToId);
    return true;
  }

  await launchResourceTask(ctx, parsed, options, sender);
  return true;
}

async function launchResourceTask(ctx, parsed, options, sender) {
  const eventKey = taskEventKey("group", ctx.group_id, ctx.message_id);
  try {
    if (resourceTasks.hasEvent(eventKey)) {
      await notifyResource(sender, ctx.group_id, "这条资源任务已经受理过，请先核实原任务结果，不会自动重做。", options.replyToId);
      return;
    }
  } catch {
    await notifyResource(sender, ctx.group_id, "资源任务没能启动，请稍后检查运行状态。", options.replyToId);
    return;
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    resourceTasks.start({ scope: "resource", action: "transfer", meta: { kind: "group", eventKey }, run: async ({ signal }) => {
      await gate;
      return transferResourceToGroup({
        groupId: ctx.group_id, url: parsed.url, replyToId: options.replyToId, sender, signal,
        uploader: options.uploader || uploadGroupFile, maxBytes: options.maxBytes || CFG.resourceMaxBytes,
        assertAllowed: () => {
          signal.throwIfAborted();
          if (!isResourceGroupAllowed(ctx.group_id, options.groupWhitelist || CFG.resourceGroupWhitelist)) throw new Error("permission_changed");
        },
      });
    } });
  } catch (error) {
    const busy = error.message === "已有资源转发任务在运行，请稍后再试。" || error.message === "后台任务已满，请稍后再试";
    await notifyResource(sender, ctx.group_id, busy ? "已有资源转发任务在运行，请稍后再试。" :
      "资源任务没能启动，请稍后检查运行状态。", options.replyToId);
    return;
  }
  try { await notifyResource(sender, ctx.group_id, "资源下载已开始，完成后会转发到群。", options.replyToId); }
  finally { release(); }
}

async function notifyResource(sender, groupId, text, replyTo) {
  try { await sender(groupId, text, replyTo); } catch {}
}

export async function transferResourceToGroup(options) {
  const sender = options.sender || sendMsg;
  const uploader = options.uploader || uploadGroupFile;
  let downloaded = null;
  try {
    options.assertAllowed?.();
    downloaded = await downloadResourceToTemp(options.url, {
      maxBytes: options.maxBytes || CFG.resourceMaxBytes,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
    options.assertAllowed?.();
    const uploadResult = await uploader(options.groupId, downloaded.filePath, downloaded.fileName);
    if (!isOneBotResponseSuccessful(uploadResult)) throw new Error(isDefiniteOneBotRejection(uploadResult) ? "upload_failed" : "upload_unconfirmed");
    const noticeConfirmed = await sendResourceSuccessNotice(options, sender, downloaded.bytes);
    return { ok: true, bytes: downloaded.bytes, fileName: downloaded.fileName, noticeConfirmed };
  } catch (error) {
    logE("resource transfer failed:", error.message);
    if (error.message !== "permission_changed" && !options.signal?.aborted) await sender(options.groupId, resourceErrorText(error.message), options.replyToId);
    return { ok: false, reason: error.message };
  } finally {
    if (downloaded?.tempDir) await cleanupTempDir(downloaded.tempDir);
  }
}

async function sendResourceSuccessNotice(options, sender, bytes) {
  try {
    options.assertAllowed?.();
    options.signal?.throwIfAborted();
    const receipt = await sender(options.groupId, "资源已转发，大小 " + formatBytes(bytes) + "。临时文件已清理。", options.replyToId);
    return classifyOneBotReceipt(receipt) === "sent";
  } catch { return false; }
}

export async function downloadResourceToTemp(url, options = {}) {
  const maxBytes = options.maxBytes || CFG.resourceMaxBytes;
  const result = await fetchSafeResponse(url, { timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, signal: options.signal });
  const response = await validateDownloadResponse(result, maxBytes);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), RESOURCE_TEMP_PREFIX));
  activeResourceTempDirs.add(path.resolve(tempDir));
  const fileName = safeFileName(response, result.url);
  const filePath = path.join(tempDir, fileName);
  let bytes;
  try {
    bytes = await writeBodyToFile(response.body, filePath, maxBytes, options.signal);
  } catch (error) {
    await cleanupTempDir(tempDir);
    throw error;
  }

  if (bytes <= 0) {
    await cleanupTempDir(tempDir);
    throw new Error("empty_body");
  }
  log("resource downloaded:", fileName, formatBytes(bytes));
  return { tempDir, filePath, fileName, bytes, url: result.url?.href || url };
}

async function validateDownloadResponse(result, maxBytes) {
  if (!result.ok) throw new Error(result.reason || "blocked_url");
  if (!result.response?.ok) throw new Error("download_failed");

  const contentLength = Number(result.response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    try { await result.response.body?.cancel(); } catch {}
    throw new Error("size_limit");
  }
  if (!result.response.body) throw new Error("empty_body");
  return result.response;
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
  if (reason === "upload_failed") return "资源已下载但转发失败，临时文件已删除。";
  if (reason === "upload_unconfirmed") return "资源转发结果未确认，请先在 QQ 核实，不会自动重发。本机临时文件已清理。";
  if (reason === "download_failed" || reason === "empty_body") return "资源下载失败，未保存文件。";
  return "资源转发失败，临时文件已删除。";
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
