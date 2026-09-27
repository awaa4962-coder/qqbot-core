import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  if (!sevenZip) return t.skip("7-Zip is unavailable in this environment");
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
