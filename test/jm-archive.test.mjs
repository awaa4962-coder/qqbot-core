import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { runZipCommand, zipDirectory } from "../bridge/jm/archive.mjs";
import { activeJmTask, handleJmTransferCommand, waitJmTasks } from "../bridge/jm/commands.mjs";
import { findUsableSevenZip } from "../bridge/seven-zip.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("real 7-Zip creates a readable JM archive protected by uppercase FS", async t => {
  const sevenZip = findUsableSevenZip();
  if (!sevenZip) {
    if (process.platform === "linux") assert.fail("Linux JM archive validation requires working 7-Zip");
    return t.skip("7-Zip is unavailable in this environment");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-jm-real-zip-"));
  roots.push(root);
  const source = path.join(root, "download");
  const archive = path.join(root, "jm-123456.zip");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "001.txt"), "synthetic JM archive fixture");

  await zipDirectory(source, archive, { password: "FS", sevenZipPath: sevenZip, timeoutMs: 30000 });
  const listing = spawnSync(sevenZip, ["l", archive], { encoding: "utf8", timeout: 30000 });
  const good = spawnSync(sevenZip, ["t", "-pFS", archive], { encoding: "utf8", timeout: 30000 });
  const wrong = spawnSync(sevenZip, ["t", "-pfs", archive], { encoding: "utf8", timeout: 30000 });
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  assert.match(listing.stdout, /001\.txt/);
  assert.equal(good.status, 0, good.stderr || good.stdout);
  assert.equal(wrong.error, undefined, "lowercase password check must finish");
  assert.notEqual(wrong.status, 0, "lowercase fs must not read an archive protected by FS");
});

test("archive timeout kills the child and drains both output pipes", async () => {
  const child = new FakeZipChild();
  await assert.rejects(runZipCommand(os.tmpdir(), "unused.zip", "fake-7z", [], {
    timeoutMs: 20, spawnImpl: () => child,
  }), /zip_timeout/);
  assert.equal(child.signal, "SIGKILL");
  assert.equal(child.drained, 2);
});

test("successful archive completion clears the deadline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-archive-test-"));
  roots.push(root);
  const output = path.join(root, "out.zip");
  await fs.writeFile(output, "synthetic zip");
  const child = new FakeZipChild();
  const result = runZipCommand(root, output, "fake-7z", [], {
    timeoutMs: 1000, spawnImpl: () => child,
  });
  child.emit("close", 0);
  assert.equal(await result, true);
  assert.equal(child.signal, "");
  assert.equal(child.drained, 2);
});

test("an installed archiver returning an error is not reported as a missing tool", async () => {
  const child = new FakeZipChild();
  let starts = 0;
  const failure = assert.rejects(zipDirectory(os.tmpdir(), "unused.zip", {
    password: "FS", sevenZipPath: "fake-7z", timeoutMs: 1000, spawnImpl: () => { starts++; return child; },
  }), { message: "zip_failed" });
  child.emit("close", 2);
  await failure;
  assert.equal(starts, 1);
});

test("automatic JM archiver skips an unavailable executable without changing the password", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-archive-test-"));
  roots.push(root);
  const output = path.join(root, "out.zip");
  const attempts = [];
  await zipDirectory(root, output, { password: "FS", timeoutMs: 1000, spawnImpl: (command, args) => {
    attempts.push({ command, args });
    const child = new FakeZipChild();
    if (attempts.length === 1) globalThis.queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("not executable"), { code: "EACCES" }));
      child.emit("close", -1);
    });
    else fs.writeFile(output, "synthetic zip").then(() => child.emit("close", 0), error => child.emit("error", error));
    return child;
  } });
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].command, attempts[1].command);
  assert.ok(attempts.every(attempt => attempt.args.includes("-pFS")));
});

test("a configured JM executable permission failure does not silently fall back", async () => {
  const child = new FakeZipChild();
  let attempts = 0;
  const failure = assert.rejects(zipDirectory(os.tmpdir(), "unused.zip", {
    password: "FS", sevenZipPath: "explicit-7z", timeoutMs: 1000, spawnImpl: () => { attempts++; return child; },
  }), { message: "zip_failed" });
  child.emit("error", Object.assign(new Error("not executable"), { code: "EACCES" }));
  child.emit("close", -1);
  await failure;
  assert.equal(attempts, 1);
});

test("7-Zip readiness tries the same fallback candidates as JM packing", () => {
  const unavailable = { pid: 0, error: Object.assign(new Error("execute denied"), { code: "EACCES" }) };
  const startedFailure = { pid: 123, status: 2 };
  const ready = { pid: 124, status: 0 };
  const options = { bundledPath: "first", commonCommands: ["second"] };
  assert.equal(findUsableSevenZip({ ...options, runner: command => command === "first" ? unavailable : ready }), "second");
  assert.equal(findUsableSevenZip({ ...options, runner: command => command === "first" ? startedFailure : ready }), "");
  assert.equal(findUsableSevenZip({ ...options, configured: "first", runner: () => unavailable }), "");
});

test("an archive command that exits cleanly but writes no archive is still a failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-archive-test-"));
  roots.push(root);
  const child = new FakeZipChild();
  const failure = assert.rejects(runZipCommand(root, path.join(root, "absent.zip"), "fake-7z", [], {
    timeoutMs: 1000, spawnImpl: () => child,
  }), { message: "zip_failed" });
  child.emit("close", 0);
  await failure;
});

test("the optional unencrypted path still falls back when tar cannot write ZIP", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-archive-test-"));
  roots.push(root);
  const output = path.join(root, "out.zip");
  const commands = [];
  await zipDirectory(root, output, { timeoutMs: 1000, spawnImpl: command => {
    commands.push(command);
    const child = new FakeZipChild();
    globalThis.queueMicrotask(async () => {
      if (command === "tar") child.emit("close", 2);
      else { await fs.writeFile(output, "synthetic zip"); child.emit("close", 0); }
    });
    return child;
  } });
  assert.deepEqual(commands, ["tar", "powershell"]);
});

test("JM archive timeout releases the global task lock and retains the one-day temp directory", async () => {
  const messages = [];
  let tempRoot = "";
  const child = new FakeZipChild();
  let uploads = 0;
  const handled = await handleJmTransferCommand({
    isAtMe: true, group_id: 123, text: "jm 123456",
  }, {
    parsedCommand: { ok: true, jmId: "123456" }, groupWhitelist: [123],
    sender: async (_group, text) => { messages.push(text); },
    runner: async (_id, directory) => {
      tempRoot = path.dirname(directory);
      roots.push(tempRoot);
      await fs.writeFile(path.join(directory, "001.jpg"), "synthetic image");
      return { ok: true };
    },
    zipper: (source, output) => zipDirectory(source, output, {
      password: "test", sevenZipPath: "fake-7z", timeoutMs: 20, spawnImpl: () => child,
    }),
    uploader: async () => { uploads++; return { status: "ok" }; },
  });
  assert.equal(handled, true);
  await waitJmTasks();
  assert.equal(activeJmTask, null);
  assert.equal(uploads, 0);
  assert.equal(child.signal, "SIGKILL");
  assert.equal((await fs.stat(tempRoot)).isDirectory(), true);
  assert.ok(messages.some(text => text.includes("打包超时") && text.includes("1 天")));
});

class FakeZipChild extends EventEmitter {
  constructor() {
    super();
    this.drained = 0;
    this.signal = "";
    this.stdout = { resume: () => { this.drained++; } };
    this.stderr = { resume: () => { this.drained++; } };
  }

  kill(signal) {
    this.signal = signal;
    this.emit("close", null);
    return true;
  }
}
