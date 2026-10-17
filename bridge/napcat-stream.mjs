// Cross-process file transfer for NapCat's upload_file_stream action.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { CFG } from "./config.mjs";
import { buildNapCatWebSocketOptions } from "./napcat-auth.mjs";
import { isOneBotResponseSuccessful } from "./onebot-receipt.mjs";

const OPEN_STATE = 1;

// One monotonic deadline covers preparation, stream ACKs and the final HTTP receipt.
export function createUploadScope(options = {}, parentScope) {
  const controller = new AbortController();
  const totalMs = Number(options.totalTimeoutMs);
  const deadline = options.totalTimeoutMs !== undefined && options.totalTimeoutMs !== null && Number.isFinite(totalMs)
    ? performance.now() + Math.max(0, totalMs) : Infinity;
  let timer;
  const onAbort = () => controller.abort(options.signal.reason instanceof Error
    ? options.signal.reason : Object.assign(new Error('NapCat upload cancelled'), { name: 'AbortError' }));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const check = () => {
    parentScope?.check();
    if (!controller.signal.aborted && performance.now() >= deadline) {
      controller.abort(Object.assign(new Error('NapCat upload total timeout'), {
        name: 'TimeoutError', code: 'UPLOAD_TOTAL_TIMEOUT',
      }));
    }
    controller.signal.throwIfAborted();
  };
  const schedule = () => {
    if (deadline === Infinity || controller.signal.aborted) return;
    timer = setTimeout(() => {
      try { check(); schedule(); } catch {}
    }, Math.min(0x7fffffff, Math.max(0, Math.ceil(deadline - performance.now()))));
  };
  schedule();
  return {
    signal: controller.signal,
    check,
    run(operation) {
      check();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (failed, value) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', cancelled);
          if (failed) reject(value);
          else resolve(value);
        };
        const cancelled = () => finish(true, controller.signal.reason);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        try {
          check();
          Promise.resolve(operation()).then(value => {
            try { check(); finish(false, value); } catch (error) { finish(true, error); }
          }, error => finish(true, error));
        } catch (error) { finish(true, error); }
      });
    },
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function uploadFileToNapCat(filePath, options = {}, parentScope) {
  const scope = createUploadScope(options, parentScope);
  let socket;
  let succeeded = false;
  let socketClosed = false;
  const close = (force = false) => {
    if (!socket || socketClosed) return;
    socketClosed = true;
    closeSocket(socket, force);
  };
  const onAbort = () => close(true);
  try {
    scope.check();
    const wsUrl = String(options.wsUrl ?? CFG.napcatWsApi ?? "").trim();
    if (!wsUrl) throw new Error("NapCat 流式上传地址未配置");
    const info = await inspectUploadFile(filePath, options, scope);
    // NapCat 4.18.13 stores completed streams by filename, outside the stream-id folder.
    info.remoteFilename = "qqfriend-" + randomUUID() + "-" + info.filename.slice(-120);
    const streamId = String(options.streamId || randomUUID());
    scope.check();
    const createSocket = options.createSocket || ((url, wsOptions) => new WebSocket(url, wsOptions));
    socket = createSocket(wsUrl, buildNapCatWebSocketOptions(options));
    scope.signal.addEventListener('abort', onAbort, { once: true });
    await waitForSocket(socket, options, scope);
    await sendChunks(socket, info, streamId, options, scope);
    const completed = await sendStreamAction(socket, {
      stream_id: streamId,
      is_complete: true,
    }, options, scope);
    scope.check();
    const uploaded = normalizeCompletedUpload(completed, info, streamId);
    succeeded = true;
    return uploaded;
  } finally {
    scope.signal.removeEventListener('abort', onAbort);
    close(!succeeded);
    scope.dispose();
  }
}

