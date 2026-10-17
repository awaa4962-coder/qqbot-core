import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, addAbortSignal } from 'node:stream';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import { uploadFileToNapCat } from '../bridge/napcat-stream.mjs';
import { uploadGroupFile, uploadPrivateFile } from '../bridge/napcat.mjs';

const WS_URL = 'ws://synthetic.invalid';
const OK = { status: 'ok', retcode: 0 };
const CANCELLED = { status: 'cancelled', uploadDispatched: false };
const UNKNOWN = { status: 'unknown', delivery: 'unconfirmed', uploadDispatched: true };
const { AbortController, queueMicrotask } = globalThis;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, size = 150000) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'napcat-cancel-'));
  const file = path.join(root, 'synthetic.bin');
  await fsp.writeFile(file, Buffer.alloc(size, 0x41));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return file;
}

function assertClean(socket, signal) {
  assert.equal(socket.closed, true);
  for (const event of ['open', 'message', 'error', 'close']) assert.equal(socket.listenerCount(event), 0);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}

class FakeSocket extends EventEmitter {
  constructor({ readyState = 1, onSend } = {}) {
    super();
    this.readyState = readyState;
    this.onSend = onSend;
    this.requests = [];
    this.closed = false;
  }

  send(raw) {
    assert.equal(this.closed, false);
    const request = JSON.parse(raw);
    this.requests.push(request);
    if (this.onSend) this.onSend(request, this);
    else queueMicrotask(() => this.ack(request));
  }

  ack(request) {
    const first = this.requests[0].params;
    const data = request.params.is_complete ? {
      status: 'file_complete', file_path: '/synthetic/remote.bin', stream_id: first.stream_id,
      file_size: first.file_size, sha256: first.expected_sha256,
    } : { status: 'chunk_received' };
    this.emit('message', Buffer.from(JSON.stringify({ ...OK, data, echo: request.echo })));
  }

  close() { this.closed = true; }
}

test('pre-aborted uploads perform no stat, read, WS, HTTP or dispatch notification', async t => {
  const controller = new AbortController();
  controller.abort();
  const forbidden = () => assert.fail('unexpected upload side effect');
  t.mock.method(fsp, 'stat', forbidden);
  t.mock.method(fs, 'createReadStream', forbidden);
  const options = { signal: controller.signal, wsUrl: WS_URL,
    createSocket: forbidden, streamUploader: forbidden, fetchImpl: forbidden,
    onRequestDispatched: forbidden };
  await assert.rejects(uploadFileToNapCat('synthetic.bin', options), { name: 'AbortError' });
  for (const upload of [uploadGroupFile, uploadPrivateFile]) {
    assert.deepEqual(await upload(1, 'synthetic.bin', 'synthetic.bin', options), CANCELLED);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('zero total budget is exhausted before any upload side effect', async t => {
  const forbidden = () => assert.fail('unexpected upload side effect');
  t.mock.method(fsp, 'stat', forbidden);
  for (const upload of [uploadGroupFile, uploadPrivateFile]) {
    assert.deepEqual(await upload(1, 'synthetic.bin', 'synthetic.bin', {
      totalTimeoutMs: 0, wsUrl: WS_URL, streamUploader: forbidden, fetchImpl: forbidden,
    }), CANCELLED);
  }
  await assert.rejects(uploadFileToNapCat('synthetic.bin', {
    totalTimeoutMs: 0, wsUrl: WS_URL, createSocket: forbidden,
  }), { name: 'TimeoutError' });
});

test('non-Error abort reasons still produce a definite pre-dispatch cancellation', async () => {
  for (const reason of [null, 'synthetic cancellation']) {
    const controller = new AbortController();
    controller.abort(reason);
    assert.deepEqual(await uploadPrivateFile(1, 'synthetic.bin', 'synthetic.bin', {
      wsUrl: '', signal: controller.signal, fetchImpl: () => assert.fail('pre-aborted HTTP'),
    }), CANCELLED);
    await assert.rejects(uploadFileToNapCat('synthetic.bin', {
      wsUrl: WS_URL, signal: controller.signal,
    }), { name: 'AbortError' });
  }
});

test('abort during stat rejects promptly and its late completion starts no file read', async t => {
  const controller = new AbortController();
  const stat = deferred();
  t.mock.method(fsp, 'stat', () => { queueMicrotask(() => controller.abort()); return stat.promise; });
  t.mock.method(fs, 'createReadStream', () => assert.fail('late file read'));
  await assert.rejects(uploadFileToNapCat('synthetic.bin', {
    signal: controller.signal, wsUrl: WS_URL, createSocket: () => assert.fail('late WS'),
  }), { name: 'AbortError' });
  stat.resolve({ isFile: () => true, size: 100 });
  await nextTurn();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort during hash destroys the read stream before opening WS', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  let source;
  let started = false;
  t.mock.method(fs, 'createReadStream', (_file, options) => {
    source = addAbortSignal(options.signal, new Readable({ read() {
      if (started) return;
      started = true;
      this.push(Buffer.alloc(16));
      queueMicrotask(() => controller.abort());
    } }));
    return source;
  });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal, createSocket: () => assert.fail('WS during cancelled hash'),
  }), { name: 'AbortError' });
  assert.equal(started, true);
  assert.equal(source.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort during a chunk file read destroys it without sending a chunk', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const originalRead = fs.createReadStream;
  let reads = 0;
  let source;
  const socket = new FakeSocket();
  t.mock.method(fs, 'createReadStream', (filename, options) => {
    if (++reads === 1) return originalRead(filename, options);
    source = addAbortSignal(options.signal, new Readable({ read() { controller.abort(); } }));
    return source;
  });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal, createSocket: () => socket,
  }), { name: 'AbortError' });
  assert.equal(source.destroyed, true);
  assert.equal(socket.requests.length, 0);
  assertClean(socket, controller.signal);
});

