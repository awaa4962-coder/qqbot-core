import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runPythonJson } from "../bridge/jm/runtime.mjs";

test("chunked downloader progress is decoded and private fields are not forwarded", async () => {
  const progress = [];
  const script = [
    "process.stdout.write('QQFRIEND_JM_PRO');",
    "setTimeout(() => {",
    "process.stdout.write('GRESS '+JSON.stringify({phase:'downloading',completed:2,total:4,bytes:12,failed:1,url:'private-url',token:'private-token'})+'\\n');",
    "process.stdout.write('QQFRIEND_JM_RESULT '+JSON.stringify({ok:false,reason:'download_failed',failedImages:1,errorCodes:['timeout']})+'\\n');",
    "}, 5);",
  ].join("\n");
  const result = await runPythonJson({ command: process.execPath, args: ["-e", script], env: process.env,
    timeoutMs: 5000, onProgress: state => progress.push(state) });
  assert.deepEqual(progress, [{ phase: "downloading", completed: 2, total: 4, bytes: 12, failed: 1 }]);
  assert.equal(result.ok, false); assert.equal(result.failedImages, 1); assert.deepEqual(result.errorCodes, ["timeout"]);
});

test("download cancellation waits for actual worker close", async () => {
  const controller = new globalThis.AbortController();
  const running = runPythonJson({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env,
    timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  assert.equal((await running).reason, "timeout");
});

test("Linux download cancellation also kills descendant workers", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jm-cancel-tree-"));
  const marker = path.join(directory, "late.txt");
  const controller = new globalThis.AbortController();
  const childScript = "setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'late'),400)";
  const script = [
    "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(childScript) + "],{stdio:'ignore'});",
    "process.stdout.write('QQFRIEND_JM_PROGRESS '+JSON.stringify({phase:'downloading',completed:0})+'\\n');",
    "setInterval(()=>{},1000);",
  ].join("\n");
  try {
    const result = await runPythonJson({ command: process.execPath, args: ["-e", script], env: process.env,
      timeoutMs: 5000, signal: controller.signal, onProgress: () => controller.abort() });
    assert.equal(result.reason, "timeout");
    await delay(600);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
