// bridge/logger.mjs — Anti-Storm 日志模块
// 防止日志暴增 / 磁盘写死 / 事件循环堵塞导致死亡螺旋
import fs, { createWriteStream } from 'node:fs';
import path from 'node:path';
import { CFG } from './config.mjs';
import { monotonicNow } from './runtime-clock.mjs';
import { redactSensitiveText } from './privacy.mjs';

fs.mkdirSync(CFG.logDir, { recursive: true });

let _consoleBroken = false;

function _markConsoleBroken(err) {
  if (err?.code === 'EPIPE') {
    _consoleBroken = true;
    return true;
  }
  return false;
}

process.stdout.on('error', _markConsoleBroken);
process.stderr.on('error', _markConsoleBroken);

function writeConsole(stream, line, synchronous = false) {
  if (_consoleBroken) return;
  try {
    const output = redactSensitiveText(line) + '\n';
    if (synchronous) fs.writeSync(stream.fd, output);
    else stream.write(output);
  } catch (err) {
    if (!_markConsoleBroken(err)) {
      try { logFile('C', '[console-write-error] ' + err.message); } catch {}
    }
  }
}

// ── 1. 异步缓冲日志流 ──
let _logStream = null;
let _logStreamDate = '';
let _logStreamBytes = 0;
const LOG_MAX_BYTES = 50 * 1024 * 1024;
let _logTruncated = false;

function _ensureLogStream() {
  const d = new Date();
  const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  if (_logStream && _logStreamDate === dateStr && !_logTruncated) return;
  if (_logStream) {
    try { _logStream.end(); } catch {}
  }
  const fname = 'bridge-' + dateStr + '.log';
  const fpath = path.join(CFG.logDir, fname);
  let existingSize = 0;
  try { existingSize = fs.statSync(fpath).size; } catch {}
  _logStreamBytes = existingSize;
  _logStreamDate = dateStr;
  _logTruncated = existingSize >= LOG_MAX_BYTES;
  _logStream = createWriteStream(fpath, { flags: _logTruncated ? 'w' : 'a' });
  _logStream.on('error', () => {});
  if (_logTruncated) {
    _logStreamBytes = 0;
    const warn = '[' + new Date().toISOString().slice(11,19) + '] [WARN] log file exceeded 50MB, truncated to prevent disk exhaustion';
    _logStream.write(warn + '\n');
    writeConsole(process.stderr, warn);
  }
}

export function logFile(level, line) {
  line = redactSensitiveText(line);
  _ensureLogStream();
  if (_logTruncated && _logStreamBytes < 1024) {
    _logStream.write(line + '\n');
    _logStreamBytes += Buffer.byteLength(line) + 1;
    return;
  }
  if (_logTruncated) return;
  _logStream.write(line + '\n');
  _logStreamBytes += Buffer.byteLength(line) + 1;
  if (_logStreamBytes >= LOG_MAX_BYTES && !_logTruncated) {
    _logTruncated = true;
    const warn = '[' + new Date().toISOString().slice(11,19) + '] [WARN] log file hit 50MB cap, truncating...';
    _logStream.write(warn + '\n');
    writeConsole(process.stderr, warn);
    _ensureLogStream();
  }
}

// ── 2. 日志风暴检测 ──
let _logCountWindow = 0;
let _logWindowStart = monotonicNow();
const LOG_STORM_THRESHOLD = 200;
const LOG_STORM_COOLDOWN = 60000;
let _logStormUntilMono = 0;

function _checkLogStorm() {
  const now = monotonicNow();
  if (now - _logWindowStart > 1000) {
    _logCountWindow = 0;
    _logWindowStart = now;
  }
  _logCountWindow++;
  // 冷却结束后重置风暴状态，允许再次触发保护
  if (_logStormUntilMono && now >= _logStormUntilMono) {
    _logStormUntilMono = 0;
    _logCountWindow = 0;
  }
  if (_logCountWindow > LOG_STORM_THRESHOLD && !_logStormUntilMono) {
    const stormCount = _logCountWindow;
    _logStormUntilMono = now + LOG_STORM_COOLDOWN;
    _logCountWindow = 0;
    const warn = '!!! LOG STORM DETECTED (' + stormCount + ' logs/sec) !!! Cooling down for 60s';
    writeConsole(process.stderr, warn);
    logFile('S', warn);
  }
  return !_logStormUntilMono || now >= _logStormUntilMono;
}

// ── 3. 处理中任务计数 ──
export let _processingCount = 0;

export function incProcessingCount() { _processingCount++; }
export function decProcessingCount() { if (_processingCount > 0) _processingCount--; }

// ── 4. 致命异常 ──
let _fatalShutdown = false;
const FATAL_EXIT_DEADLINE_MS = 1000;

function handleFatal(origin, reason) {
  if (_fatalShutdown) return;
  _fatalShutdown = true;
  process.exitCode = 1;
  // Keep this timer referenced: even a stalled asynchronous cleanup must exit.
  setTimeout(() => process.exit(1), FATAL_EXIT_DEADLINE_MS);
  const message = fatalMessage(reason);
  const line = '[FATAL] ' + origin + ': ' + message;
  writeConsole(process.stderr, line, true);
  try { logFile('F', line); } catch {}
  try {
    process.emit('qqfriend:fatal', { origin, message, deadlineMs: FATAL_EXIT_DEADLINE_MS });
  } catch (error) {
    writeConsole(process.stderr, '[FATAL] cleanup hook failed: ' + fatalMessage(error), true);
  } finally {
    cleanupLogger();
  }
}

function fatalMessage(reason) {
  try {
    return redactSensitiveText(String(reason?.stack || reason?.message || reason)).slice(0, 1000);
  } catch {
    return 'error details unavailable';
  }
}

process.on('uncaughtException', error => handleFatal('uncaughtException', error));
process.on('unhandledRejection', reason => handleFatal('unhandledRejection', reason));

// ── 4.5. 风暴状态导出 ──
export function getStormStatus() {
  const stormRemainingMs = Math.max(0, Math.round(_logStormUntilMono - monotonicNow()));
  return {
    logTruncated: _logTruncated,
    logStreamBytes: _logStreamBytes,
    logStormUntil: stormRemainingMs ? Date.now() + stormRemainingMs : 0,
    logStormRemainingMs: stormRemainingMs,
    processingCount: _processingCount,
  };
}

// ── 5. 日志函数（带风暴保护）──
export function log(...args) {
  if (!_checkLogStorm()) return;
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + args.join(' ');
  writeConsole(process.stdout, line);
  try { logFile('I', line); } catch(e) { writeConsole(process.stderr, '[log-file-err] ' + e.message); }
}

export function logE(...args) {
  if (!_checkLogStorm()) return;
  const line = '[' + new Date().toISOString().slice(11, 19) + '] [E] ' + args.join(' ');
  writeConsole(process.stderr, line);
  try { logFile('E', line); } catch(e) { writeConsole(process.stderr, '[log-file-err] ' + e.message); }
}

export function cleanupLogger() {
  try { _logStream?.end(); } catch {}
}
