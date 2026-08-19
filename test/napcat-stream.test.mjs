import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNapCatHeaders } from "../bridge/napcat-auth.mjs";
import { uploadFileToNapCat } from "../bridge/napcat-stream.mjs";
import { uploadGroupFile } from "../bridge/napcat.mjs";
import { postNapCat } from "../bridge/features/stickers/napcat-adapter.mjs";

test("buildNapCatHeaders adds a bearer token without replacing an explicit header", () => {
  assert.deepEqual(
    buildNapCatHeaders({ "content-type": "application/json" }, { token: "napcat-secret" }),
    { "content-type": "application/json", Authorization: "Bearer napcat-secret" }
  );
  assert.deepEqual(
    buildNapCatHeaders({ authorization: "Bearer explicit" }, { token: "napcat-secret" }),
    { authorization: "Bearer explicit" }
  );
});

test("postNapCat applies the configured bearer token to custom-face requests", async () => {
  let requestOptions = null;
  const result = await postNapCat("get_version_info", {}, {
    token: "sticker-secret",
    async fetchImpl(_url, options) {
      requestOptions = options;
      return { ok: true, status: 200, async json() { return { status: "ok", retcode: 0, data: {} }; } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(requestOptions.headers.Authorization, "Bearer sticker-secret");
});

test("uploadGroupFile submits the NapCat-side stream path instead of the local path", async () => {
  let streamInput = null;
  let requestBody = null;
  const result = await uploadGroupFile(123, "C:\\bridge-temp\\archive.zip", "archive.zip", {
    wsUrl: "ws://127.0.0.1:3001",
    token: "upload-secret",
    async streamUploader(filePath, options) {
      streamInput = { filePath, options };
      return { ok: true, filePath: "/app/napcat/temp/archive.zip" };
    },
    async fetchImpl(_url, options) {
      requestBody = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, "Bearer upload-secret");
      return { async json() { return { status: "ok", retcode: 0 }; } };
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(streamInput.filePath, "C:\\bridge-temp\\archive.zip");
  assert.equal(streamInput.options.wsUrl, "ws://127.0.0.1:3001");
  assert.equal(requestBody.file, "/app/napcat/temp/archive.zip");
});

test("uploadGroupFile never falls back to an inaccessible path when stream mode is required", async () => {
  let httpCalled = false;
  const result = await uploadGroupFile(123, "/tmp/archive.zip", "archive.zip", {
    wsUrl: "ws://127.0.0.1:3001",
    streamRequired: true,
    async streamUploader() {
      throw new Error("stream unavailable");
    },
    async fetchImpl() {
      httpCalled = true;
    },
  });
  assert.equal(result, null);
  assert.equal(httpCalled, false);
});

test("uploadFileToNapCat sends ordered chunks and returns the NapCat-side path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-stream-test-"));
  const filePath = path.join(tempDir, "sample.bin");
  const content = Buffer.alloc(70000, 0x5a);
  await fs.writeFile(filePath, content);

  const socket = new FakeNapCatSocket();
  let capturedUrl = "";
  let capturedOptions = null;
  try {
    const result = await uploadFileToNapCat(filePath, {
      wsUrl: "ws://napcat.test:3001",
      token: "stream-secret",
      chunkSize: 64 * 1024,
      retentionSeconds: 90,
      streamId: "test-stream",
      filename: "sample.bin",
      createSocket(url, options) {
        capturedUrl = url;
        capturedOptions = options;
        return socket;
      },
    });

    assert.equal(capturedUrl, "ws://napcat.test:3001");
    assert.equal(capturedOptions.headers.Authorization, "Bearer stream-secret");
    assert.equal(result.filePath, "/app/.config/QQ/NapCat/temp/test-stream/sample.bin");
    assert.equal(result.size, content.length);
    assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(socket.closed, true);

    const chunks = socket.requests.filter(item => !item.params.is_complete);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map(item => item.params.chunk_index), [0, 1]);
    assert.deepEqual(chunks.map(item => item.params.total_chunks), [2, 2]);
    assert.equal(chunks[0].params.expected_sha256, result.sha256);
    assert.equal(chunks[0].params.file_retention, 90 * 1000);
    assert.deepEqual(
      Buffer.concat(chunks.map(item => Buffer.from(item.params.chunk_data, "base64"))),
      content
    );
    assert.equal(socket.requests.at(-1).params.is_complete, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("uploadFileToNapCat rejects empty files before opening a socket", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-stream-test-"));
  const filePath = path.join(tempDir, "empty.bin");
  await fs.writeFile(filePath, Buffer.alloc(0));
  let socketCreated = false;
  try {
    await assert.rejects(
      uploadFileToNapCat(filePath, {
        wsUrl: "ws://napcat.test:3001",
        createSocket() {
          socketCreated = true;
          return new FakeNapCatSocket();
        },
      }),
      /不支持空文件/
    );
    assert.equal(socketCreated, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("uploadFileToNapCat rejects a completion response without a final path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-stream-test-"));
  const filePath = path.join(tempDir, "sample.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  try {
    await assert.rejects(
      uploadFileToNapCat(filePath, {
        wsUrl: "ws://napcat.test:3001",
        createSocket: () => new FakeNapCatSocket({ omitFinalPath: true }),
      }),
      /未返回完整文件路径/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("uploadFileToNapCat closes a socket when the WebSocket handshake fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-stream-test-"));
  const filePath = path.join(tempDir, "sample.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  let socket = null;
  try {
    await assert.rejects(
      uploadFileToNapCat(filePath, {
        wsUrl: "ws://napcat.test:3001",
        createSocket() {
          socket = new FailingNapCatSocket();
          return socket;
        },
      }),
      /handshake failed/
    );
    assert.equal(socket.closed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

class FakeNapCatSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.readyState = 1;
    this.requests = [];
    this.closed = false;
  }

  send(raw) {
    const request = JSON.parse(raw);
    this.requests.push(request);
    const complete = request.params.is_complete === true;
    const data = complete
      ? {
          status: "file_complete",
          file_path: this.options.omitFinalPath
            ? ""
            : "/app/.config/QQ/NapCat/temp/test-stream/sample.bin",
        }
      : { status: "chunk_received" };
    Promise.resolve().then(() => {
      this.emit("message", Buffer.from(JSON.stringify({
        status: "ok",
        retcode: 0,
        data,
        echo: request.echo,
      })));
    });
  }

  close() {
    this.closed = true;
  }
}

class FailingNapCatSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.closed = false;
    Promise.resolve().then(() => this.emit("error", new Error("handshake failed")));
  }

  close() {
    this.closed = true;
  }
}
