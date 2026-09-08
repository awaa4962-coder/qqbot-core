import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsonSaver, readJsonFile, writeJsonFileSync } from "../bridge/persistence/json-file.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-json-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "state.json");
}

test("JSON IO keeps missing, corrupt and over-limit files distinguishable", t => {
  const file = fixture(t);
  assert.equal(readJsonFile(file, "missing"), "missing");
  fs.writeFileSync(file, "broken");
  assert.throws(() => readJsonFile(file), SyntaxError);
  writeJsonFileSync(file, { ready: true });
  assert.deepEqual(readJsonFile(file), { ready: true });
  assert.throws(() => readJsonFile(file, null, { maxBytes: 2 }), /size limit/);
});

test("JSON saver batches updates and leaves no staged file after commit", async t => {
  const file = fixture(t);
  let value = { count: 1 };
  const saver = createJsonSaver(file, () => value, { debounceMs: 60000 });
  t.after(saver.dispose);
  saver.markDirty(); value = { count: 2 }; saver.markDirty();
  assert.equal(await saver.flush(), true);
  assert.deepEqual(readJsonFile(file), { count: 2 });
  assert.deepEqual(saver.status(), { dirty: false, saving: false });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("sync shutdown save cannot be overwritten by an older async snapshot", async t => {
  const file = fixture(t);
  let value = { count: 1 };
  let release;
  let started;
  const writing = new Promise(resolve => { started = resolve; });
  const io = { ...fs, promises: { ...fs.promises, writeFile: async (...args) => {
    started(); await new Promise(resolve => { release = resolve; }); return fs.promises.writeFile(...args);
  } } };
  const saver = createJsonSaver(file, () => value, { io, debounceMs: 60000 });
  t.after(saver.dispose);
  saver.markDirty(); const pending = saver.flush(); await writing;
  value = { count: 2 }; saver.markDirty();
  assert.equal(saver.flushSync(), true);
  release(); await pending;
  assert.deepEqual(readJsonFile(file), { count: 2 });
});

test("failed atomic commit keeps old data and remains dirty for retry", async t => {
  const file = fixture(t);
  writeJsonFileSync(file, { count: 1 });
  let fail = true;
  let errors = 0;
  const saver = createJsonSaver(file, () => ({ count: 2 }), {
    debounceMs: 60000, onError: () => { errors++; },
    io: { ...fs, renameSync: (...args) => { if (fail) throw new Error("disk unavailable"); return fs.renameSync(...args); } },
  });
  t.after(saver.dispose);
  saver.markDirty(); assert.equal(await saver.flush(), false);
  assert.equal(saver.status().dirty, true); assert.equal(errors, 1);
  assert.deepEqual(readJsonFile(file), { count: 1 });
  fail = false; assert.equal(await saver.flush(), true);
  assert.deepEqual(readJsonFile(file), { count: 2 });
});

test("ongoing mutations checkpoint without losing the next dirty revision", async t => {
  const file = fixture(t);
  let value = { count: 1 };
  let release;
  let started;
  const writing = new Promise(resolve => { started = resolve; });
  let first = true;
  const io = { ...fs, promises: { ...fs.promises, writeFile: async (...args) => {
    if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); }
    return fs.promises.writeFile(...args);
  } } };
  const saver = createJsonSaver(file, () => value, { io, debounceMs: 60000 });
  t.after(saver.dispose);
  saver.markDirty(); const pending = saver.flush(); await writing;
  value = { count: 2 }; saver.markDirty(); release();
  assert.equal(await pending, false);
  assert.deepEqual(readJsonFile(file), { count: 1 });
  assert.equal(saver.status().dirty, true);
  assert.equal(await saver.flush(), true);
  assert.deepEqual(readJsonFile(file), { count: 2 });
});
