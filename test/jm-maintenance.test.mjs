import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { after, test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";

const originalTempRoot = path.resolve(os.tmpdir());
const sandbox = await fsp.mkdtemp(path.join(originalTempRoot, "qqfriend-jm-maintenance-"));
const dataRoot = path.join(sandbox, "data");
const tempRoot = path.join(sandbox, "temp");
await fsp.mkdir(tempRoot, { recursive: true });
const isolatedEnv = {
  ...Object.fromEntries(Object.keys(process.env)
    .filter(key => /^QQBOT_.*(?:ROOT|DIR)$/.test(key)).map(key => [key, sandbox])),
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: path.join(sandbox, "config"),
  QQBOT_DATA_ROOT: dataRoot, QQBOT_DATA_DIR: dataRoot,
  QQBOT_LOG_ROOT: path.join(sandbox, "logs"), QQBOT_LOG_DIR: path.join(sandbox, "logs"),
  QQBOT_TEMP_ROOT: tempRoot, QQBOT_TEMP_DIR: tempRoot, TEMP: tempRoot, TMP: tempRoot,
  QQBOT_MEMORY_PROFILE_FILE: path.join(dataRoot, "memory-profiles.json"),
};
const previousEnv = new Map(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
const previousFetch = globalThis.fetch;
const previousConnect = net.Socket.prototype.connect;
let networkAttempts = 0;
function forbiddenNetwork() {
  networkAttempts++;
  throw new Error("Real network/QQ access is forbidden in maintenance tests");
}
globalThis.fetch = forbiddenNetwork;
net.Socket.prototype.connect = forbiddenNetwork;

// Import only after setting test mode and isolating mutable state.
const { JM_MAINTENANCE_FILE: marker, isJmMaintenanceActive } = await import("../bridge/jm/maintenance.mjs");
const commands = await import("../bridge/jm/commands.mjs");
const { buildRuntimeStatus } = await import("../bridge/admin-api/runtime-status.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const jobFile = path.join(dataRoot, ".qqfriend", "tasks", `jm-${process.pid}.json`);
const maintenanceText = "JM \u6b63\u5728\u66f4\u65b0";
let messageId = 920000;

after(async () => {
  cleanupLogger();
  globalThis.fetch = previousFetch;
  net.Socket.prototype.connect = previousConnect;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(sandbox), originalTempRoot);
  assert.match(path.basename(sandbox), /^qqfriend-jm-maintenance-/);
  await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  assert.equal(networkAttempts, 0);
});

async function clearMarker() {
  let stat;
  try { stat = await fsp.lstat(marker); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) await fsp.rmdir(marker);
  else await fsp.unlink(marker);
}

async function writeMarker(contents = "not JSON: maintenance is existence-based") {
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  await fsp.writeFile(marker, contents);
}

function assertProjection(expected) {
  assert.equal(isJmMaintenanceActive(), expected);
  const module = buildRuntimeStatus().modules.jm;
  assert.equal(typeof module.maintenance, "boolean");
  assert.equal(module.maintenance, expected);
  assert.ok(!JSON.stringify(module).includes(marker), "do not expose the marker's path");
}

function context(surface) {
  return surface === "group"
    ? { group_id: 2000000001, isAtMe: true, text: "jm 123456", message_id: messageId++ }
    : { user_id: 3000000001, text: "jm 123456", message_id: messageId++ };
}

function fixture(surface, overrides = {}) {
  const state = { sent: [], runners: 0, uploads: 0 };
  const options = {
    groupWhitelist: [2000000001], userWhitelist: [3000000001], replyToId: 456,
    sender: async (id, text, third, fourth) => {
      state.sent.push({ id, text, options: surface === "group" ? fourth : third });
      return { status: "ok", retcode: 0 };
    },
    runner: async (_id, directory) => {
      state.runners++;
      await fsp.writeFile(path.join(directory, "001.jpg"), "synthetic image");
      return { ok: true, all_success: true };
    },
    zipper: async (_directory, destination) => { await fsp.writeFile(destination, "synthetic archive"); },
    uploader: async () => { state.uploads++; return { status: "ok", retcode: 0 }; },
    ...overrides,
  };
  return { state, send: (ctx = context(surface)) => surface === "group"
    ? commands.handleJmTransferCommand(ctx, { ...options, parsedCommand: { ok: true, jmId: "123456" } })
    : commands.handlePrivateJmTransferCommand(ctx, options) };
}

function assertAck(message) {
  assert.equal(message.options.timeoutMs, 3000);
  assert.equal(message.options.maxAttempts, 1);
  assert.ok(message.options.signal instanceof globalThis.AbortSignal);
  assert.equal(message.options.signal.aborted, false);
}

async function spinUntil(predicate) {
  const end = performance.now() + 5000;
  while (!predicate() && performance.now() < end) await immediate();
  assert.ok(predicate(), "synthetic task did not become ready");
}

test("missing marker allows admission and projects maintenance=false under isolated data root", () => {
  assert.equal(marker, path.join(dataRoot, ".qqfriend", "tasks", "jm-maintenance.json"));
  assertProjection(false);
  assert.deepEqual(commands.listJmTasks(), []);
});

test("any marker file contents activate maintenance without JSON parsing", async () => {
  try {
    for (const contents of ["", "false", "null", "{}", "{broken", new Uint8Array([0, 255, 123])]) {
      await writeMarker(contents);
      assertProjection(true);
      await clearMarker();
      assertProjection(false);
    }
  } finally { await clearMarker(); }
});

test("a marker directory activates maintenance", async () => {
  await fsp.mkdir(marker, { recursive: true });
  try { assertProjection(true); }
  finally { await clearMarker(); }
});

test("real live and dangling marker symlinks activate maintenance", async () => {
  const target = path.join(sandbox, "symlink-target");
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, "preserved.txt"), "preserve link target");
  // NTFS junctions are real symlinks available without Windows symlink privileges.
  const type = process.platform === "win32" ? "junction" : "dir";
  for (const destination of [target, path.join(sandbox, "missing-symlink-target")]) {
    try {
      await fsp.symlink(destination, marker, type);
      assert.equal((await fsp.lstat(marker)).isSymbolicLink(), true);
      assertProjection(true);
    } finally { await clearMarker(); }
  }
  assert.equal(await fsp.readFile(path.join(target, "preserved.txt"), "utf8"), "preserve link target");
});

