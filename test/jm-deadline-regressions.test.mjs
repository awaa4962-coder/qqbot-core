import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";

// These regressions import production modules only after isolating all mutable roots.
const originalTempRoot = path.resolve(os.tmpdir());
const sandbox = await fs.mkdtemp(path.join(originalTempRoot, "qqfriend-jm-regressions-"));
const tempRoot = path.join(sandbox, "temp");
await fs.mkdir(tempRoot, { recursive: true });
const isolatedEnv = {
  ...Object.fromEntries(Object.keys(process.env)
    .filter(key => /^QQBOT_.*(?:ROOT|DIR)$/.test(key)).map(key => [key, sandbox])),
  NODE_ENV: "test",
  QQBOT_CONFIG_ROOT: path.join(sandbox, "config"),
  QQBOT_DATA_ROOT: path.join(sandbox, "data"),
  QQBOT_DATA_DIR: path.join(sandbox, "data"),
  QQBOT_LOG_ROOT: path.join(sandbox, "logs"),
  QQBOT_LOG_DIR: path.join(sandbox, "logs"),
  QQBOT_TEMP_ROOT: tempRoot,
  QQBOT_TEMP_DIR: tempRoot,
  QQBOT_MEMORY_PROFILE_FILE: path.join(sandbox, "data", "memory-profiles.json"),
  TEMP: tempRoot,
  TMP: tempRoot,
};
const previousEnv = new Map(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
let networkAttempts = 0;
const previousFetch = globalThis.fetch;
const previousConnect = net.Socket.prototype.connect;
function forbiddenNetwork() {
  networkAttempts++;
  throw new Error("Real network access is forbidden in JM regression tests");
}
globalThis.fetch = forbiddenNetwork;
net.Socket.prototype.connect = forbiddenNetwork;

const { CFG } = await import("../bridge/config.mjs");
const commands = await import("../bridge/jm/commands.mjs");
const { uploadGroupFile, uploadPrivateFile } = await import("../bridge/napcat.mjs");
const { runPythonJson } = await import("../bridge/jm/runtime.mjs");
const { zipDirectory } = await import("../bridge/jm/archive.mjs");
const { transferJmToPrivate } = await import("../bridge/jm/transfer.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");

after(async () => {
  cleanupLogger();
  globalThis.fetch = previousFetch;
  net.Socket.prototype.connect = previousConnect;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(sandbox), originalTempRoot);
  assert.match(path.basename(sandbox), /^qqfriend-jm-regressions-/);
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  assert.equal(networkAttempts, 0, "even unexpected transport calls must stay offline");
});

let nextMessageId = 910000;
const success = () => ({ status: "ok", retcode: 0 });
const progressMarker = "JM \u8fdb\u5ea6";
const busyMarker = "\u5df2\u6709 JM \u4e0b\u8f7d\u4efb\u52a1";

async function spinUntil(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await immediate();
  assert.ok(predicate(), "synthetic stage did not become ready");
}

async function drain() {
  for (let index = 0; index < 8; index++) await immediate();
}

async function syntheticDownload(_id, directory) {
  await fs.writeFile(path.join(directory, "001.jpg"), "synthetic image");
  return { ok: true, all_success: true };
}

async function syntheticZip(_directory, destination) {
  await fs.writeFile(destination, "synthetic archive");
}

function startCommand(surface, options) {
  const context = { text: "jm 123456", message_id: nextMessageId++ };
  if (surface === "private") {
    return commands.handlePrivateJmTransferCommand({ ...context, user_id: 3000000001 }, options);
  }
  return commands.handleJmTransferCommand({ ...context, group_id: 2000000001, isAtMe: true }, {
    ...options, parsedCommand: { ok: true, jmId: "123456" },
  });
}

for (const surface of ["group", "private"]) {
  test(`revoked ${surface} permission prevents final HTTP dispatch and late notices`, async () => {
    const field = surface === "group" ? "resourceGroupWhitelist" : "jmUserWhitelist";
    const previousWhitelist = CFG[field];
    CFG[field] = [surface === "group" ? 2000000001 : 3000000001];
    const nativeUpload = surface === "group" ? uploadGroupFile : uploadPrivateFile;
    let revoked = false, streams = 0, preflights = 0, dispatches = 0;
    const lateNotices = [];
    try {
      await startCommand(surface, {
        sender: async (_id, text) => { if (revoked) lateNotices.push(text); return success(); },
        runner: syntheticDownload,
        zipper: syntheticZip,
        uploader: (id, file, name, uploadOptions) => nativeUpload(id, file, name, {
          ...uploadOptions,
          wsUrl: "ws://audit.invalid",
          streamUploader: async () => {
            streams++;
            await immediate();
            CFG[field] = [];
            revoked = true;
            return { filePath: "synthetic-remote-archive" };
          },
          onRequestDispatched: () => { preflights++; uploadOptions.onRequestDispatched(); },
          fetchImpl: async () => { dispatches++; return { ok: true, json: async () => success() }; },
        }),
      });
      await commands.waitJmTasks();
      assert.equal(streams, 1, "the stream must reach its completed boundary");
      assert.equal(preflights, 1, "the parent authorization guard must actually run");
      assert.equal(dispatches, 0, "revocation must stop the final file-send HTTP request");
      assert.deepEqual(lateNotices, [], "revocation must suppress all subsequent notices");
    } finally {
      CFG[field] = previousWhitelist;
    }
  });
}

