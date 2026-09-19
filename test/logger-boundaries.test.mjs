import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGGER_URL = pathToFileURL(path.join(ROOT, "bridge/logger.mjs")).href;

test("logger redacts credentials at console and direct file boundaries", () => {
  const result = runLoggerChild(`
    log('visible-info', JSON.stringify({ token: 'synthetic-console-token', uid: '12345678901' }));
    logE('visible-error password=synthetic-error-password');
    logFile('D', JSON.stringify({ api_key: 'synthetic-file-key', text: 'visible-file' }));
    cleanupLogger();
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /visible-info/);
  assert.match(result.stderr, /visible-error/);
  assert.match(result.logs, /visible-file/);
  assert.match(result.stdout, /12345678901/);
  for (const output of [result.stdout, result.stderr, result.logs]) {
    assert.match(output, /\[REDACTED\]/);
    assert.doesNotMatch(output, /synthetic-(?:console-token|error-password|file-key)/);
  }
});

test("storm suppression bounds stdout, stderr and disk output together", () => {
  const result = runLoggerChild(`
    for (let i = 0; i < 2000; i++) {
      if (i % 2) logE('storm-probe-' + i);
      else log('storm-probe-' + i);
    }
    process.stdout.write('STORM_STATUS=' + JSON.stringify(getStormStatus()) + '\\n');
    cleanupLogger();
  `);
  assert.equal(result.status, 0, result.stderr);
  const consoleCount = (result.stdout + result.stderr).match(/storm-probe-\d+/g)?.length || 0;
  const diskCount = result.logs.match(/storm-probe-\d+/g)?.length || 0;
  assert.equal(consoleCount, 200);
  assert.equal(diskCount, consoleCount);
  assert.equal(result.stderr.match(/LOG STORM DETECTED/g)?.length, 1);
  assert.equal(result.logs.match(/LOG STORM DETECTED/g)?.length, 1);
  const status = JSON.parse(result.stdout.match(/STORM_STATUS=(.+)/)[1]);
  assert.ok(status.logStormRemainingMs > 0);
});

test("uncaught exceptions and unhandled rejections exit nonzero despite live handles", () => {
  for (const [origin, trigger] of [
    ["uncaughtException", "setImmediate(() => { throw new Error('token=synthetic-fatal-token'); });"],
    ["unhandledRejection", "Promise.reject(new Error('token=synthetic-fatal-token'));"],
  ]) {
    const result = runLoggerChild(`setInterval(() => {}, 100); ${trigger}`);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, new RegExp("\\[FATAL\\] " + origin));
    assert.match(result.logs, /\[FATAL\]/);
    assert.doesNotMatch(result.stdout + result.stderr + result.logs, /synthetic-fatal-token/);
  }
});

test("fatal event fires once and the deadline terminates a cleanup that never completes", () => {
  const result = runLoggerChild(`
    process.on('qqfriend:fatal', payload => {
      process.stdout.write('FATAL_EVENT=' + JSON.stringify({ ...payload, exitCode: process.exitCode }) + '\\n');
      return new Promise(() => {});
    });
    setInterval(() => {}, 100);
    process.emit('uncaughtException', new Error('password=synthetic-hook-secret'));
    process.emit('uncaughtException', new Error('second fatal'));
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.match(/FATAL_EVENT=/g)?.length, 1);
  const event = JSON.parse(result.stdout.match(/FATAL_EVENT=(.+)/)[1]);
  assert.equal(event.origin, "uncaughtException");
  assert.equal(event.deadlineMs, 1000);
  assert.equal(event.exitCode, 1);
  assert.doesNotMatch(result.stdout + result.stderr + result.logs, /synthetic-hook-secret/);
});

test("a throwing fatal cleanup hook cannot cancel nonzero shutdown or leak credentials", () => {
  const result = runLoggerChild(`
    process.on('qqfriend:fatal', () => { throw new Error('token=synthetic-cleanup-token'); });
    setInterval(() => {}, 100);
    setImmediate(() => { throw new Error('password=synthetic-origin-password'); });
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /cleanup hook failed/);
  assert.doesNotMatch(result.stdout + result.stderr + result.logs, /synthetic-(?:cleanup-token|origin-password)/);
});

function runLoggerChild(body) {
  const tempRoot = path.resolve(os.tmpdir());
  const sandbox = fs.mkdtempSync(path.join(tempRoot, "qqfriend-logger-boundary-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^QQ(?:BOT|FRIEND)_/.test(key)));
  Object.assign(env, {
    NODE_ENV: "test", QQBOT_CONFIG_ROOT: path.join(sandbox, "config"), QQBOT_DATA_DIR: path.join(sandbox, "data"),
    QQBOT_LOG_DIR: path.join(sandbox, "logs"), QQBOT_TEMP_DIR: path.join(sandbox, "temp"),
    QQBOT_MEMORY_PROFILE_FILE: path.join(sandbox, "profiles.json"), TEMP: sandbox, TMP: sandbox,
  });
  const source = `import { log, logE, logFile, cleanupLogger, getStormStatus } from ${JSON.stringify(LOGGER_URL)};\n${body}`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: sandbox, env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", windowsHide: true,
    });
    const logs = fs.readdirSync(env.QQBOT_LOG_DIR).filter(file => file.endsWith(".log"))
      .map(file => fs.readFileSync(path.join(env.QQBOT_LOG_DIR, file), "utf8")).join("\n");
    return { ...result, logs };
  } finally {
    removeLoggerSandbox(sandbox, tempRoot);
  }
}

function removeLoggerSandbox(sandbox, tempRoot) {
  if (path.dirname(path.resolve(sandbox)) !== tempRoot || !path.basename(sandbox).startsWith("qqfriend-logger-boundary-")) {
    throw new Error("unsafe logger test cleanup target");
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