for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR", "ELOOP"]) {
  test(`${code} probing the marker fails closed in status and both command paths`, async t => {
    const originalLstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (filename, ...args) => {
      if (filename === marker) throw Object.assign(new Error("synthetic marker probe failure"), { code });
      return originalLstat(filename, ...args);
    });
    const before = commands.listJmTasks();
    assertProjection(true);
    for (const surface of ["group", "private"]) {
      const f = fixture(surface);
      assert.equal(await f.send(), true);
      assert.equal(f.state.runners, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sent.length, 1);
      assert.ok(f.state.sent[0].text.startsWith(maintenanceText));
      assertAck(f.state.sent[0]);
    }
    assert.deepEqual(commands.listJmTasks(), before);
    assert.equal(commands.activeJmTask, null);
  });
}

for (const surface of ["group", "private"]) {
  test(`allowed ${surface} maintenance rejection precedes job-store access and has a 3s single-attempt ACK`, async t => {
    await writeMarker();
    const before = commands.listJmTasks();
    const originalStat = fs.statSync;
    const originalTimeout = globalThis.AbortSignal.timeout.bind(globalThis.AbortSignal);
    let jobStoreReads = 0;
    const timeouts = [];
    const statMock = t.mock.method(fs, "statSync", (filename, ...args) => {
      if (filename === jobFile) { jobStoreReads++; throw new Error("job store must not be consulted"); }
      return originalStat(filename, ...args);
    });
    t.mock.method(globalThis.AbortSignal, "timeout", duration => {
      timeouts.push(duration);
      return originalTimeout(duration);
    });
    const f = fixture(surface);
    try {
      assert.equal(await f.send(), true);
      assert.equal(jobStoreReads, 0, "maintenance must precede deduplication and job admission");
      assert.equal(f.state.runners, 0);
      assert.equal(f.state.uploads, 0);
      assert.equal(f.state.sent.length, 1);
      assert.ok(f.state.sent[0].text.startsWith(maintenanceText));
      assertAck(f.state.sent[0]);
      assert.deepEqual(timeouts, [3000], "the ACK's signal must actually be constructed with 3 seconds");
      assert.equal(commands.activeJmTask, null);
      statMock.mock.restore();
      assert.deepEqual(commands.listJmTasks(), before);
    } finally {
      statMock.mock.restore();
      await clearMarker();
    }
  });

  test(`removing the marker lets the same rejected ${surface} event complete normally`, async () => {
    await writeMarker();
    const before = commands.listJmTasks();
    const f = fixture(surface);
    const event = context(surface);
    try {
      await f.send(event);
      assert.equal(f.state.runners, 0);
      assert.deepEqual(commands.listJmTasks(), before);
      await clearMarker();
      assertProjection(false);
      await f.send(event);
      await commands.waitJmTasks();
      assert.equal(f.state.runners, 1);
      assert.equal(f.state.uploads, 1);
      assertAck(f.state.sent[1]);
      const added = commands.listJmTasks().filter(job => !before.some(prior => prior.id === job.id));
      assert.equal(added.length, 1);
      assert.equal(added[0].phase, "done");
    } finally { await clearMarker(); }
  });
}

test("activating maintenance blocks new commands without cancelling an admitted task", async () => {
  let release, workerSignal;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture("private", { runner: async (_id, directory, { signal }) => {
    f.state.runners++;
    workerSignal = signal;
    await held;
    signal.throwIfAborted();
    await fsp.writeFile(path.join(directory, "001.jpg"), "synthetic existing task");
    return { ok: true, all_success: true };
  } });
  try {
    await f.send();
    await spinUntil(() => workerSignal !== undefined);
    const before = commands.listJmTasks();
    await writeMarker();
    assertProjection(true);
    const blocked = fixture("group");
    await blocked.send();
    assert.equal(blocked.state.runners, 0);
    assert.ok(blocked.state.sent[0].text.startsWith(maintenanceText), "maintenance takes precedence over busy");
    assert.deepEqual(commands.listJmTasks(), before);
    assert.equal(workerSignal.aborted, false);
    assert.equal(commands.activeJmTask, "123456");
    release();
    await commands.waitJmTasks();
    assert.equal(workerSignal.aborted, false);
    assert.equal(f.state.uploads, 1, "the already-admitted task can finish while the marker remains");
    assert.equal(commands.activeJmTask, null);
    assert.equal(commands.listJmTasks().find(job => job.id === before.at(-1).id).phase, "done");
    assertProjection(true);
  } finally {
    release();
    await commands.waitJmTasks();
    await clearMarker();
  }
});
