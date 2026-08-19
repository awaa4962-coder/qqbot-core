// Cross-process file transfer for NapCat's upload_file_stream action.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { CFG } from "./config.mjs";
import { buildNapCatWebSocketOptions } from "./napcat-auth.mjs";

const OPEN_STATE = 1;

export async function uploadFileToNapCat(filePath, options = {}) {
  const wsUrl = String(options.wsUrl ?? CFG.napcatWsApi ?? "").trim();
  if (!wsUrl) throw new Error("NapCat 流式上传地址未配置");

  const info = await inspectUploadFile(filePath, options);
  const streamId = String(options.streamId || randomUUID());
  const socket = await openSocket(wsUrl, options);
  try {
    await sendChunks(socket, info, streamId, options);
    const completed = await sendStreamAction(socket, {
      stream_id: streamId,
      is_complete: true,
    }, options);
    return normalizeCompletedUpload(completed, info, streamId);
  } finally {
    closeSocket(socket);
  }
}

async function inspectUploadFile(filePath, options) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error("待上传路径不是文件");
  if (stat.size === 0) throw new Error("NapCat 流式上传不支持空文件");

  const chunkSize = boundedNumber(
    options.chunkSize,
    CFG.napcatStreamChunkBytes,
    64 * 1024,
    1024 * 1024
  );
  return {
    path: resolved,
    filename: safeFilename(options.filename || path.basename(resolved)),
    size: stat.size,
    sha256: await hashFile(resolved),
    chunkSize,
    totalChunks: Math.ceil(stat.size / chunkSize),
    retentionSeconds: boundedNumber(
      options.retentionSeconds,
      CFG.napcatStreamRetentionSeconds,
      60,
      604800
    ),
  };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function sendChunks(socket, info, streamId, options) {
  let index = 0;
  for await (const chunk of fs.createReadStream(info.path, { highWaterMark: info.chunkSize })) {
    await sendStreamAction(socket, {
      stream_id: streamId,
      chunk_data: chunk.toString("base64"),
      chunk_index: index,
      total_chunks: info.totalChunks,
      file_size: info.size,
      expected_sha256: info.sha256,
      filename: info.filename,
      file_retention: info.retentionSeconds * 1000,
    }, options);
    index += 1;
  }
}

async function openSocket(wsUrl, options) {
  const createSocket = options.createSocket || ((url, wsOptions) => new WebSocket(url, wsOptions));
  const socket = createSocket(wsUrl, buildNapCatWebSocketOptions(options));
  if (socket.readyState === OPEN_STATE) return socket;

  const timeoutMs = boundedNumber(options.timeoutMs, CFG.napcatStreamTimeoutMs, 5000, 10 * 60 * 1000);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("连接 NapCat 流式接口超时")), timeoutMs);
      const onOpen = () => finish();
      const onError = error => finish(error instanceof Error ? error : new Error("NapCat WebSocket 连接失败"));
      const finish = error => {
        clearTimeout(timer);
        removeListener(socket, "open", onOpen);
        removeListener(socket, "error", onError);
        if (error) reject(error);
        else resolve();
      };
      addListener(socket, "open", onOpen);
      addListener(socket, "error", onError);
    });
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
  return socket;
}

async function sendStreamAction(socket, params, options) {
  const echo = "qqfriend-stream-" + randomUUID();
  const timeoutMs = boundedNumber(options.timeoutMs, CFG.napcatStreamTimeoutMs, 5000, 10 * 60 * 1000);
  const response = await waitForResponse(socket, echo, timeoutMs, () => {
    socket.send(JSON.stringify({ action: "upload_file_stream", params, echo }));
  });
  assertNapCatSuccess(response);
  return response;
}

function waitForResponse(socket, echo, timeoutMs, send) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("NapCat 流式上传响应超时")), timeoutMs);
    const onMessage = raw => {
      const payload = parseMessage(raw);
      if (!payload || String(payload.echo || "") !== echo) return;
      finish(null, payload);
    };
    const onError = error => finish(error instanceof Error ? error : new Error("NapCat WebSocket 错误"));
    const onClose = () => finish(new Error("NapCat WebSocket 提前关闭"));
    const finish = (error, payload) => {
      clearTimeout(timer);
      removeListener(socket, "message", onMessage);
      removeListener(socket, "error", onError);
      removeListener(socket, "close", onClose);
      if (error) reject(error);
      else resolve(payload);
    };
    addListener(socket, "message", onMessage);
    addListener(socket, "error", onError);
    addListener(socket, "close", onClose);
    try {
      send();
    } catch (error) {
      finish(error);
    }
  });
}

function parseMessage(raw) {
  try {
    const data = raw?.data ?? raw;
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function assertNapCatSuccess(payload) {
  const retcode = Number(payload?.retcode ?? 0);
  if (payload?.status === "failed" || retcode !== 0) {
    throw new Error(String(payload?.message || payload?.wording || "NapCat 流式上传失败"));
  }
}

function normalizeCompletedUpload(payload, info, streamId) {
  const data = payload?.data || {};
  const filePath = String(data.file_path || data.file || "").trim();
  if (data.status !== "file_complete" || !filePath) {
    throw new Error("NapCat 未返回完整文件路径");
  }
  return {
    ok: true,
    filePath,
    streamId,
    size: info.size,
    sha256: info.sha256,
    filename: info.filename,
  };
}

function safeFilename(value) {
  const filename = path.basename(String(value || "upload.bin"))
    .split("")
    .filter(char => char.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return filename || "upload.bin";
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function addListener(socket, event, handler) {
  if (typeof socket.on === "function") socket.on(event, handler);
  else socket.addEventListener(event, handler);
}

function removeListener(socket, event, handler) {
  if (typeof socket.off === "function") socket.off(event, handler);
  else if (typeof socket.removeListener === "function") socket.removeListener(event, handler);
  else socket.removeEventListener(event, handler);
}

function closeSocket(socket) {
  try {
    if (typeof socket.close === "function") socket.close();
  } catch {}
}
