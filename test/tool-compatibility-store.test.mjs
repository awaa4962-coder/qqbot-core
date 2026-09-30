import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import test from "node:test";
import { createToolCompatibilityStore } from "../bridge/chat-tools/compatibility-store.mjs";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const START = 1_700_000_000_000;
const DAY = 86400000;
const MODULE_URL = new URL("../bridge/chat-tools/compatibility-store.mjs", import.meta.url).href;
const USAGE = { promptTokens: 21, cachedTokens: 7, completionTokens: 12, reasoningTokens: 4,
  totalTokens: 33, transportAttempts: 2, usageReported: true, cacheReported: true, reasoningReported: true };

function fixture(t, ttlMs = DAY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-tool-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "proof.json");
  let at = START;
  const reload = () => createToolCompatibilityStore({ file, now: () => at, ttlMs });
  return { root, file, reload, store: reload(), setTime: value => { at = value; } };
}
function result(status = "verified", reason = "", usage = USAGE) {
  return { status, reason, usage, durationMs: 50 };
}
function reserveBoth(store, claimId) {
  assert.equal(store.reserveAttempt(ID, claimId, 0), true);
  assert.equal(store.reserveAttempt(ID, claimId, 1), true);
}
function disk(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function noAuthorization(store, claimId) {
  assert.equal(store.claim(ID).ok, false);
  assert.equal(store.reserveAttempt(ID, claimId, 0), false);
  assert.equal(store.finish(ID, claimId, result()), false);
  assert.equal(store.read(ID).status, "unknown");
  assert.equal(store.snapshot().ok, false);
}

async function workers(t, file, action, count = 6) {
  const jobs = Array.from({ length: count }, () => {
    const code = `import { createToolCompatibilityStore } from ${JSON.stringify(MODULE_URL)};
      import process from "node:process";
      const store = createToolCompatibilityStore({ file: ${JSON.stringify(file)}, now: () => ${START} });
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify(${action}) + "\\n"); process.stdin.destroy();
      }); process.stdout.write("ready\\n");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "";
    let errors = "";
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Worker timed out")); }, 10000);
      child.stdout.on("data", data => { output += data; if (output.startsWith("ready\n")) ready(); });
      child.stderr.on("data", data => { errors += data; });
      child.on("error", error => { clearTimeout(timer); ready(); reject(error); });
      child.on("close", exitCode => {
        clearTimeout(timer); ready();
        if (exitCode !== 0) reject(new Error(`Worker failed: ${errors}`));
        else {
          try { resolve(JSON.parse(output.split("\n")[1])); } catch (error) { reject(error); }
        }
      });
    });
    return { child, started, completed };
  });
  await Promise.all(jobs.map(job => job.started));
  for (const job of jobs) job.child.stdin.end("go");
  return Promise.all(jobs.map(job => job.completed));
}

test("first boot is read-only; a durable claim survives a cold reload and consumes a full day", t => {
  const f = fixture(t);
  assert.equal(f.store.read(ID).status, "unknown");
  assert.equal(f.store.snapshot().status, "empty");
  assert.equal(f.store.snapshot().health, "ready");
  assert.deepEqual(fs.readdirSync(f.root), []);
  const claim = f.store.claim(ID);
  assert.equal(claim.ok, true);
  assert.equal(disk(f.file).records[0].claimId, claim.claimId);
  assert.equal(f.reload().claim(ID).reason, "claim_busy");
  assert.equal(f.reload().read(ID).attempts, 0);
  f.setTime(START + DAY - 1);
  assert.equal(f.reload().claim(ID).ok, false);
  f.setTime(START + DAY);
  const next = f.reload().claim(ID);
  assert.equal(next.ok, true);
  assert.notEqual(next.claimId, claim.claimId);
  assert.equal(f.reload().reserveAttempt(ID, claim.claimId, 0), false);
});

test("stages are durable, ordered, identity-bound, unique, and paid only after successful reservation", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  let paid = 0;
  const attempt = (identity, lease, stage) => { if (f.reload().reserveAttempt(identity, lease, stage)) paid++; };
  attempt(ID, claimId, 1);
  attempt(OTHER, claimId, 0);
  attempt(ID, "not-a-claim", 0);
  for (const stage of [-1, 2, "0", null, undefined]) attempt(ID, claimId, stage);
  assert.equal(paid, 0);
  attempt(ID, claimId, 0);
  attempt(ID, claimId, 0);
  assert.equal(f.reload().read(ID).attempts, 1);
  assert.equal(f.reload().finish(ID, claimId, result()), false);
  attempt(ID, claimId, 1);
  attempt(ID, claimId, 1);
  assert.equal(paid, 2);
  assert.deepEqual(disk(f.file).records[0].attempts, [0, 1]);
  assert.equal(f.reload().finish(ID, claimId, result()), true);
  assert.equal(f.reload().reserveAttempt(ID, claimId, 0), false);
  assert.equal(f.reload().finish(ID, claimId, result()), false);
  assert.equal(f.reload().claim(ID).ok, false);
  assert.deepEqual(f.reload().read(ID), { status: "verified", healthCode: "ok", checkedAt: START,
    expiresAt: START + DAY, attempts: 2, reason: "", usage: USAGE, durationMs: 50 });
});

test("independent processes cannot double-claim or double-reserve either stage", async t => {
  const f = fixture(t);
  const claims = await workers(t, f.file, `store.claim(${JSON.stringify(ID)})`);
  const winners = claims.filter(claim => claim.ok);
  assert.equal(winners.length, 1);
  for (const claim of claims.filter(entry => !entry.ok)) assert.ok(["lock_busy", "claim_busy"].includes(claim.reason));
  const { claimId } = winners[0];
  for (const stage of [0, 1]) {
    const reservations = await workers(t, f.file, `store.reserveAttempt(${JSON.stringify(ID)}, ${JSON.stringify(claimId)}, ${stage})`);
    assert.equal(reservations.filter(Boolean).length, 1);
  }
  assert.equal(f.reload().read(ID).attempts, 2);
});

test("a busy or abandoned lock is never deleted, reclaimed, or used to authorize payment", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  const original = fs.readFileSync(f.file);
  fs.writeFileSync(`${f.file}.lock`, "abandoned-lock-private-marker");
  assert.equal(f.reload().claim(OTHER).reason, "lock_busy");
  assert.equal(f.reload().reserveAttempt(ID, claimId, 0), false);
  assert.equal(f.reload().finish(ID, claimId, result("unsupported", "protocol_not_supported", {})), false);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(fs.readFileSync(`${f.file}.lock`, "utf8"), "abandoned-lock-private-marker");
});

test("unsupported zero-attempt and cancelled results are terminal without refunding quota", t => {
  const f = fixture(t);
  const unsupported = f.store.claim(ID);
  assert.equal(f.store.finish(ID, unsupported.claimId, result("unsupported", "native_tools_not_declared", {})), true);
  const safe = f.reload().read(ID);
  assert.equal(safe.status, "unsupported");
  assert.equal(safe.attempts, 0);
  assert.equal(safe.usage.promptTokens, null);
  assert.equal(safe.usage.usageReported, false);
  assert.equal(f.reload().claim(ID).ok, false);
  const cancelled = f.store.claim(OTHER);
  assert.equal(f.store.finish(OTHER, cancelled.claimId, result("failed", "cancelled", {})), true);
  assert.equal(f.reload().reserveAttempt(OTHER, cancelled.claimId, 0), false);
  assert.equal(f.reload().claim(OTHER).ok, false);
});

test("verified proof TTL is independent of the 24h quota and other fingerprints stay unknown", t => {
  const f = fixture(t, 1000);
  const { claimId } = f.store.claim(ID);
  reserveBoth(f.store, claimId);
  f.setTime(START + 100);
  assert.equal(f.store.finish(ID, claimId, result()), true);
  assert.equal(f.store.read(ID).checkedAt, START + 100);
  assert.equal(f.store.read(ID).expiresAt, START + 1100);
  assert.equal(f.store.read(OTHER).status, "unknown");
  f.setTime(START + 1099);
  assert.equal(f.reload().read(ID).status, "verified");
  f.setTime(START + 1100);
  assert.equal(f.reload().read(ID).status, "unknown");
  assert.equal(f.reload().claim(ID).reason, "claim_busy");
});

test("expired pending claims cannot reserve or finish, and are not automatically resumed", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  assert.equal(f.store.reserveAttempt(ID, claimId, 0), true);
  assert.equal(f.reload().claim(ID).ok, false);
  assert.equal(f.reload().read(ID).status, "pending");
  f.setTime(START + DAY);
  const original = fs.readFileSync(f.file);
  assert.equal(f.reload().reserveAttempt(ID, claimId, 1), false);
  assert.equal(f.reload().finish(ID, claimId, result("failed", "probe_deadline", {})), false);
  assert.equal(f.reload().read(ID).status, "unknown");
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test("capacity refuses 32 unexpired claims including terminal ones; only expired quota can be pruned", t => {
  const f = fixture(t);
  const identities = Array.from({ length: 32 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
  const first = f.store.claim(identities[0]);
  f.setTime(START + 100);
  for (const identity of identities.slice(1)) assert.equal(f.store.claim(identity).ok, true);
  assert.equal(f.store.finish(identities[0], first.claimId, result("failed", "transport_unavailable", {})), true);
  const original = fs.readFileSync(f.file);
  assert.equal(f.store.claim(ID).reason, "capacity");
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(f.reload().claim(identities[1]).ok, false);
  assert.equal(f.store.snapshot().recordCount, 32);
  f.setTime(START + DAY);
  assert.equal(f.store.claim(ID).ok, true);
  assert.equal(f.store.snapshot().recordCount, 32);
  assert.equal(f.store.read(identities[0]).status, "unknown");
  assert.equal(f.store.read(identities[1]).status, "pending");
  assert.equal(fs.statSync(f.file).size <= 64 * 1024, true);
});

test("backward and invalid clocks cannot expire, recreate, or authorize claims", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  const original = fs.readFileSync(f.file);
  f.setTime(START - 1);
  assert.equal(f.reload().read(ID).healthCode, "clock_skew");
  assert.equal(f.reload().claim(ID).reason, "clock_skew");
  assert.equal(f.reload().reserveAttempt(ID, claimId, 0), false);
  assert.equal(f.reload().finish(ID, claimId, result("unsupported", "provider_not_configured", {})), false);
  for (const value of [-1, NaN, Infinity, START + 0.5, Number.MAX_SAFE_INTEGER]) {
    f.setTime(value);
    assert.equal(f.reload().claim(OTHER).ok, false);
  }
  assert.deepEqual(fs.readFileSync(f.file), original);
  f.setTime(START + 100);
  assert.equal(f.store.read(ID).status, "pending");
  f.setTime(START + 99);
  assert.equal(f.store.claim(OTHER).reason, "clock_skew");
});

test("durable claim and reservations fsync before rename; failed persistence never grants an API budget", async t => {
  for (const step of ["claim", "reserve", "finish"]) await t.test(step, sub => {
    const f = fixture(sub);
    const { claimId } = f.store.claim(ID);
    if (step === "finish") reserveBoth(f.store, claimId);
    const original = fs.readFileSync(f.file);
    let paid = 0;
    sub.mock.method(fs, "fsyncSync", () => { throw new Error("secret upstream disk failure"); });
    const granted = step === "claim" ? f.store.claim(OTHER).ok : step === "reserve"
      ? f.store.reserveAttempt(ID, claimId, 0) : f.store.finish(ID, claimId, result());
    if (granted) paid++;
    assert.equal(paid, 0);
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(f.store.snapshot().healthCode, "write_failed");
    assert.deepEqual(fs.readdirSync(f.root), ["proof.json"]);
  });
  await t.test("successful ordering", sub => {
    const f = fixture(sub);
    const calls = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    sub.mock.method(fs, "fsyncSync", fd => { calls.push("sync"); sync(fd); });
    sub.mock.method(fs, "renameSync", (...args) => { calls.push("rename"); rename(...args); });
    const { claimId } = f.store.claim(ID);
    assert.equal(f.store.reserveAttempt(ID, claimId, 0), true);
    const sequence = process.platform === "win32" ? ["sync", "rename"] : ["sync", "rename", "sync"];
    assert.deepEqual(calls, [...sequence, ...sequence]);
  });
});

test("a first-boot persistence failure does not authorize or silently retry", t => {
  const f = fixture(t);
  const mock = t.mock.method(fs, "renameSync", () => { throw new Error("private rename error"); });
  assert.equal(f.store.claim(ID).ok, false);
  mock.mock.restore();
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.store.claim(ID).reason, "write_failed");
  assert.equal(f.reload().claim(ID).ok, true);
});

test("malformed, oversized and wrong-schema state is never reset or overwritten", async t => {
  const variants = [
    ["corrupt", "{broken-private-key"], ["invalid_schema", "null"], ["invalid_schema", "[]"],
    ["invalid_schema", '{"version":2,"updatedAt":0,"records":[]}'],
    ["invalid_schema", '{"version":1,"updatedAt":0,"records":[],"key":"SECRET"}'],
    ["oversized", " ".repeat(64 * 1024 + 1)],
  ];
  for (const [reason, bytes] of variants) await t.test(reason + bytes.length, sub => {
    const f = fixture(sub);
    fs.writeFileSync(f.file, bytes);
    noAuthorization(f.store, "00000000-0000-4000-8000-000000000000");
    assert.equal(f.store.read(ID).healthCode, reason);
    assert.equal(fs.readFileSync(f.file, "utf8"), bytes);
    assert.deepEqual(fs.readdirSync(f.root), ["proof.json"]);
    fs.unlinkSync(f.file);
    assert.equal(f.store.claim(ID).ok, false);
    assert.deepEqual(fs.readdirSync(f.root), []);
  });
});

test("every strict on-disk schema boundary rejects unsafe or inconsistent records byte-for-byte", async t => {
  const mutations = [
    value => { value.updatedAt = -1; }, value => { value.records[0].identity = "A".repeat(64); },
    value => { value.records[0].claimId = "secret"; }, value => { value.records[0].expiresAt++; },
    value => { value.records[0].claimedAt++; }, value => { value.records[0].attempts = [1]; },
    value => { value.records[0].attempts = [0, 0]; }, value => { value.records[0].attempts = [0, 1, 1]; },
    value => { value.records[0].attempts = 2; }, value => { value.records[0].finishedAt = START; },
    value => { value.records[0].result = result(); }, value => { value.records[0].args = "SECRET"; },
    value => { value.records.push(value.records[0]); },
    value => { value.records = Array.from({ length: 33 }, () => value.records[0]); },
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(`boundary ${index}`, sub => {
    const f = fixture(sub);
    const { claimId } = f.store.claim(ID);
    const value = disk(f.file);
    mutate(value); write(f.file, value);
    const original = fs.readFileSync(f.file);
    noAuthorization(f.reload(), claimId);
    assert.deepEqual(fs.readFileSync(f.file), original);
  });
});

test("read IO errors preserve exact bytes, expose only safe health codes, and latch closed", async t => {
  for (const method of ["lstatSync", "statSync", "readFileSync"]) await t.test(method, sub => {
    const f = fixture(sub);
    const { claimId } = f.store.claim(ID);
    const original = fs.readFileSync(f.file);
    const mock = sub.mock.method(fs, method, () => { throw Object.assign(new Error("SECRET/private/path"), { code: "EIO" }); });
    noAuthorization(f.store, claimId);
    assert.doesNotMatch(JSON.stringify(f.store.snapshot()), /SECRET|private|path/);
    assert.equal(f.store.read(ID).healthCode, "read_failed");
    mock.mock.restore();
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(f.store.claim(OTHER).ok, false);
    assert.deepEqual(fs.readdirSync(f.root), ["proof.json"]);
  });
});

test("ENOENT after observing a file or during its read is not first boot", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  fs.unlinkSync(f.file);
  noAuthorization(f.store, claimId);
  assert.equal(fs.existsSync(f.file), false);
  const other = fixture(t);
  const lease = other.store.claim(ID);
  const original = fs.readFileSync(other.file);
  const mock = t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  noAuthorization(other.reload(), lease.claimId);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(other.file), original);
});

test("directory and dangling symlink targets are not reset as missing state", t => {
  const f = fixture(t);
  fs.mkdirSync(f.file);
  assert.equal(f.store.claim(ID).ok, false);
  assert.deepEqual(fs.readdirSync(f.file), []);
  if (process.platform === "win32") return;
  const other = fixture(t);
  fs.symlinkSync(path.join(other.root, "nonexistent"), other.file);
  assert.equal(other.store.claim(ID).ok, false);
  assert.equal(fs.lstatSync(other.file).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(other.root, "nonexistent")), false);
});

test("result whitelist strips secret extras and read/snapshot expose no identity or lease", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  reserveBoth(f.store, claimId);
  const report = { ...result(), args: "SECRET", text: "SECRET", model: "SECRET", key: "SECRET", error: "SECRET",
    usage: { ...USAGE, raw: "SECRET", reasoning: "SECRET" } };
  assert.equal(f.store.finish(ID, claimId, report), true);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /SECRET|"args"|"model"|"key"|"error"|"raw"/);
  const read = f.store.read(ID);
  assert.doesNotMatch(JSON.stringify(read), new RegExp(`${ID}|${claimId}|claimId|identity`));
  read.usage.promptTokens = 999;
  assert.equal(f.reload().read(ID).usage.promptTokens, 21);
  assert.doesNotMatch(JSON.stringify(f.store.snapshot()), new RegExp(`${ID}|${claimId}|claimId|identity|proof.json`));
});

test("unreported usage stays unknown; real reported zeroes and partial usage retain reporting flags", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  reserveBoth(f.store, claimId);
  const partial = { promptTokens: 0, totalTokens: 0, transportAttempts: 2 };
  assert.equal(f.store.finish(ID, claimId, result("verified", "", partial)), true);
  const usage = f.reload().read(ID).usage;
  assert.equal(usage.usageReported, true);
  assert.equal(usage.promptTokens, 0);
  assert.equal(usage.completionTokens, null);
  assert.equal(usage.cachedTokens, null);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.cacheReported, false);
  assert.equal(usage.reasoningReported, false);
  const second = f.store.claim(OTHER);
  const unreported = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0,
    totalTokens: 0, usageReported: false, cacheReported: false, reasoningReported: false };
  assert.equal(f.store.finish(OTHER, second.claimId, { status: "unsupported", reason: "protocol_not_supported",
    usage: unreported, durationMs: 0 }), true);
  const unknown = f.reload().read(OTHER).usage;
  for (const key of ["promptTokens", "cachedTokens", "completionTokens", "reasoningTokens", "totalTokens", "transportAttempts"]) {
    assert.equal(unknown[key], null);
  }
});

test("unknown reasons, invalid reporting flags, excessive metrics and unreserved usage cannot finish", t => {
  const f = fixture(t);
  const { claimId } = f.store.claim(ID);
  reserveBoth(f.store, claimId);
  const bad = [
    result("verified", "secret-key"), result("failed", "secret-key"), result("unknown", "cancelled"),
    { ...result(), durationMs: -1 }, { ...result(), durationMs: DAY + 1 }, { ...result(), durationMs: Infinity },
    result("verified", "", { ...USAGE, promptTokens: -1 }), result("verified", "", { ...USAGE, promptTokens: 1.5 }),
    result("verified", "", { ...USAGE, totalTokens: 1_000_000_001 }),
    result("verified", "", { ...USAGE, transportAttempts: 3 }),
    result("verified", "", { ...USAGE, reasoningReported: "SECRET" }),
    result("verified", "", { usageReported: true }), result("verified", "", null),
  ];
  const original = fs.readFileSync(f.file);
  for (const report of bad) assert.equal(f.store.finish(ID, claimId, report), false);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(f.store.read(ID).status, "pending");
});

test("tampered terminal usage, proof stages, reasons and secret fields fail strict reload", async t => {
  const mutations = [
    value => { value.records[0].result.usage.raw = "SECRET"; },
    value => { value.records[0].result.reason = "SECRET"; },
    value => { value.records[0].result.usage.cacheReported = false; },
    value => { value.records[0].result.usage.transportAttempts = 3; },
    value => { value.records[0].attempts = [0]; },
    value => { value.records[0].verifiedUntil = START; },
    value => { value.records[0].finishedAt = START + DAY; value.updatedAt = START + DAY; },
    value => { value.records[0].result.durationMs = "SECRET"; },
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(`terminal ${index}`, sub => {
    const f = fixture(sub);
    const { claimId } = f.store.claim(ID);
    reserveBoth(f.store, claimId);
    assert.equal(f.store.finish(ID, claimId, result()), true);
    const value = disk(f.file);
    mutate(value); write(f.file, value);
    const original = fs.readFileSync(f.file);
    noAuthorization(f.reload(), claimId);
    assert.deepEqual(fs.readFileSync(f.file), original);
  });
});

test("exactly 64KiB is accepted and invalid factory/identity/claim inputs never touch files", t => {
  const f = fixture(t);
  const valid = JSON.stringify({ version: 1, updatedAt: 0, records: [] });
  fs.writeFileSync(f.file, valid + " ".repeat(64 * 1024 - valid.length));
  assert.equal(f.store.snapshot().ok, true);
  for (const identity of [null, undefined, ID.toUpperCase(), ID.slice(1), ID + "0", {}, 42]) {
    assert.equal(f.store.claim(identity).ok, false);
    assert.equal(f.store.read(identity).status, "unknown");
    assert.equal(f.store.reserveAttempt(identity, "wrong", 0), false);
  }
  assert.equal(fs.statSync(f.file).size, 64 * 1024);
  for (const options of [undefined, {}, { file: "" }, { file: f.file, ttlMs: 0 }, { file: f.file, ttlMs: -1 },
    { file: f.file, ttlMs: 1.5 }, { file: f.file, now: null }]) {
    assert.throws(() => createToolCompatibilityStore(options), TypeError);
  }
});