test('abort during WS handshake closes it and removes handshake listeners', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const socket = new FakeSocket({ readyState: 0 });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal,
    createSocket() { queueMicrotask(() => controller.abort()); return socket; },
  }), { name: 'AbortError' });
  socket.emit('open');
  await nextTurn();
  assert.equal(socket.requests.length, 0);
  assertClean(socket, controller.signal);
});

test('abort inside WS creation closes an already-open socket before sending', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const socket = new FakeSocket();
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal,
    createSocket() { controller.abort(); return socket; },
  }), { name: 'AbortError' });
  assert.equal(socket.requests.length, 0);
  assertClean(socket, controller.signal);
});

test('queued abort after WS creation closes the socket before the first chunk', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const socket = new FakeSocket();
  const result = await uploadGroupFile(1, file, 'synthetic.bin', {
    wsUrl: WS_URL, signal: controller.signal, streamRequired: false,
    createSocket() { queueMicrotask(() => controller.abort()); return socket; },
    fetchImpl: () => assert.fail('cancelled socket dispatched HTTP'),
  });
  assert.deepEqual(result, CANCELLED);
  assert.equal(socket.requests.length, 0);
  assertClean(socket, controller.signal);
});

test('abort during chunk ACK reports no unconfirmed progress and ignores late ACK', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const progress = [];
  const socket = new FakeSocket({ onSend() { queueMicrotask(() => controller.abort()); } });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal, chunkSize: 65536,
    createSocket: () => socket, onProgress: value => progress.push(value),
  }), { name: 'AbortError' });
  socket.ack(socket.requests[0]);
  await nextTurn();
  assert.equal(socket.requests.length, 1);
  assert.deepEqual(progress, []);
  assertClean(socket, controller.signal);
});

test('ACK-based progress can cancel before another chunk or completion is sent', async t => {
  const file = await fixture(t);
  const controller = new AbortController();
  const progress = [];
  const socket = new FakeSocket();
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, signal: controller.signal, chunkSize: 65536, createSocket: () => socket,
    onProgress(value) { progress.push(value); if (progress.length === 2) controller.abort(); },
  }), { name: 'AbortError' });
  await nextTurn();
  assert.deepEqual(progress, [65536, 131072].map(sentBytes => ({ phase: 'uploading', sentBytes, totalBytes: 150000 })));
  assert.equal(socket.requests.length, 2);
  assert.equal(socket.requests.some(request => request.params.is_complete), false);
  assertClean(socket, controller.signal);
});