function fakeWorker(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.closed = false;
  child.kill = signal => {
    assert.equal(signal, "SIGKILL");
    child.killCalls++;
    child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    return false;
  };
  child.close = () => {
    if (child.closed) return;
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  return child;
}

for (const kind of ["Python", "7z"]) {
  for (const livePidError of [false, true]) {
    const boundary = livePidError ? "live-pid EPERM before abort" : "kill EPERM after abort";
    test(`${kind} ${boundary} retains await-close and the global JM lock`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const child = fakeWorker(livePidError ? 42424242 : undefined);
      let spawned = false, settled = false, competingRuns = 0;
      const busyNotices = [];
      // A synthetic pid must never reach the operating system, including on Linux.
      t.mock.method(process, "kill", (pid, signal) => {
        assert.equal(pid, -child.pid);
        assert.equal(signal, "SIGKILL");
        throw Object.assign(new Error("group kill EPERM"), { code: "EPERM" });
      });
      const spawnImpl = () => { spawned = true; return child; };
      const competingOptions = {
        groupWhitelist: [2000000001],
        sender: async (_id, text) => { busyNotices.push(text); return success(); },
        runner: async () => { competingRuns++; return { ok: false, reason: "download_failed" }; },
        zipper: async () => assert.fail("a competing failed download cannot pack"),
        uploader: async () => assert.fail("a competing failed download cannot upload"),
      };
      let waiting;
      try {
        await startCommand("private", {
          userWhitelist: [3000000001], sender: async () => success(),
          runner: kind === "Python"
            ? (_id, _directory, options) => runPythonJson({ ...options, command: "synthetic-python", args: [], env: process.env, spawnImpl })
            : syntheticDownload,
          zipper: kind === "7z"
            ? (directory, destination, options) => zipDirectory(directory, destination, { ...options, sevenZipPath: "synthetic-7z", spawnImpl })
            : async () => assert.fail("a stopped Python worker cannot pack"),
          uploader: async () => assert.fail("a stopped worker cannot upload"),
        });
        await spinUntil(() => spawned);
        waiting = commands.waitJmTasks().then(() => { settled = true; });
        if (livePidError) {
          child.emit("error", Object.assign(new Error("pipe EPERM"), { code: "EPERM" }));
          await drain();
          assert.equal(settled, false, "an existing pid's error is not an exit receipt");
          assert.equal(commands.activeJmTask, "123456");
        }
        t.mock.timers.tick(90000);
        await drain();
        assert.equal(child.killCalls, 1, "abort must attempt to terminate the worker");
        assert.equal(child.closed, false);
        assert.equal(settled, false, "kill EPERM must not settle before close");
        assert.equal(commands.activeJmTask, "123456");
        await startCommand("group", competingOptions);
        assert.equal(competingRuns, 0, "the private task must retain the cross-surface lock");
        assert.ok(busyNotices.some(text => text.includes(busyMarker)));
        child.close();
        await waiting;
        assert.equal(commands.activeJmTask, null, "close must finally release the lock");
        await startCommand("group", competingOptions);
        await commands.waitJmTasks();
        assert.equal(competingRuns, 1, "a fresh command can start after confirmed close");
      } finally {
        child.close();
        await waiting;
        await commands.waitJmTasks();
      }
    });
  }
}

for (const diskFailure of ["EIO", "hung read"]) {
  test(`cached progress reports once at 60 seconds despite ${diskFailure}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sent = [];
    let directory, ready = false, diskReads = 0, updateProgress;
    const originalReaddir = fs.readdir;
    t.mock.method(fs, "readdir", (target, ...args) => {
      if (target !== directory) return originalReaddir(target, ...args);
      diskReads++;
      if (diskFailure === "EIO") return Promise.reject(Object.assign(new Error("synthetic EIO"), { code: "EIO" }));
      return new Promise(() => {});
    });
    const running = transferJmToPrivate({
      jmId: "123456", userId: 3000000001, startedNotice: false,
      sender: async (_id, text) => { sent.push(text); return success(); },
      runner: async (_id, output, { signal, onProgress }) => {
        directory = output;
        updateProgress = onProgress;
        onProgress({ phase: "downloading", completed: 5, total: 10, bytes: 1048576 });
        const cancelled = new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        ready = true;
        return await cancelled;
      },
      zipper: async () => assert.fail("the waiting download cannot pack"),
      uploader: async () => assert.fail("the waiting download cannot upload"),
    });
    try {
      await spinUntil(() => ready);
      t.mock.timers.tick(59000);
      await drain();
      assert.equal(sent.length, 0);
      t.mock.timers.tick(1000);
      await drain();
      const progress = sent.filter(text => text.startsWith(progressMarker));
      assert.equal(progress.length, 1, "the 60-second notice cannot depend on disk I/O");
      assert.ok(progress[0].includes("5/10"));
      assert.ok(progress[0].includes("1.0 MB"));
      assert.equal(diskReads, 0, "cached progress must not attempt a directory scan");
      updateProgress({ phase: "downloading", completed: 7, total: 10, bytes: 2097152 });
      t.mock.timers.tick(30000);
      assert.equal((await running).reason, "job_timeout");
      t.mock.timers.tick(120000);
      await drain();
      assert.equal(sent.filter(text => text.startsWith(progressMarker)).length, 1);
      assert.equal(sent.length, 2, "only one progress notice and one deadline notice are allowed");
      assert.equal(diskReads, 0);
    } finally {
      t.mock.timers.tick(90000);
      await running;
    }
  });
}
