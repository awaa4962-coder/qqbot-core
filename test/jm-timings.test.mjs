import assert from "node:assert/strict";
import process from "node:process";
import { after, test } from "node:test";
import { parseRunnerResult, runPythonJson, sanitizeJmTimings } from "../bridge/jm/runtime.mjs";
import { cleanupLogger } from "../bridge/logger.mjs";

after(cleanupLogger);

test("JM timing telemetry permits only bounded integer counters and durations", () => {
  assert.deepEqual(sanitizeJmTimings({ firstImageMs: 74, imageRequestsCompleted: 2, observedMs: 80, imageRateLimited: 1,
    metadataTimeouts: 2, imageUnknownFailure: 17,
    url: "private-url", token: "private-token", title: "private-title", nested: { secret: "private" },
    imageRequestMs: -1, metadataMs: 1.5, metadataCallsCompleted: "2", imageSaveMs: Infinity,
    imageRetriesCompleted: 1000001 }), { firstImageMs: 74, imageRequestsCompleted: 2, observedMs: 80,
    imageRateLimited: 1, metadataTimeouts: 2 });
  for (const value of [null, [], "secret", { url: "secret" }, { firstImageMs: 86400001 }]) {
    assert.equal(sanitizeJmTimings(value), null);
  }
});

test("a crashed worker cannot be mistaken for successful output or a missing dependency", () => {
  for (const stdout of ["", 'QQFRIEND_JM_RESULT {"ok":true,"all_success":true,"files":1,"bytes":1}']) {
    assert.deepEqual(parseRunnerResult(stdout, "private runner output", 1), { ok: false, reason: "worker_exited" });
  }
});

test("JM worker success requires complete positive totals and drops private extra fields", () => {
  const result = { ok: true, all_success: true, files: 1, bytes: 10, title: "private-title" };
  const parse = value => parseRunnerResult("QQFRIEND_JM_RESULT " + JSON.stringify(value), "", 0);
  assert.equal(parse(result).title, undefined);
  assert.equal(parse({ ...result, bytes: 0 }).reason, "incomplete_result");
  assert.equal(parse({ ...result, all_success: false }).reason, "incomplete_result");
});

test("cancelled JM workers retain the last measured timing snapshot without forwarding private progress", async () => {
  const controller = new globalThis.AbortController();
  const progress = [];
  const script = [
    "process.stdout.write('QQFRIEND_JM_PROGRESS '+JSON.stringify({phase:'downloading',completed:1,",
    "timings:{firstImageMs:50,observedMs:60,imageRequestsCompleted:1,url:'private-url',token:'private-token'}})+'\\n');",
    "setInterval(()=>{},1000);",
  ].join("\n");
  const result = await runPythonJson({ command: process.execPath, args: ["-e", script], env: process.env,
    timeoutMs: 5000, signal: controller.signal, onProgress: state => { progress.push(state); controller.abort(); } });
  assert.equal(result.reason, "timeout");
  assert.deepEqual(result.timings, { firstImageMs: 50, observedMs: 60, imageRequestsCompleted: 1 });
  assert.deepEqual(progress, [{ phase: "downloading", completed: 1 }]);
});

test("failed JM workers keep sanitized final timings rather than raw downloader fields", async () => {
  const script = "process.stdout.write('QQFRIEND_JM_RESULT '+JSON.stringify({ok:false,reason:'download_failed'," +
    "timings:{clientInitMs:20,imageRequestsCompleted:2,token:'private-token'}})+'\\n');";
  const result = await runPythonJson({ command: process.execPath, args: ["-e", script], env: process.env, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.timings, { clientInitMs: 20, imageRequestsCompleted: 2 });
});

test("successful workers discard wholly invalid timings even without a progress snapshot", async () => {
  const script = "process.stdout.write('QQFRIEND_JM_RESULT '+JSON.stringify({ok:true,files:1,bytes:1,all_success:true," +
    "timings:{url:'private-url',token:'private-token',firstImageMs:'private-value'}})+'\\n');";
  const result = await runPythonJson({ command: process.execPath, args: ["-e", script], env: process.env, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, "timings"), false);
});