test('stream cancellation cannot fall back, even with a late successful stream result', async () => {
  for (const upload of [uploadGroupFile, uploadPrivateFile]) {
    const controller = new AbortController();
    const stream = deferred();
    const progress = () => {};
    const result = await upload(1, 'synthetic.bin', 'synthetic.bin', {
      signal: controller.signal, totalTimeoutMs: 1000, wsUrl: WS_URL, streamRequired: false,
      chunkSize: 1024 * 1024, onProgress: progress,
      streamUploader(_file, options) {
        assert.equal(options.signal.aborted, false);
        assert.equal(options.chunkSize, 1024 * 1024);
        assert.equal(options.onProgress, progress);
        queueMicrotask(() => controller.abort());
        return stream.promise;
      },
      fetchImpl: () => assert.fail('cancelled stream fell back to HTTP'),
      onRequestDispatched: () => assert.fail('premature dispatch notification'),
    });
    assert.deepEqual(result, CANCELLED);
    stream.resolve({ filePath: '/synthetic/late.bin' });
    await nextTurn();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('stream AbortError is cancellation, while legacy non-cancellation failures remain null', async () => {
  for (const upload of [uploadGroupFile, uploadPrivateFile]) {
    const base = { wsUrl: WS_URL, fetchImpl: () => assert.fail('unexpected HTTP') };
    assert.deepEqual(await upload(1, 'synthetic.bin', 'synthetic.bin', {
      ...base, streamRequired: false,
      streamUploader() { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    }), CANCELLED);
    assert.equal(await upload(1, 'synthetic.bin', 'synthetic.bin', {
      ...base, streamRequired: true, streamUploader() { throw new Error('synthetic failure'); },
    }), null);
  }
});

test('legacy optional stream failure still falls back when not cancelled', async () => {
  const result = await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
    wsUrl: WS_URL, streamRequired: false,
    streamUploader() { throw new Error('synthetic failure'); },
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).file, 'synthetic.bin');
      return { json: async () => OK };
    },
  });
  assert.deepEqual(result, OK);
});

test('successful group/private uploads forward 1 MiB chunks and notify only at final HTTP dispatch', async t => {
  const size = 1024 * 1024 + 17;
  const file = await fixture(t, size);
  for (const [upload, action, recipient] of [
    [uploadGroupFile, 'upload_group_file', 'group_id'],
    [uploadPrivateFile, 'upload_private_file', 'user_id'],
  ]) {
    const controller = new AbortController();
    const progress = [];
    let dispatched = 0;
    let calls = 0;
    const socket = new FakeSocket();
    const result = await upload(123, file, 'synthetic.bin', {
      signal: controller.signal, totalTimeoutMs: 1000, chunkSize: 1024 * 1024,
      wsUrl: WS_URL, createSocket: () => socket,
      onProgress(value) { assert.equal(dispatched, 0); progress.push(value); },
      onRequestDispatched() {
        assert.equal(socket.requests.at(-1).params.is_complete, true);
        assert.equal(calls, 0);
        dispatched += 1;
      },
      async fetchImpl(url, options) {
        calls += 1;
        assert.equal(dispatched, 1);
        assert.equal(options.signal.aborted, false);
        assert.equal(url.endsWith('/' + action), true);
        assert.deepEqual(JSON.parse(options.body), { [recipient]: 123, file: '/synthetic/remote.bin', name: 'synthetic.bin' });
        return { json: async () => OK };
      },
    });
    assert.deepEqual(result, OK);
    assert.equal(calls, 1);
    assert.equal(dispatched, 1);
    assert.deepEqual(progress, [1024 * 1024, size].map(sentBytes => ({ phase: 'uploading', sentBytes, totalBytes: size })));
    assert.equal(socket.requests.length, 3);
    assertClean(socket, controller.signal);
  }
});