async function inspectUploadFile(filePath, options, scope) {
  scope.check();
  const resolved = path.resolve(String(filePath || ""));
  const stat = await scope.run(() => fsp.stat(resolved));
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
    sha256: await hashFile(resolved, scope),
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

async function hashFile(filePath, scope) {
  scope.check();
  const hash = createHash("sha256");
  const source = fs.createReadStream(filePath, { signal: scope.signal });
  try {
    for await (const chunk of source) {
      scope.check();
      hash.update(chunk);
    }
    scope.check();
    return hash.digest("hex");
  } finally { source.destroy(); }
}

async function sendChunks(socket, info, streamId, options, scope) {
  scope.check();
  let index = 0;
  let sentBytes = 0;
  const source = fs.createReadStream(info.path, { highWaterMark: info.chunkSize, signal: scope.signal });
  try {
    for await (const chunk of source) {
      scope.check();
      await sendStreamAction(socket, {
        stream_id: streamId,
        chunk_data: chunk.toString("base64"),
        chunk_index: index,
        total_chunks: info.totalChunks,
        file_size: info.size,
        expected_sha256: info.sha256,
        filename: info.remoteFilename,
        file_retention: info.retentionSeconds * 1000,
      }, options, scope);
      scope.check();
      sentBytes += chunk.length;
      options.onProgress?.({ phase: 'uploading', sentBytes, totalBytes: info.size });
      scope.check();
      index += 1;
    }
    scope.check();
  } finally { source.destroy(); }
}

async function waitForSocket(socket, options, scope) {
  scope.check();
  const timeoutMs = boundedNumber(options.timeoutMs, CFG.napcatStreamTimeoutMs, 5000, 10 * 60 * 1000);
  if (socket.readyState === OPEN_STATE) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const onOpen = () => finish();
    const onError = error => finish(error instanceof Error ? error : new Error("NapCat WebSocket 连接失败"));
    const onClose = () => finish(scope.signal.aborted ? scope.signal.reason : new Error("NapCat WebSocket 提前关闭"));
    const onAbort = () => finish(scope.signal.reason);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener(socket, "open", onOpen);
      removeListener(socket, "error", onError);
      removeListener(socket, "close", onClose);
      scope.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("连接 NapCat 流式接口超时")), timeoutMs);
    addListener(socket, "open", onOpen);
    addListener(socket, "error", onError);
    addListener(socket, "close", onClose);
    scope.signal.addEventListener('abort', onAbort, { once: true });
    try { scope.check(); } catch (error) { finish(error); }
  });
  scope.check();
}

async function sendStreamAction(socket, params, options, scope) {
  scope.check();
  const echo = "qqfriend-stream-" + randomUUID();
  const timeoutMs = boundedNumber(options.timeoutMs, CFG.napcatStreamTimeoutMs, 5000, 10 * 60 * 1000);
  const response = await waitForResponse(socket, echo, timeoutMs, scope, () => {
    scope.check();
    socket.send(JSON.stringify({ action: "upload_file_stream", params, echo }));
  });
  scope.check();
  assertNapCatSuccess(response);
  return response;
}

function waitForResponse(socket, echo, timeoutMs, scope, send) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMessage = raw => {
      const payload = parseMessage(raw);
      if (!payload || String(payload.echo || "") !== echo) return;
      finish(null, payload);
    };
    const onError = error => finish(error instanceof Error ? error : new Error("NapCat WebSocket 错误"));
    const onClose = () => finish(scope.signal.aborted ? scope.signal.reason : new Error("NapCat WebSocket 提前关闭"));
    const onAbort = () => finish(scope.signal.reason);
    const finish = (error, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener(socket, "message", onMessage);
      removeListener(socket, "error", onError);
      removeListener(socket, "close", onClose);
      scope.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(payload);
    };
    const timer = setTimeout(() => finish(new Error("NapCat 流式上传响应超时")), timeoutMs);
    addListener(socket, "message", onMessage);
    addListener(socket, "error", onError);
    addListener(socket, "close", onClose);
    scope.signal.addEventListener('abort', onAbort, { once: true });
    try {
      scope.check();
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
  if (!isOneBotResponseSuccessful(payload)) {
    throw new Error(String(payload?.message || payload?.wording || "NapCat 流式上传失败"));
  }
}

function normalizeCompletedUpload(payload, info, streamId) {
  const data = payload?.data || {};
  const filePath = String(data.file_path || data.file || "").trim();
  if (data.status !== "file_complete" || !filePath) {
    throw new Error("NapCat 未返回完整文件路径");
  }
  verifyCompletedUpload(data, info, streamId);
  return {
    ok: true,
    filePath,
    streamId,
    size: info.size,
    sha256: info.sha256,
    filename: info.filename,
  };
}

function verifyCompletedUpload(data, info, streamId) {
  if (data.stream_id !== undefined && data.stream_id !== streamId) throw new Error("NapCat 上传流编号不匹配");
  if (data.file_size !== undefined && data.file_size !== info.size) throw new Error("NapCat 上传文件大小不匹配");
  if (data.sha256 !== undefined && data.sha256 !== info.sha256) throw new Error("NapCat 上传文件校验和不匹配");
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

function closeSocket(socket, force = false) {
  if (!socket) return;
  let cleanup = () => {};
  try {
    // ws can emit an asynchronous error when a connecting socket is terminated.
    if (socket instanceof WebSocket && socket.readyState !== WebSocket.CLOSED) {
      const onError = () => {};
      cleanup = () => {
        socket.off('error', onError);
        socket.off('close', cleanup);
      };
      socket.on('error', onError);
      socket.once('close', cleanup);
    }
    if ((force || socket.readyState === 0) && typeof socket.terminate === 'function') socket.terminate();
    else if (typeof socket.close === "function") socket.close();
  } catch { cleanup(); }
}
