import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import test from "node:test";
import { readJsonFile, writeJsonFileSync } from "../bridge/persistence/json-file.mjs";
import { createConfirmationStore } from "../bridge/chat-tools/confirmations.mjs";

const TEMP = process.platform === "win32" ? "F:/CodexArtifacts/qqfriend/20261001/temp" : os.tmpdir();
const START = 1_790_841_600_000;
const TTL = 300000;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const SOURCE = "a".repeat(64);
const SCOPE = Object.freeze({ surface: "group", groupId: "710001", userId: "810001" });
const BINDING = Object.freeze({ privacyRevision: 1, userRevision: "user-1", sourceIdentity: SOURCE });
const OP = Object.freeze({ domain: "personal", action: "set_name", parameters: { value: "Alice" },
  baseline: { revision: "revision-1", sourceIdentity: SOURCE }, preview: "Synthetic reviewed change" });
const MODULE = new URL("../bridge/chat-tools/confirmations.mjs", import.meta.url).href;
const disk = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
const put = (filename, state) => fs.writeFileSync(filename, JSON.stringify(state));

function fixture(t) {
  fs.mkdirSync(TEMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEMP, "a3-retention-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(TEMP) + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "confirmations.json");
  let at = START, mode = "ok", writes = 0;
  const options = { filename, now: () => at, write(file, state, settings) {
    writes++;
    assert.equal(settings.durable, true);
    if (mode === "false") return false;
    if (mode === "throw") throw new Error("Synthetic persistence failure");
    if (mode === "noop") return undefined;
    writeJsonFileSync(file, state, settings);
    if (mode === "after-rename") throw new Error("Synthetic post-rename uncertainty");
    if (mode === "renamed-false") return false;
    if (mode === "mismatch") put(file, { ...state, sequence: state.sequence + 1 });
    return undefined;
  } };
  const reload = overrides => createConfirmationStore({ ...options, ...overrides });
  return { filename, store: reload(), reload, now: () => at, writes: () => writes,
    setTime: value => { at = value; }, setMode: value => { mode = value; } };
}
function create(store, messageId = "0", scope = SCOPE, operation = OP, binding = BINDING) {
  return store.create(scope, operation, { messageId, binding });
}
function execute(store, ref, apply = () => ({ status: "applied" }), binding = BINDING) {
  return store.execute(SCOPE, ref, { binding, assertCurrent() {}, apply });
}
function cold(f, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import process from 'node:process';
    import {createConfirmationStore} from ${JSON.stringify(MODULE)};
    const filename = ${JSON.stringify(f.filename)};
    const scope = ${JSON.stringify(SCOPE)}, binding = ${JSON.stringify(BINDING)}, op = ${JSON.stringify(OP)};
    const store = createConfirmationStore({filename, now: () => ${f.now()}});
    ${code}
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function terminal(f, status, messageId = "0") {
  const draft = create(f.store, messageId);
  assert.equal(draft.status, "pending");
  f.setTime(f.now() + 1000);
  if (status === "revoked") assert.equal(f.store.revoke(SCOPE, draft.ref).status, status);
  else if (status === "expired") {
    f.setTime(f.now() + TTL);
    assert.equal(f.store.inspect(SCOPE, draft.ref).item.phase, status);
  } else {
    const binding = status === "invalidated" ? { ...BINDING, userRevision: "user-2" } : BINDING;
    const result = await execute(f.store, draft.ref, () => ({ status, text: "Synthetic receipt" }), binding);
    assert.equal(result.status, status === "invalidated" ? "denied" : status);
  }
  return draft.ref;
}

test("only the five certain statuses prune at exactly seven days from finishedAt, not createdAt", async t => {
  for (const status of ["applied", "not_applied", "revoked", "expired", "invalidated"]) {
    const f = fixture(t), ref = await terminal(f, status);
    const finishedAt = disk(f.filename).rows[0].finishedAt;
    const before = fs.readFileSync(f.filename, "utf8"), writes = f.writes();
    f.setTime(finishedAt + RETENTION - 1);
    assert.equal(f.store.inspect(SCOPE, ref).item.phase, status);
    assert.equal(fs.readFileSync(f.filename, "utf8"), before);
    assert.equal(f.writes(), writes);
    f.setTime(finishedAt + RETENTION);
    assert.equal(f.store.inspect(SCOPE, ref).status, "denied");
    const state = disk(f.filename);
    assert.deepEqual(state.rows, []);
    assert.equal(state.version, 1);
    assert.equal(state.sequence, JSON.parse(before).sequence + 1);
    assert.equal(state.updatedAt, finishedAt + RETENTION);
    assert.equal(f.writes(), writes + 1);
    assert.equal(f.store.revoke(SCOPE, ref).status, "not_found");
    let applies = 0;
    assert.equal((await execute(f.store, ref, () => { applies++; })).status, "denied");
    assert.equal(applies, 0);
  }
});

test("128 terminal rows remain capacity at the old clock and release only at eligible age", t => {
  const f = fixture(t), refs = new Set();
  for (let index = 0; index < 128; index++) {
    const draft = create(f.store, String(index));
    assert.equal(draft.status, "pending");
    refs.add(draft.ref);
    assert.equal(f.store.revoke(SCOPE, draft.ref).status, "revoked");
  }
  for (const at of [START + TTL + 1, START + RETENTION - 1]) {
    f.setTime(at);
    assert.equal(create(f.store, "128").status, "capacity");
    assert.equal(disk(f.filename).rows.length, 128);
  }
  f.setTime(START + RETENTION);
  const fresh = create(f.store, "128");
  assert.equal(fresh.status, "pending");
  assert.equal(refs.has(fresh.ref), false);
  assert.equal(disk(f.filename).rows.length, 1);
  assert.ok(fs.statSync(f.filename).size <= 1024 * 1024);
  for (let index = 129; index < 132; index++) assert.equal(create(f.store, String(index)).status, "pending");
  assert.equal(create(f.store, "132").status, "capacity");
  assert.equal(disk(f.filename).rows.filter(row => row.status === "pending").length, 4);
});

test("unknown, live executing and newly recovered expiry survive mixed eligible pruning", async t => {
  const f = fixture(t), retired = await terminal(f, "revoked");
  const unknown = await terminal(f, "unknown", "1");
  const pending = create(f.store, "2").ref, executing = create(f.store, "3").ref;
  let release, applies = 0;
  const held = new Promise(resolve => { release = resolve; });
  const running = execute(f.store, executing, () => { applies++; return held; });
  assert.equal(disk(f.filename).rows.find(row => row.ref === executing).status, "executing");
  const at = START + 2 * RETENTION;
  f.setTime(at);
  assert.equal(f.store.list().status, "ready");
  const rows = disk(f.filename).rows;
  assert.equal(rows.some(row => row.ref === retired), false);
  assert.equal(rows.find(row => row.ref === unknown).status, "unknown");
  assert.equal(rows.find(row => row.ref === executing).status, "executing");
  assert.equal(rows.find(row => row.ref === pending).status, "expired");
  assert.equal(rows.find(row => row.ref === pending).finishedAt, at);
  f.setTime(at + RETENTION - 1);
  assert.equal(f.store.inspect(SCOPE, pending).item.phase, "expired");
  f.setTime(at + RETENTION);
  assert.equal(f.store.inspect(SCOPE, pending).status, "denied");
  release({ status: "unknown" });
  assert.equal((await running).status, "unknown");
  f.setTime(at + 10 * RETENTION);
  assert.equal(f.store.list().items.length, 2);
  for (const ref of [unknown, executing]) assert.equal((await execute(f.store, ref, () => { applies++; })).status, "unknown");
  assert.equal(applies, 1);
});

test("128 unknown receipts stay bounded and do not regain capacity by age", async t => {
  const f = fixture(t);
  for (let index = 0; index < 128; index++) {
    const draft = create(f.store, String(index));
    assert.equal(draft.status, "pending");
    assert.equal((await execute(f.store, draft.ref, () => ({ status: "unknown" }))).status, "unknown");
  }
  f.setTime(START + 100 * RETENTION);
  const writes = f.writes();
  assert.equal(create(f.store, "128").status, "capacity");
  assert.equal(f.store.list().items.length, 128);
  assert.equal(f.writes(), writes);
});

test("scoped event idempotency is unchanged inside retention and a new ref is required outside it", async t => {
  const f = fixture(t), ref = await terminal(f, "applied");
  const finishedAt = disk(f.filename).rows[0].finishedAt;
  const writes = f.writes();
  f.setTime(finishedAt + RETENTION - 1);
  assert.deepEqual(create(f.store), { status: "applied", ref });
  assert.deepEqual(create(f.store, "0", SCOPE, OP, { ...BINDING, userRevision: "user-2" }), { status: "applied", ref });
  assert.equal(f.writes(), writes);
  // GC intentionally ends this owner/message/operation duplicate window, not ref authorization.
  f.setTime(finishedAt + RETENTION);
  const fresh = create(f.store);
  assert.equal(fresh.status, "pending");
  assert.notEqual(fresh.ref, ref);
  let applies = 0;
  assert.equal((await execute(f.store, ref, () => { applies++; })).status, "denied");
  assert.equal(applies, 0);
  assert.equal((await execute(f.store, fresh.ref, () => { applies++; return { status: "applied" }; })).status, "applied");
  assert.equal(applies, 1);
});

test("cold restart prunes retained receipts and denies old refs with zero apply", async t => {
  const f = fixture(t), ref = await terminal(f, "applied");
  f.setTime(f.now() + RETENTION);
  const result = cold(f, `let applies = 0;
    const result = await store.execute(scope, ${JSON.stringify(ref)}, {binding, assertCurrent() {},
      apply() {applies++; return {status:'applied'};}});
    process.stdout.write(JSON.stringify({result, applies, rows: JSON.parse(fs.readFileSync(filename,'utf8')).rows}));`);
  assert.equal(result.result.status, "denied");
  assert.equal(result.applies, 0);
  assert.deepEqual(result.rows, []);
});

test("cold recovery starts a fresh seven-day clock for pending and never prunes interrupted unknown", t => {
  const f = fixture(t);
  const { pending, interrupted } = cold(f, `const pending = store.create(scope,op,{messageId:'0',binding}).ref;
    const draft = store.create(scope,op,{messageId:'1',binding});
    await store.execute(scope,draft.ref,{binding,assertCurrent() {},apply() {
      process.stdout.write(JSON.stringify({pending, interrupted:draft.ref})); process.exit(0);
    }});`);
  f.setTime(START + 2 * RETENTION);
  assert.equal(f.store.list().status, "ready");
  const rows = disk(f.filename).rows;
  assert.equal(rows.find(row => row.ref === pending).status, "invalidated");
  assert.equal(rows.find(row => row.ref === pending).finishedAt, f.now());
  assert.equal(rows.find(row => row.ref === interrupted).status, "unknown");
  f.setTime(f.now() + RETENTION);
  assert.deepEqual(f.store.list().items.map(row => row.ref), [interrupted]);
});

test("GC false, throw, no-op, post-rename uncertainty and mismatched verification all fail closed", async t => {
  for (const mode of ["false", "throw", "noop", "after-rename", "renamed-false", "mismatch"]) {
    const f = fixture(t), ref = await terminal(f, "revoked");
    const before = fs.readFileSync(f.filename, "utf8"), writes = f.writes();
    f.setTime(f.now() + RETENTION);
    f.setMode(mode);
    assert.equal(f.store.list().status, "unavailable", mode);
    assert.equal(f.writes(), writes + 1);
    if (["false", "throw", "noop"].includes(mode)) assert.equal(fs.readFileSync(f.filename, "utf8"), before);
    f.setMode("ok");
    let applies = 0;
    assert.equal((await execute(f.store, ref, () => { applies++; })).status, "unknown");
    assert.equal(f.writes(), writes + 1);
    // The attempted prune must not shrink shared observations or authorize another factory.
    if (["after-rename", "renamed-false", "mismatch"].includes(mode)) {
      assert.equal(f.reload().list().status, "unavailable");
      assert.equal((await execute(f.reload(), ref, () => { applies++; })).status, "unknown");
    }
    assert.equal(applies, 0);
  }
});

test("verified pruning is shared across early and late factories, with repeated bounded replacement", t => {
  const f = fixture(t), early = f.reload();
  let retired;
  for (let cycle = 0; cycle < 12; cycle++) {
    const draft = create(f.store, String(cycle));
    assert.equal(draft.status, "pending");
    retired = draft.ref;
    assert.equal(f.store.revoke(SCOPE, retired).status, "revoked");
    f.setTime(f.now() + RETENTION);
    assert.deepEqual(f.reload().list(), { status: "ready", items: [] });
    assert.deepEqual(early.list(), { status: "ready", items: [] });
    assert.deepEqual(f.store.list(), { status: "ready", items: [] });
    assert.deepEqual(disk(f.filename).rows, []);
  }
  const fresh = create(early, "12");
  assert.equal(fresh.status, "pending");
  assert.notEqual(fresh.ref, retired);
  assert.equal(f.store.inspect(SCOPE, fresh.ref).status, "ready");
});

test("old-state rollback and higher-sequence resurrection cannot revive pruned rows or receipt bodies", async t => {
  for (const mode of ["rollback", "terminal-resurrection", "pending-resurrection"]) {
    const f = fixture(t), early = f.reload(), draft = create(f.store);
    const pending = disk(f.filename);
    assert.equal((await execute(f.store, draft.ref, () => ({ status: "applied", text: "Synthetic erased receipt" }))).status, "applied");
    const receipt = disk(f.filename);
    assert.equal(f.store.revokeUser(SCOPE.userId), true);
    f.setTime(f.now() + RETENTION);
    assert.equal(f.reload().list().status, "ready");
    const latest = disk(f.filename);
    const restored = mode === "pending-resurrection" ? pending : receipt;
    if (mode !== "rollback") { restored.sequence = latest.sequence + 1; restored.updatedAt = f.now(); }
    put(f.filename, restored);
    const damaged = fs.readFileSync(f.filename, "utf8");
    let applies = 0;
    for (const store of [early, f.store, f.reload()]) {
      const result = await execute(store, draft.ref, () => { applies++; return { status: "applied" }; });
      assert.equal(result.status, "unknown", mode);
      assert.equal(result.text, undefined);
      assert.deepEqual(store.list(), { status: "unavailable", items: [] });
    }
    assert.equal(applies, 0);
    assert.equal(fs.readFileSync(f.filename, "utf8"), damaged);
  }
});

test("external deletion cannot masquerade as eligible GC even with a higher sequence", async t => {
  for (const higher of [false, true]) {
    const f = fixture(t), ref = await terminal(f, "revoked");
    f.setTime(f.now() + RETENTION);
    const state = disk(f.filename);
    state.rows = [];
    if (higher) { state.sequence++; state.updatedAt = f.now(); }
    put(f.filename, state);
    const writes = f.writes(), damaged = fs.readFileSync(f.filename, "utf8");
    assert.equal(f.reload().list().status, "unavailable");
    let applies = 0;
    assert.equal((await execute(f.store, ref, () => { applies++; })).status, "unknown");
    assert.equal(applies, 0);
    assert.equal(f.writes(), writes);
    assert.equal(fs.readFileSync(f.filename, "utf8"), damaged);
  }
});

test("higher-sequence restoration of a scrubbed retained receipt is rejected before GC", async t => {
  const f = fixture(t), ref = await terminal(f, "applied");
  const old = disk(f.filename);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  assert.equal(f.reload().list().status, "ready");
  old.sequence = disk(f.filename).sequence + 1;
  put(f.filename, old);
  let applies = 0;
  const result = await execute(f.reload(), ref, () => { applies++; });
  assert.equal(result.status, "unknown");
  assert.equal(result.text, undefined);
  assert.equal(applies, 0);
});

test("a future legitimate row and an unused UUID nonce are not treated as retired refs", async t => {
  const f = fixture(t), retired = await terminal(f, "revoked");
  f.setTime(f.now() + RETENTION);
  assert.equal(f.store.list().status, "ready");
  const nonce = `cf_${randomUUID().replaceAll("-", "")}`;
  assert.notEqual(nonce, retired);
  f.setTime(f.now() + 1);
  const future = cold(f, `process.stdout.write(JSON.stringify(store.create(scope,op,{messageId:'1',binding})));`);
  assert.equal(future.status, "pending");
  assert.notEqual(future.ref, retired);
  assert.notEqual(future.ref, nonce);
  const view = f.store.inspect(SCOPE, future.ref);
  assert.equal(view.status, "ready");
  assert.equal(view.item.phase, "invalidated");
  assert.equal(f.store.inspect(SCOPE, nonce).status, "denied");
  let applies = 0;
  for (const ref of [nonce, future.ref]) assert.equal((await execute(f.store, ref, () => { applies++; })).status, "denied");
  assert.equal(applies, 0);
  assert.equal(create(f.store, "2").status, "pending");
});

test("nonpersisting forget skips all GC and recovery with no hidden data write", async t => {
  const f = fixture(t), ref = await terminal(f, "applied");
  const pending = create(f.store, "1").ref;
  const before = fs.readFileSync(f.filename, "utf8"), writes = f.writes();
  f.setTime(f.now() + 2 * RETENTION);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  assert.equal(f.writes(), writes);
  assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.equal(fs.existsSync(`${f.filename}.lock`), false);
  assert.equal(f.reload().list().status, "ready");
  const rows = disk(f.filename).rows;
  assert.equal(rows.some(row => row.ref === ref), false);
  assert.equal(rows.find(row => row.ref === pending).status, "revoked");
  assert.equal(rows.find(row => row.ref === pending).finishedAt, f.now());
  assert.equal(rows.find(row => row.ref === pending).operation, null);
  assert.equal(f.writes(), writes + 1);
});

test("nonpersisting forget rejects settings and state getters without invoking them or writing", async t => {
  for (const target of ["settings", "state"]) {
    const f = fixture(t);
    await terminal(f, "revoked");
    f.setTime(f.now() + RETENTION);
    const before = fs.readFileSync(f.filename, "utf8"), writes = f.writes();
    let getters = 0;
    const settings = { persist: false };
    let store = f.store;
    if (target === "settings") Object.defineProperty(settings, "persist", { enumerable: true, get() { getters++; return false; } });
    else {
      const state = disk(f.filename);
      Object.defineProperty(state.rows[0], "finishedAt", { enumerable: true, get() { getters++; return START; } });
      store = f.reload({ read() { return state; } });
    }
    assert.equal(store.revokeUser(SCOPE.userId, settings), false);
    assert.equal(getters, 0);
    assert.equal(f.writes(), writes);
    assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  }
});

test("clock regression across factories or nonpersisting forget cannot be masked by eligible GC", async t => {
  for (const access of ["list", "forget"]) {
    const f = fixture(t);
    await terminal(f, "revoked");
    f.setTime(f.now() + RETENTION);
    assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
    const before = fs.readFileSync(f.filename, "utf8"), writes = f.writes();
    f.setTime(f.now() - 1);
    const other = f.reload();
    if (access === "list") assert.equal(other.list().status, "unavailable");
    else assert.equal(other.revokeUser(SCOPE.userId, { persist: false }), false);
    assert.equal(f.writes(), writes);
    assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  }
});

test("missing, corrupt, oversized or invalid state cannot be reset or rewritten by GC or forget", async t => {
  const damage = [file => fs.unlinkSync(file), file => fs.writeFileSync(file, "{broken"),
    file => fs.writeFileSync(file, " ".repeat(1024 * 1024 + 1)),
    file => put(file, { ...disk(file), version: 2 }),
    file => { const state = disk(file); state.rows[0].finishedAt = state.updatedAt + 1; put(file, state); }];
  for (const mutate of damage) {
    const f = fixture(t), ref = await terminal(f, "revoked");
    f.setTime(f.now() + RETENTION);
    mutate(f.filename);
    const before = fs.existsSync(f.filename) ? fs.readFileSync(f.filename, "utf8") : null;
    const writes = f.writes();
    assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), false);
    assert.equal(f.reload().list().status, "unavailable");
    let applies = 0;
    assert.equal((await execute(f.store, ref, () => { applies++; })).status, "unknown");
    assert.equal(applies, 0);
    assert.equal(f.writes(), writes);
    assert.equal(fs.existsSync(f.filename) ? fs.readFileSync(f.filename, "utf8") : null, before);
  }
});

test("unseen missing state is not materialized by list or nonpersisting forget", t => {
  const f = fixture(t);
  assert.deepEqual(f.store.list(), { status: "ready", items: [] });
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  assert.equal(f.writes(), 0);
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(readJsonFile(f.filename, null), null);
});