test('total stream deadline is not reset by each chunk ACK', async t => {
  const file = await fixture(t, 4 * 65536);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const progress = [];
  const socket = new FakeSocket({ onSend(request, connection) {
    now += 350;
    queueMicrotask(() => connection.ack(request));
  } });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, totalTimeoutMs: 1000, timeoutMs: 60000, chunkSize: 65536,
    createSocket: () => socket, onProgress: value => progress.push(value),
  }), { name: 'TimeoutError' });
  socket.ack(socket.requests.at(-1));
  await nextTurn();
  assert.equal(socket.requests.length, 3);
  assert.equal(progress.length, 2);
  assert.equal(socket.requests.some(request => request.params.is_complete), false);
  assertClean(socket);
});

test('group/private entry points enforce the shared deadline inside the actual chunk loop', async t => {
  const file = await fixture(t, 4 * 65536);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const upload of [uploadGroupFile, uploadPrivateFile]) {
    now = 0;
    const socket = new FakeSocket({ onSend(request, connection) {
      now += 400;
      queueMicrotask(() => connection.ack(request));
    } });
    const result = await upload(1, file, 'synthetic.bin', {
      wsUrl: WS_URL, totalTimeoutMs: 1000, chunkSize: 65536, createSocket: () => socket,
      streamRequired: false,
      onRequestDispatched: () => assert.fail('chunk deadline dispatched HTTP'),
      fetchImpl: () => assert.fail('chunk deadline fell back to HTTP'),
    });
    assert.deepEqual(result, CANCELLED);
    assert.equal(socket.requests.length, 3);
    assert.equal(socket.requests.some(request => request.params.is_complete), false);
    assertClean(socket);
  }
});

test('total timer destroys a stalled hash reader without opening WS', async t => {
  const file = await fixture(t);
  let source;
  t.mock.method(fs, 'createReadStream', (_file, options) => {
    source = addAbortSignal(options.signal, new Readable({ read() {} }));
    return source;
  });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, totalTimeoutMs: 50, createSocket: () => assert.fail('hash timeout opened WS'),
  }), { name: 'AbortError' });
  assert.equal(source.destroyed, true);
});

test('real total timer cancels a stalled chunk and late ACK cannot send another', async t => {
  const file = await fixture(t);
  const socket = new FakeSocket({ onSend() {} });
  const result = await uploadPrivateFile(1, file, 'synthetic.bin', {
    wsUrl: WS_URL, totalTimeoutMs: 50, chunkSize: 65536, createSocket: () => socket,
    streamRequired: false,
    fetchImpl: () => assert.fail('chunk timeout dispatched HTTP'),
  });
  assert.deepEqual(result, CANCELLED);
  assert.equal(socket.requests.length, 1);
  socket.ack(socket.requests[0]);
  await nextTurn();
  assert.equal(socket.requests.length, 1);
  assertClean(socket);
});

test('one total deadline covers stream plus HTTP headers plus body without resetting', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let calls = 0;
  const result = await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
    totalTimeoutMs: 1000, timeoutMs: 60000, wsUrl: WS_URL,
    streamUploader() { now += 700; return { filePath: '/synthetic/remote.bin' }; },
    fetchImpl() {
      calls += 1;
      now += 250;
      return { json() { now += 100; return OK; } };
    },
  });
  assert.deepEqual(result, UNKNOWN);
  assert.equal(calls, 1);
});

test('deadline consumed during stream preparation prevents final HTTP dispatch', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const result = await uploadPrivateFile(1, 'synthetic.bin', 'synthetic.bin', {
    totalTimeoutMs: 1000, wsUrl: WS_URL,
    streamUploader() { now = 1001; return { filePath: '/synthetic/remote.bin' }; },
    onRequestDispatched: () => assert.fail('expired dispatch notification'),
    fetchImpl: () => assert.fail('expired HTTP dispatch'),
  });
  assert.deepEqual(result, CANCELLED);
});

