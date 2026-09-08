import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function readJsonFile(filename, fallback = null, options = {}) {
  const io = options.io || fs;
  try {
    if (io.statSync(filename).size > (options.maxBytes ?? 8 * 1024 * 1024)) throw new Error("JSON file exceeds size limit");
    return JSON.parse(io.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonFileSync(filename, value, options = {}) {
  const io = options.io || fs;
  const temporary = temporaryFile(filename);
  io.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    io.writeFileSync(temporary, JSON.stringify(value, null, options.spacing ?? 0), { mode: 0o600 });
    io.renameSync(temporary, filename);
  } finally { io.rmSync(temporary, { force: true }); }
}

function temporaryFile(filename) { return filename + ".tmp." + process.pid + "." + randomUUID(); }

export function createJsonSaver(filename, getValue, options = {}) {
  const io = options.io || fs;
  const destination = () => typeof filename === "function" ? filename() : filename;
  let revision = 0;
  let flushEpoch = 0;
  let dirty = false;
  let timer = null;
  let running = null;
  let disposed = false;

  function cancelTimer() { if (timer) clearTimeout(timer); timer = null; }
  function schedule() {
    if (timer || disposed || !dirty) return;
    timer = setTimeout(() => { timer = null; flush().catch(reportError); }, options.debounceMs ?? 5000);
    timer.unref?.();
  }
  function reportError(error) { options.onError?.(error); }
  function markDirty() {
    if (disposed) throw new Error("JSON saver is disposed");
    revision++; dirty = true; schedule();
  }

  async function saveSnapshot() {
    const ticket = revision;
    const epoch = flushEpoch;
    const target = destination();
    const temporary = temporaryFile(target);
    try {
      const text = JSON.stringify(getValue(), null, options.spacing ?? 2);
      await io.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await io.promises.writeFile(temporary, text, { mode: 0o600 });
      // A continuous stream can still checkpoint; newer mutations remain dirty. A sync
      // flush invalidates staged writes and cannot interleave with this final commit.
      if (!disposed && dirty && epoch === flushEpoch) {
        io.renameSync(temporary, target);
        dirty = ticket !== revision;
      }
    } catch (error) { reportError(error); }
    finally {
      try { io.rmSync(temporary, { force: true }); } catch (error) { reportError(error); }
    }
  }

  async function flush() {
    cancelTimer();
    while (running) await running;
    if (!dirty || disposed) return !dirty;
    running = saveSnapshot();
    try { await running; } finally { running = null; schedule(); }
    return !dirty;
  }

  function flushSync() {
    cancelTimer();
    if (!dirty || disposed) return !dirty;
    revision++; flushEpoch++;
    try {
      writeJsonFileSync(destination(), getValue(), { ...options, io, spacing: options.spacing ?? 2 });
      dirty = false;
    } catch (error) { reportError(error); schedule(); }
    return !dirty;
  }

  function dispose() { disposed = true; revision++; cancelTimer(); }
  return { markDirty, flush, flushSync, dispose, status: () => ({ dirty, saving: Boolean(running) }) };
}