test('real total timer interrupts a stalled WS handshake', async t => {
  const file = await fixture(t);
  const socket = new FakeSocket({ readyState: 0 });
  await assert.rejects(uploadFileToNapCat(file, {
    wsUrl: WS_URL, totalTimeoutMs: 50, createSocket: () => socket,
  }), { name: 'TimeoutError' });
  assert.equal(socket.requests.length, 0);
  assertClean(socket);
});

for (const [label, upload] of [['group', uploadGroupFile], ['private', uploadPrivateFile]]) {
  for (const phase of ['headers', 'body']) {
    test(`${label} abort during HTTP ${phase} returns unconfirmed and never retries`, async () => {
      const controller = new AbortController();
      const pending = deferred();
      let calls = 0;
      let notifications = 0;
      let requestSignal;
      const response = { json() {
        if (phase === 'body') { queueMicrotask(() => controller.abort()); return pending.promise; }
        assert.fail('late response body must not be read');
      } };
      const result = await upload(1, 'synthetic.bin', 'synthetic.bin', {
        wsUrl: '', signal: controller.signal, totalTimeoutMs: 1000,
        onRequestDispatched() { notifications += 1; },
        fetchImpl(_url, options) {
          calls += 1;
          requestSignal = options.signal;
          if (phase === 'headers') { queueMicrotask(() => controller.abort()); return pending.promise; }
          return response;
        },
      });
      assert.deepEqual(result, UNKNOWN);
      assert.equal(requestSignal.aborted, true);
      assert.equal(calls, 1);
      assert.equal(notifications, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      pending.resolve(phase === 'headers' ? response : OK);
      await nextTurn();
      assert.equal(calls, 1);
    });
  }
}

test('HTTP segment timeout interrupts an uncooperative fetch without a total timeout option', async () => {
  let signal;
  const result = await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
    wsUrl: '', timeoutMs: 25,
    fetchImpl(_url, options) { signal = options.signal; return new Promise(() => {}); },
  });
  assert.deepEqual(result, UNKNOWN);
  assert.equal(signal.aborted, true);
});

test('total timer interrupts a pending HTTP body and preserves dispatch uncertainty', async () => {
  let signal;
  const result = await uploadPrivateFile(1, 'synthetic.bin', 'synthetic.bin', {
    wsUrl: '', totalTimeoutMs: 25,
    fetchImpl(_url, options) {
      signal = options.signal;
      return { json: () => new Promise(() => {}) };
    },
  });
  assert.deepEqual(result, UNKNOWN);
  assert.equal(signal.aborted, true);
});

test('HTTP/network/body failures after dispatch are unconfirmed, not falsely unsent', async () => {
  for (const fetchImpl of [
    () => { throw new Error('synthetic network failure'); },
    async () => ({ json: async () => { throw new Error('synthetic invalid body'); } }),
    async () => ({ ok: false, json: async () => OK }),
  ]) {
    let notifications = 0;
    assert.deepEqual(await uploadPrivateFile(1, 'synthetic.bin', 'synthetic.bin', {
      wsUrl: '', fetchImpl, onRequestDispatched() { notifications += 1; },
    }), UNKNOWN);
    assert.equal(notifications, 1);
  }
});

test('ambiguous HTTP receipts are explicitly unconfirmed while definite rejection is preserved', async () => {
  for (const receipt of [null, {}, { status: 'async', retcode: 0 }, { status: 'failed', retcode: 0 }]) {
    assert.deepEqual(await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
      wsUrl: '', fetchImpl: async () => ({ json: async () => receipt }),
    }), UNKNOWN);
  }
  const failed = { status: 'failed', retcode: 100 };
  assert.deepEqual(await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
    wsUrl: '', fetchImpl: async () => ({ json: async () => failed }),
  }), failed);
});

test('abort at the final dispatch boundary still prevents HTTP and reports unsent', async () => {
  const controller = new AbortController();
  assert.deepEqual(await uploadGroupFile(1, 'synthetic.bin', 'synthetic.bin', {
    wsUrl: '', signal: controller.signal,
    onRequestDispatched() { controller.abort(); },
    fetchImpl: () => assert.fail('HTTP after boundary cancellation'),
  }), CANCELLED);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
