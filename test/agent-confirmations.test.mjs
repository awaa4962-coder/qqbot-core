import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import { readJsonFile, writeJsonFileSync } from "../bridge/persistence/json-file.mjs";
import { createConfirmationStore } from "../bridge/chat-tools/confirmations.mjs";

const TEMP = process.platform === "win32" ? "F:/CodexArtifacts/qqfriend/20261001/temp" : os.tmpdir();
const START = 1_790_841_600_000;
const TTL = 300000;
const SOURCE = "a".repeat(64);
const SCOPE = Object.freeze({ surface: "group", groupId: "710001", userId: "810001" });
const BINDING = Object.freeze({ privacyRevision: 1, userRevision: "user-1", sourceIdentity: SOURCE });
const MODULE = new URL("../bridge/chat-tools/confirmations.mjs", import.meta.url).href;
const clone = value => JSON.parse(JSON.stringify(value));
const disk = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
const put = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value));

function operation(action = "set_name", parameters = { value: "Alice" }, domain = "personal") {
  return { domain, action, parameters, baseline: { revision: "revision-1", sourceIdentity: SOURCE }, preview: "Synthetic reviewed change" };
}
function fixture(t, overrides = {}) {
  fs.mkdirSync(TEMP, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEMP, "a3-confirmations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "confirmations.json");
  let at = START;
  const options = { filename, now: () => at, ...overrides };
  const reload = settings => createConfirmationStore({ ...options, ...settings });
  return { root, filename, store: reload(), reload, setTime: value => { at = value; } };
}
function create(f, op = operation(), messageId = "0", scope = SCOPE, binding = BINDING) {
  return f.store.create(scope, op, { messageId, binding });
}
function execute(store, ref, apply = () => ({ status: "applied" }), settings = {}, scope = SCOPE) {
  return store.execute(scope, ref, { binding: BINDING, assertCurrent: () => {}, apply, ...settings });
}
function cold(code, filename) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import process from 'node:process';
    import { createConfirmationStore } from ${JSON.stringify(MODULE)};
    const filename = ${JSON.stringify(filename)};
    const scope = ${JSON.stringify(SCOPE)};
    const binding = ${JSON.stringify(BINDING)};
    const op = ${JSON.stringify(operation())};
    const store = createConfirmationStore({ filename, now: () => ${START} });
    ${code}
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("cross-factory rollback cannot restore a receipt erased by another factory", async t => {
  const f = fixture(t), ref = create(f).ref;
  assert.equal((await execute(f.store, ref, () => ({ status: "applied", text: "Synthetic erased receipt" }))).status, "applied");
  const beforeForget = disk(f.filename);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  const eraser = f.reload();
  assert.equal(eraser.list().status, "ready");
  assert.equal(disk(f.filename).rows[0].text, "");
  put(f.filename, beforeForget);
  let calls = 0;
  for (const store of [eraser, f.store, f.reload()]) {
    const result = await execute(store, ref, () => { calls++; return { status: "applied" }; });
    assert.equal(result.status, "unknown");
    assert.equal(result.text, undefined);
  }
  assert.equal(calls, 0);
});

test("a draft acknowledges exact persisted immutable parameters and opaque ref, without applying", async t => {
  const f = fixture(t);
  const op = operation();
  const binding = clone(BINDING);
  const scope = clone(SCOPE);
  const prepared = f.store.create(scope, op, { messageId: 0, binding });
  assert.deepEqual(Object.keys(prepared).sort(), ["expiresAt", "preview", "ref", "status"]);
  assert.equal(prepared.status, "pending");
  assert.match(prepared.ref, /^cf_[a-f0-9]{32}$/);
  assert.equal(prepared.expiresAt, START + TTL);
  assert.deepEqual(disk(f.filename).rows[0].operation, op);
  assert.deepEqual(disk(f.filename).rows[0].binding, binding);
  assert.equal(disk(f.filename).rows[0].messageId, "0");
  op.parameters.value = "Changed"; binding.userRevision = "user-2"; scope.userId = "810002";
  let calls = 0;
  const result = await execute(f.store, prepared.ref, function(saved) {
    assert.equal(this, undefined);
    calls++;
    assert.equal(disk(f.filename).rows[0].status, "executing");
    assert.equal(saved.parameters.value, "Alice");
    assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.parameters) && Object.isFrozen(saved.baseline));
    assert.throws(() => { saved.parameters.value = "Changed"; }, TypeError);
    return { status: "applied", text: "ignored receipt body" };
  });
  assert.equal(result.status, "applied");
  assert.equal(calls, 1);
  assert.equal(disk(f.filename).rows[0].operation, null);
  assert.equal(disk(f.filename).rows[0].binding, null);
  assert.equal(JSON.stringify(result).includes("Alice"), false);
});

test("all and only the seven fixed prepared action parameter shapes are admitted", t => {
  const shapes = [operation(), operation("set_style", { value: "Brief" }),
    operation("memory_create", { title: "Project", text: "Current user excerpt", ttlDays: 7 }),
    operation("memory_update", { noteId: "abcdef123456", text: "Reviewed own note" }),
    operation("memory_remove", { noteId: "abcdef123456" }),
    operation("create", { text: "Reminder", dueAt: new Date(START + 60000).toISOString() }, "reminder"),
    operation("cancel", { ref: "rem_0123456789abcdef0123456789abcdef" }, "reminder")];
  for (const op of shapes) {
    const f = fixture(t);
    assert.equal(create(f, op).status, "pending", op.action);
  }
  const invalidOps = [
    { ...operation(), domain: "constructor" }, { ...operation(), domain: "preferences" },
    { ...operation(), action: "execute" }, operation("create", { text: "X", dueAt: START }, "personal"),
    operation("set_name", { value: "Alice", userId: SCOPE.userId }), operation("set_name", { value: {} }),
    operation("set_name", { value: "x".repeat(17) }), operation("set_style", { value: "x".repeat(301) }),
    operation("memory_create", { title: "X", text: "Y", ttlDays: "7" }),
    operation("memory_create", { title: "X", text: "Y", ttlDays: 0 }),
    operation("memory_create", { title: "X", text: "Y", ttlDays: 91 }),
    operation("memory_create", { title: "X", text: "Y", ttlDays: 1.1 }),
    operation("memory_create", { title: "x".repeat(33), text: "Y" }),
    operation("memory_create", { title: "X", text: "x".repeat(301) }),
    operation("memory_update", { noteId: "other", text: "Y" }),
    operation("memory_update", { noteId: "abcdef123456", text: "Y", title: "X" }),
    operation("memory_remove", { noteId: "abcdef123456", text: "Y" }),
    operation("create", { text: "X", dueAt: "2026-10-01T12:00:00Z" }, "reminder"),
    operation("create", { text: "X", dueAt: "2026-02-30T12:00:00.000Z" }, "reminder"),
    operation("create", { text: "X", dueAt: "2026-10-01T12:00:00.000+08:00" }, "reminder"),
    operation("create", { text: "X", dueAt: START + 60000 }, "reminder"),
    operation("create", { text: "X", dueAt: -1 }, "reminder"),
    operation("create", { text: "X", dueAt: START, provider: "arbitrary" }, "reminder"),
    operation("cancel", { ref: "../../jobs" }, "reminder"),
    operation("cancel", { ref: "rm_0123456789abcdef0123456789abcdef" }, "reminder"),
    operation("cancel", { ref: "arbitrary_scheduler_job" }, "reminder"),
    { ...operation(), baseline: { revision: 1, sourceIdentity: "/tmp/private" } },
    { ...operation(), baseline: { revision: "x".repeat(129), sourceIdentity: SOURCE } },
    { ...operation(), baseline: { revision: 1, sourceIdentity: SOURCE, path: "/tmp/private" } },
    { ...operation(), path: "/tmp/private" }, { ...operation(), preview: "x".repeat(1201) },
    { ...operation(), preview: "api_key=synthetic-secret" },
    { ...operation(), preview: "[CQ:at,qq=123]" }, { ...operation(), preview: "<think>private</think>" },
    { ...operation(), preview: "C:\\Users\\private" }, { ...operation(), preview: "unsafe\u202econtrol" },
    { ...operation(), preview: "unsafe\ud800surrogate" }, operation("set_name", { value: "" }),
    operation("memory_create", { title: "X", text: "token=synthetic-value" }),
  ];
  const f = fixture(t);
  for (const op of invalidOps) assert.equal(create(f, op).status, "invalid_arguments", JSON.stringify(op));
  assert.equal(fs.existsSync(f.filename), false);
});

test("plain LF previews are allowed without weakening payload controls or the preview budget", t => {
  const f = fixture(t);
  const previews = ["\u7b2c\u4e00\u884c\n\u7b2c\u4e8c\u884c", "\nReviewed change\n", "Line one\n\nLine two"];
  for (const [index, preview] of previews.entries()) {
    const result = create(f, { ...operation(), preview }, String(index));
    assert.equal(result.status, "pending");
    assert.equal(result.preview, preview);
  }
  for (const preview of ["Line one\r\nLine two", "Line one\tLine two", "Line one\n[CQ:at,qq=123]",
    "Line one\napi_key=synthetic-private", "Line one\n<reasoning>private</reasoning>", "Line one\nunsafe\u202econtrol",
    "\n", "x".repeat(1200) + "\n"]) {
    assert.equal(create(f, { ...operation(), preview }, "3").status, "invalid_arguments");
  }
  for (const text of ["Literal\nbody", "Literal\r\nbody"]) {
    assert.equal(create(f, operation("memory_create", { title: "Current message", text }), "3").status, "invalid_arguments");
  }
});

test("actual isolated A and C preparation fixtures produce DTOs accepted by the confirmation store", t => {
  const f = fixture(t);
  const personalModule = new URL("../bridge/chat-tools/personal-changes.mjs", import.meta.url).href;
  const notesModule = new URL("../bridge/memory-profile/notes.mjs", import.meta.url).href;
  const reminderModule = new URL("../bridge/agent-reminders/service.mjs", import.meta.url).href;
  const prepared = cold(`
    const root = filename + '.isolated'; fs.mkdirSync(root, {recursive:true});
    process.env.NODE_ENV = 'test'; process.env.QQBOT_CONFIG_ROOT = root + '/config';
    process.env.QQBOT_DATA_DIR = root + '/defaults'; process.env.QQBOT_LOG_DIR = root + '/logs';
    process.env.QQBOT_TEMP_DIR = root + '/temp'; process.env.QQBOT_MEMORY_PROFILE_FILE = root + '/default-profiles.json';
    const {createPersonalChangeAdapter} = await import(${JSON.stringify(personalModule)});
    const {createMemoryNoteService} = await import(${JSON.stringify(notesModule)});
    const {createReminderService} = await import(${JSON.stringify(reminderModule)});
    const privacy = {epoch:0,users:{}};
    const forbidden = () => {throw new Error('Preparation must not write or send');};
    const notes = createMemoryNoteService({profiles:{},now:()=>${START},readPrivacy:()=>privacy,
      available:()=>true,invalidate:forbidden,persist:forbidden});
    const adapter = createPersonalChangeAdapter({users:{},readPrivacy:()=>privacy,
      saveUsers:forbidden,flushSavesSync:forbidden,setUserDisplayName:forbidden,setUserStylePreference:forbidden,
      memoryNotesSnapshot:own=>notes.snapshot(own),applyMemoryNoteAction:forbidden});
    const runtime = {scope,cfg:{memoryFile:root+'/users.json',memoryProfileFile:root+'/profiles.json',
      dataRoot:root,agentWriteGroupWhitelist:[scope.groupId]},messageId:'0',signal:new AbortController().signal,
      assertCurrent(){},isPermitted:()=>true};
    const requests = [
      [{action:'set_name',value:'\u963f\u660e'},'\u53eb\u6211\u963f\u660e'],
      [{action:'set_style',value:'\u7b80\u77ed \u6280\u672f'},'\u56de\u590d\u98ce\u683c \u7b80\u77ed \u6280\u672f'],
      [{action:'memory_create',title:'\u996e\u54c1',text:'\u6211\u559c\u6b22 \u7eff\u8336',ttlDays:2},'\u8bb0\u4f4f\u6211\u559c\u6b22 \u7eff\u8336']
    ];
    const operations = requests.map(([args,userMessage]) => adapter.prepare(args,{...runtime,userMessage}));
    const reminders = createReminderService({filename:root+'/reminders.json',now:()=>${START},
      isPermitted:()=>true,readPrivacyCutoff:()=>0,deliver:forbidden});
    operations.push(reminders.prepare(scope,{action:'create',text:'Synthetic reminder',delay_minutes:5}));
    operations.push(reminders.prepare(scope,{action:'cancel',ref:'rem_0123456789abcdef0123456789abcdef'}));
    process.stdout.write(JSON.stringify(operations));
  `, f.filename);
  for (const result of prepared) {
    assert.equal(result.status, "ready", JSON.stringify(result));
    const isolated = fixture(t);
    assert.equal(create(isolated, result.operation).status, "pending", result.operation.action);
  }
  assert.equal(prepared[0].operation.preview.includes("\n"), false);
  assert.equal(prepared[2].operation.parameters.text, "\u6211\u559c\u6b22 \u7eff\u8336");
  assert.equal(prepared[4].operation.parameters.ref, "rem_0123456789abcdef0123456789abcdef");
  assert.equal(fs.existsSync(f.filename), false);
});

test("quote expansion is counted in the serialized operation budget and oversized input is denied", t => {
  const f = fixture(t);
  const op = operation("memory_create", { title: "x".repeat(32), text: "x".repeat(300) });
  op.preview = "\"".repeat(1200);
  op.parameters.text = "\"".repeat(300);
  assert.ok(JSON.stringify(op).length <= 4096);
  assert.equal(create(f, op).status, "pending");
  assert.deepEqual(disk(f.filename).rows[0].operation, op);
  const tooLarge = clone(op);
  tooLarge.preview = "x".repeat(4097);
  assert.equal(create(f, tooLarge, "1").status, "invalid_arguments");
  assert.equal(disk(f.filename).rows.length, 1);
});

test("canonical signed message IDs include zero; invalid forms and non-group scopes never persist", t => {
  const good = [0, "0", -17, "-17", "12345678901234567890"];
  for (const id of good) { const f = fixture(t); assert.equal(create(f, operation(), id).status, "pending"); }
  const f = fixture(t);
  for (const id of [undefined, null, "", "00", "01", "-0", -0, "+1", " 1", "1.0", "1e3", 1.2,
    Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 1n, "123456789012345678901", {}]) {
    assert.equal(f.store.create(SCOPE, operation(), { messageId: id, binding: BINDING }).status, "invalid_arguments", String(id));
  }
  for (const scope of [{ ...SCOPE, surface: "private" }, { ...SCOPE, groupId: "private" },
    { ...SCOPE, userId: "0810001" }, { ...SCOPE, groupId: 0 }, { ...SCOPE, path: "x" },
    Object.create(SCOPE)]) {
    assert.equal(create(f, operation(), "0", scope).status, "invalid_arguments");
  }
  assert.equal(fs.existsSync(f.filename), false);
});

test("descriptor-only input rejects getters, proxies, hidden keys, cycles, symbols and toJSON without invocation", async t => {
  const f = fixture(t);
  let traps = 0;
  const getter = (value, key) => Object.defineProperty(value, key, { enumerable: true, get() { traps++; throw new Error("No getter"); } });
  const op = operation();
  const cycle = operation(); cycle.parameters.value = cycle;
  const bad = [getter(operation(), "preview"), { ...operation(), parameters: getter({}, "value") },
    { ...operation(), baseline: getter({ sourceIdentity: SOURCE }, "revision") },
    { ...operation(), [Symbol("hidden")]: 1 }, cycle,
    Object.defineProperty(operation(), "hidden", { value: "X" }),
    { ...operation(), toJSON() { traps++; return op; } },
    new Proxy(operation(), { get() { traps++; throw new Error("No proxy"); }, ownKeys() { traps++; return []; } })];
  for (const value of bad) assert.equal(create(f, value).status, "invalid_arguments");
  assert.equal(f.store.create(getter({ ...SCOPE }, "userId"), op, { messageId: 0, binding: BINDING }).status, "invalid_arguments");
  assert.equal(f.store.create(SCOPE, op, getter({ binding: BINDING }, "messageId")).status, "invalid_arguments");
  assert.equal(f.store.create(SCOPE, op, { messageId: 0, binding: getter({ ...BINDING }, "userRevision") }).status, "invalid_arguments");
  const ref = create(f).ref;
  assert.equal((await f.store.execute(SCOPE, ref, getter({ binding: BINDING, apply() { traps++; } }, "assertCurrent"))).status, "denied");
  assert.equal((await execute(f.store, ref, () => { traps++; }, { binding: getter({ ...BINDING }, "privacyRevision") })).status, "denied");
  assert.equal(traps, 0);
  assert.equal(f.store.inspect(SCOPE, ref).item.phase, "pending");
});

test("sorted JSON normalization deduplicates scope/message/operation; binding drift invalidates instead of rebinding", t => {
  const f = fixture(t);
  const first = create(f, operation(), 17);
  const reordered = { preview: "Synthetic reviewed change", baseline: { sourceIdentity: SOURCE, revision: "revision-1" },
    parameters: { value: "Alice" }, action: "set_name", domain: "personal" };
  const second = f.store.create({ userId: 810001, groupId: 710001, surface: "group" }, reordered,
    { binding: { userRevision: "user-1", sourceIdentity: SOURCE, privacyRevision: 1 }, messageId: "17" });
  assert.deepEqual(second, first);
  assert.equal(disk(f.filename).rows.length, 1);
  const drift = create(f, reordered, 17, SCOPE, { ...BINDING, privacyRevision: 2 });
  assert.equal(drift.status, "invalidated");
  assert.equal(drift.ref, first.ref);
  assert.equal(create(f, reordered, 17).status, "invalidated");
  assert.equal(disk(f.filename).rows[0].operation, null);
});

test("owner and group are bound; other callers cannot inspect, revoke or consume a known ref", async t => {
  const f = fixture(t);
  const ref = create(f).ref;
  let calls = 0;
  for (const scope of [{ ...SCOPE, userId: "810002" }, { ...SCOPE, groupId: "710002" }]) {
    assert.equal(f.store.inspect(scope, ref).status, "denied");
    assert.deepEqual(f.store.list(scope), { status: "ready", items: [] });
    assert.equal(f.store.revoke(scope, ref).status, "not_found");
    assert.equal((await execute(f.store, ref, () => { calls++; return { status: "applied" }; }, {}, scope)).status, "denied");
  }
  assert.equal(calls, 0);
  assert.equal((await execute(f.store, ref)).status, "applied");
});

test("binding mismatch consumes as invalidated, and unsafe binding types default deny", async t => {
  for (const change of [{ privacyRevision: 2 }, { userRevision: "user-2" }, { sourceIdentity: "b".repeat(64) }]) {
    const f = fixture(t);
    const ref = create(f).ref;
    let calls = 0;
    assert.equal((await execute(f.store, ref, () => { calls++; }, { binding: { ...BINDING, ...change } })).status, "denied");
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "denied");
    assert.equal(f.store.inspect(SCOPE, ref).item.phase, "invalidated");
    assert.equal(calls, 0);
  }
  const f = fixture(t);
  for (const binding of [{ ...BINDING, sourceIdentity: "raw/path" }, { ...BINDING, userRevision: {} },
    { ...BINDING, privacyRevision: -1 }, { ...BINDING, userRevision: true }, { ...BINDING, extra: 1 }]) {
    assert.equal(create(f, operation(), "0", SCOPE, binding).status, "invalid_arguments");
  }
});

test("expiry has an exact five-minute boundary and cannot be extended by duplicate creation", async t => {
  const f = fixture(t);
  const draft = create(f);
  f.setTime(START + TTL - 1);
  assert.deepEqual(create(f), draft);
  f.setTime(START + TTL);
  let calls = 0;
  assert.equal((await execute(f.store, draft.ref, () => { calls++; })).status, "expired");
  assert.equal(create(f).status, "expired");
  assert.equal(calls, 0);
  assert.equal(disk(f.filename).rows[0].operation, null);
});

test("guards are mandatory and synchronous, checked before and after the durable claim", async t => {
  for (const guard of [() => false, () => { throw new Error("private failure"); }, async () => true, () => ({ then() {} })]) {
    const f = fixture(t); const ref = create(f).ref;
    let calls = 0;
    assert.equal((await execute(f.store, ref, () => { calls++; }, { assertCurrent: guard })).status, "denied");
    assert.equal(calls, 0);
    assert.equal(f.store.inspect(SCOPE, ref).item.phase, "pending");
  }
  const f = fixture(t); const ref = create(f).ref;
  let guards = 0, calls = 0;
  const result = await execute(f.store, ref, () => { calls++; }, { assertCurrent() {
    if (++guards === 2) { assert.equal(disk(f.filename).rows[0].status, "executing"); throw new Error("revoked context"); }
  } });
  assert.equal(result.status, "not_applied"); assert.equal(calls, 0); assert.equal(guards, 2);
  assert.equal((await execute(f.store, ref, () => { calls++; })).status, "not_applied");
  assert.equal((await f.store.execute(SCOPE, ref, { binding: BINDING, apply() {} })).status, "denied");
});

test("a guard that crosses expiry after claiming cannot apply", async t => {
  const f = fixture(t); const ref = create(f).ref;
  let guards = 0, calls = 0;
  const result = await execute(f.store, ref, () => { calls++; }, { assertCurrent() {
    if (++guards === 2) f.setTime(START + TTL);
  } });
  assert.equal(result.status, "not_applied"); assert.equal(calls, 0);
});

test("concurrent duplicates across factories and reentrant requests invoke exactly one apply", async t => {
  const f = fixture(t); const ref = create(f).ref;
  const other = f.reload();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = execute(f.store, ref, async saved => {
    calls++; started();
    assert.equal(saved.parameters.value, "Alice");
    assert.equal(f.store.revoke(SCOPE, ref).status, "executing");
    assert.equal((await execute(other, ref, () => { calls++; })).status, "unknown");
    await wait;
    return { status: "applied" };
  });
  await entered;
  const duplicates = await Promise.all(Array.from({ length: 10 }, () => execute(other, ref, () => { calls++; })));
  assert.ok(duplicates.every(result => result.status === "unknown" && result.ref === ref));
  release(); assert.equal((await first).status, "applied");
  assert.equal((await execute(other, ref, () => { calls++; })).status, "applied");
  assert.equal(create(f).status, "applied");
  assert.equal(calls, 1);
});

test("each terminal apply outcome is retained and no exception or ambiguous result can auto retry", async t => {
  for (const status of ["applied", "not_applied", "unknown"]) {
    const f = fixture(t); const ref = create(f).ref;
    let calls = 0;
    const apply = () => { calls++; return { status }; };
    assert.equal((await execute(f.store, ref, apply)).status, status);
    assert.equal((await execute(f.reload(), ref, apply)).status, status);
    assert.equal(calls, 1);
  }
  for (const apply of [() => { throw new Error("SECRET path /tmp/private"); }, () => null,
    () => ({ status: "ok" }), () => ({ get status() { throw new Error("Getter"); } })]) {
    const f = fixture(t); const ref = create(f).ref;
    let retries = 0;
    const result = await execute(f.store, ref, apply);
    assert.equal(result.status, "unknown");
    assert.equal((await execute(f.store, ref, () => { retries++; })).status, "unknown");
    assert.equal(retries, 0);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
});

test("revocation is own-scope only; revokeUser scrubs all pending drafts for that user and preserves replay history", async t => {
  const f = fixture(t);
  const first = create(f, operation(), "1");
  const second = create(f, operation(), "2", { ...SCOPE, groupId: "710002" });
  const third = create(f, operation(), "3", { ...SCOPE, userId: "810002" });
  assert.equal(f.store.revoke(SCOPE, first.ref).status, "revoked");
  assert.equal(f.store.revoke(SCOPE, first.ref).status, "revoked");
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: true }), true);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: true }), true);
  assert.equal(f.store.inspect({ ...SCOPE, groupId: "710002" }, second.ref).item.phase, "revoked");
  assert.equal(f.store.inspect({ ...SCOPE, userId: "810002" }, third.ref).item.phase, "pending");
  assert.equal((await execute(f.store, first.ref)).status, "denied");
  const rows = disk(f.filename).rows;
  assert.equal(rows[0].operation, null); assert.equal(rows[1].binding, null);
  assert.equal(rows.length, 3);
});

test("revokeUser persist false is synchronous, defers disk writes, and blocks subsequent claims across instances", async t => {
  let writes = 0;
  const f = fixture(t, { write(filename, state, options) { writes++; writeJsonFileSync(filename, state, options); } });
  const ref = create(f).ref;
  const saved = fs.readFileSync(f.filename, "utf8");
  const result = f.store.revokeUser(SCOPE.userId, { persist: false });
  assert.equal(result, true);
  assert.equal(writes, 1);
  assert.equal(fs.readFileSync(f.filename, "utf8"), saved);
  let calls = 0;
  assert.deepEqual(await execute(f.reload(), ref, () => { calls++; }), { status: "denied", ref });
  assert.equal(disk(f.filename).rows[0].status, "revoked");
  assert.equal(disk(f.filename).rows[0].operation, null);
  assert.equal(calls, 0);
  assert.equal(f.store.revokeUser("bad", { persist: true }), false);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: "yes" }), false);
  let getters = 0;
  assert.equal(f.store.revokeUser(SCOPE.userId, { get persist() { getters++; return true; } }), false);
  assert.equal(getters, 0);
});

test("same-process factories cannot recreate a missing ledger or lose pending/unknown history", async t => {
  for (const phase of ["pending", "unknown"]) {
    const f = fixture(t);
    const earlierFactory = f.reload();
    const ref = create(f).ref;
    if (phase === "unknown") assert.equal((await execute(f.store, ref, () => ({ status: "unknown" }))).status, "unknown");
    fs.unlinkSync(f.filename);
    const laterFactory = f.reload();
    for (const store of [earlierFactory, laterFactory]) {
      assert.equal(store.create(SCOPE, operation(), { messageId: "1", binding: BINDING }).status, "unavailable");
      assert.equal(fs.existsSync(f.filename), false);
      assert.deepEqual(store.list(), { status: "unavailable", items: [] });
      let calls = 0;
      assert.deepEqual(await execute(store, ref, () => { calls++; return { status: "applied" }; }), { status: "unknown", ref });
      assert.equal(calls, 0);
    }
  }
});

test("file observation is shared even for an empty ledger, but unseen first boot stays available", t => {
  const seen = fixture(t);
  const earlyFactory = seen.reload();
  put(seen.filename, { version: 1, sequence: 0, updatedAt: START, rows: [] });
  assert.deepEqual(seen.store.list(), { status: "ready", items: [] });
  fs.unlinkSync(seen.filename);
  for (const store of [earlyFactory, seen.reload()]) {
    assert.equal(store.create(SCOPE, operation(), { messageId: "0", binding: BINDING }).status, "unavailable");
    assert.equal(fs.existsSync(seen.filename), false);
  }
  const fresh = fixture(t);
  assert.deepEqual(fresh.store.list(), { status: "ready", items: [] });
  assert.equal(fs.existsSync(fresh.filename), false);
  assert.equal(fresh.reload().create(SCOPE, operation(), { messageId: "0", binding: BINDING }).status, "pending");
});

test("nonpersisting forget defers every expired-row recovery until the next normal access", t => {
  let writes = 0;
  const f = fixture(t, { write(filename, state, options) { writes++; writeJsonFileSync(filename, state, options); } });
  const own = create(f).ref;
  const other = create(f, operation(), "1", { ...SCOPE, userId: "810002" }).ref;
  const saved = fs.readFileSync(f.filename, "utf8");
  const beforeWrites = writes;
  f.setTime(START + TTL);
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  assert.equal(writes, beforeWrites);
  assert.equal(fs.readFileSync(f.filename, "utf8"), saved);
  assert.ok(disk(f.filename).rows.every(row => row.status === "pending"));
  const view = f.reload().list();
  assert.equal(view.status, "ready");
  assert.equal(view.items.find(item => item.ref === own).phase, "revoked");
  assert.equal(view.items.find(item => item.ref === other).phase, "expired");
  assert.equal(writes, beforeWrites + 1);
  assert.ok(disk(f.filename).rows.every(row => row.operation === null && row.binding === null));
});

test("nonpersisting forget defers old-process executing recovery without making it replayable", async t => {
  let writes = 0;
  const f = fixture(t, { write(filename, state, options) { writes++; writeJsonFileSync(filename, state, options); } });
  const interrupted = cold(`const draft = store.create(scope, op, {messageId:'0', binding});
    await store.execute(scope, draft.ref, {binding, assertCurrent() {}, apply() {
      process.stdout.write(JSON.stringify(draft)); process.exit(0);
    }});`, f.filename);
  const saved = fs.readFileSync(f.filename, "utf8");
  assert.equal(disk(f.filename).rows[0].status, "executing");
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: false }), true);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(f.filename, "utf8"), saved);
  let calls = 0;
  assert.deepEqual(await execute(f.reload(), interrupted.ref, () => { calls++; return { status: "applied" }; }),
    { status: "unknown", ref: interrupted.ref });
  assert.equal(calls, 0);
  assert.equal(writes, 1);
  assert.equal(disk(f.filename).rows[0].status, "unknown");
  assert.equal(disk(f.filename).rows[0].operation, null);
});

test("forget during actual apply retains an unknown receipt rather than claiming cancellation or false success", async t => {
  const f = fixture(t); const ref = create(f).ref;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const running = execute(f.store, ref, async () => { calls++; await wait; return { status: "applied", text: "Change applied." }; });
  assert.equal(f.store.inspect(SCOPE, ref).item.phase, "executing");
  assert.equal(f.store.revokeUser(SCOPE.userId, { persist: true }), true);
  assert.equal(disk(f.filename).rows[0].status, "unknown");
  assert.equal(disk(f.filename).rows[0].operation, null);
  release();
  assert.deepEqual(await running, { status: "unknown", ref });
  assert.deepEqual(await execute(f.store, ref, () => { calls++; }), { status: "unknown", ref });
  assert.equal(calls, 1);
});

test("frozen execution DTO preserves only safe adapter status/text and the confirmation ref", async t => {
  for (const status of ["applied", "not_applied", "unknown"]) {
    const f = fixture(t); const ref = create(f).ref;
    const result = await execute(f.store, ref, () => ({ status, text: "Safe adapter acknowledgement.",
      ref: "rem_0123456789abcdef0123456789abcdef", parameters: { value: "private" }, reason: "raw internal error" }));
    assert.deepEqual(result, { status, ref, text: "Safe adapter acknowledgement." });
    assert.deepEqual(await execute(f.reload(), ref), result);
    const global = f.store.list();
    assert.equal(JSON.stringify(global).includes("acknowledgement"), false);
    assert.equal(Object.hasOwn(global.items[0], "scope"), false);
    assert.equal(Object.hasOwn(global.items[0], "parameters"), false);
  }
  for (const text of ["api_key=synthetic-private-value", "C:\\Users\\private", "unsafe\u202econtrol"]) {
    const f = fixture(t); const ref = create(f).ref;
    assert.deepEqual(await execute(f.store, ref, () => ({ status: "applied", text })), { status: "applied", ref });
  }
  const f = fixture(t); const ref = create(f).ref;
  assert.deepEqual(await execute(f.store, ref, () => ({ status: "applied", text: `Updated user ${SCOPE.userId}.` })),
    { status: "applied", ref, text: "Updated user [ID hidden]." });
  assert.deepEqual(f.store.inspect(SCOPE, "bad"), { status: "denied" });
  assert.deepEqual(f.store.list({ ...SCOPE, surface: "private" }), { status: "unavailable", items: [] });
});

test("owner quota is four pending and safety history is included in the hard 128-row bound", t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) assert.equal(create(f, operation(), String(i)).status, "pending");
  assert.equal(create(f, operation(), "4").status, "capacity");
  assert.equal(create(f).status, "pending");
  assert.equal(f.store.revoke(SCOPE, f.store.list(SCOPE).items[0].ref).status, "revoked");
  assert.equal(create(f, operation(), "4").status, "pending");
  const bounded = fixture(t);
  for (let i = 0; i < 128; i++) {
    const scope = { ...SCOPE, userId: String(820000 + i) };
    const draft = create(bounded, operation(), "0", scope);
    assert.equal(draft.status, "pending");
    assert.equal(bounded.store.revoke(scope, draft.ref).status, "revoked");
  }
  bounded.setTime(START + TTL + 1);
  assert.equal(create(bounded).status, "capacity");
  assert.equal(disk(bounded.filename).rows.length, 128);
});

test("global projections are metadata only; owner projections have only safe pending preview", t => {
  const f = fixture(t); const draft = create(f);
  const inspected = f.store.inspect(SCOPE, draft.ref);
  assert.equal(inspected.status, "ready");
  const own = inspected.item;
  assert.equal(own.preview, draft.preview);
  assert.equal(f.store.list(SCOPE).items[0].preview, draft.preview);
  const global = f.store.list();
  assert.equal(global.status, "ready");
  assert.equal(Object.hasOwn(global.items[0], "preview"), false);
  assert.deepEqual(Object.keys(global.items[0]).sort(), ["action", "createdAt", "expiresAt", "phase", "ref"]);
  for (const projection of [draft, own, global, f.store.list(SCOPE)]) {
    const text = JSON.stringify(projection);
    for (const hidden of ["Alice", SCOPE.userId, SCOPE.groupId, SOURCE, "operationHash", "ownerKey", "binding", "parameters", "messageId"]) {
      assert.equal(text.includes(hidden), false, hidden);
    }
  }
  own.preview = "Changed projection";
  assert.equal(f.store.inspect(SCOPE, draft.ref).item.preview, draft.preview);
  const identified = operation(); identified.preview = `Reviewed user ${SCOPE.userId} in group ${SCOPE.groupId}`;
  const redacted = create(f, identified, "1");
  assert.equal(redacted.preview, "Reviewed user [ID hidden] in group [ID hidden]");
  assert.equal(f.store.inspect(SCOPE, redacted.ref).item.preview, redacted.preview);
  assert.equal(disk(f.filename).rows[1].operation.preview, identified.preview);
});

test("independent processes contend under the file lock without duplicate apply or overwriting safety history", async t => {
  const f = fixture(t);
  const jobs = Array.from({ length: 4 }, () => {
    const code = `import process from 'node:process';
      import {createConfirmationStore} from ${JSON.stringify(MODULE)};
      const store = createConfirmationStore({filename:${JSON.stringify(f.filename)},now:()=>${START}});
      const scope = ${JSON.stringify(SCOPE)}, binding = ${JSON.stringify(BINDING)}, op = ${JSON.stringify(operation())};
      process.stdin.once('data', async () => {
        let calls = 0;
        const draft = store.create(scope, op, {messageId:'0', binding});
        const result = draft.status === 'pending' ? await store.execute(scope, draft.ref,
          {binding, assertCurrent() {}, apply() {calls++; return {status:'applied'};}}) : draft;
        process.stdout.write(JSON.stringify({result, calls})+'\\n'); process.stdin.destroy();
      }); process.stdout.write('ready\\n');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "", errors = "", ready;
    const started = new Promise(resolve => { ready = resolve; });
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic worker timeout")); }, 10000);
      child.stdout.on("data", data => { output += data; if (output.startsWith("ready\n")) ready(); });
      child.stderr.on("data", data => { errors += data; });
      child.on("error", error => { clearTimeout(timer); ready(); reject(error); });
      child.on("close", code => {
        clearTimeout(timer); ready();
        if (code !== 0) reject(new Error(errors));
        else { try { resolve(JSON.parse(output.split("\n")[1])); } catch (error) { reject(error); } }
      });
    });
    return { child, started, completed };
  });
  await Promise.all(jobs.map(job => job.started));
  for (const job of jobs) job.child.stdin.end("go");
  const results = await Promise.all(jobs.map(job => job.completed));
  assert.ok(results.reduce((sum, result) => sum + result.calls, 0) <= 1);
  assert.equal(disk(f.filename).rows.length, 1);
  let calls = 0;
  const ref = disk(f.filename).rows[0].ref;
  const result = await execute(f.store, ref, () => { calls++; });
  assert.ok(["applied", "unknown", "denied"].includes(result.status));
  assert.equal(calls, 0);
});

test("corruption, malformed state, missing-after-seen, and oversized input latch failclosed without empty rewrites", async t => {
  const damages = [filename => fs.writeFileSync(filename, "{broken"), filename => fs.unlinkSync(filename),
    filename => put(filename, { ...disk(filename), version: 2 }), filename => put(filename, { ...disk(filename), extra: true }),
    filename => fs.writeFileSync(filename, " ".repeat(1024 * 1024 + 1))];
  for (const damage of damages) {
    const f = fixture(t); const ref = create(f).ref;
    const saved = fs.readFileSync(f.filename, "utf8");
    damage(f.filename);
    const damaged = fs.existsSync(f.filename) ? fs.readFileSync(f.filename, "utf8") : null;
    let calls = 0;
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    assert.equal(create(f, operation(), "1").status, "unavailable");
    assert.equal(f.store.inspect(SCOPE, ref).status, "unavailable");
    assert.deepEqual(f.store.list(), { status: "unavailable", items: [] });
    assert.equal(fs.existsSync(f.filename) ? fs.readFileSync(f.filename, "utf8") : null, damaged);
    fs.writeFileSync(f.filename, saved);
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    assert.equal(calls, 0);
  }
});

test("every immutable bound field and internal operation hash is checked before execution", async t => {
  const changes = [row => { row.operation.parameters.value = "Mallory"; }, row => { row.operation.action = "memory_remove"; },
    row => { row.operation.baseline.revision = "revision-2"; }, row => { row.binding.privacyRevision = 2; },
    row => { row.messageId = "1"; }, row => { row.ownerKey = "b".repeat(64); }, row => { row.userKey = "b".repeat(64); },
    row => { row.domain = "reminder"; }, row => { row.action = "set_style"; },
    row => { row.expiresAt++; }, row => { row.createdAt--; }, row => { row.operationHash = "b".repeat(64); },
    row => { row.bindingHash = "b".repeat(64); }, row => { row.ref = `cf_${"b".repeat(32)}`; },
    row => { row.instance = "b".repeat(32); }, row => { row.seal = "b".repeat(64); }];
  for (const change of changes) {
    const f = fixture(t); const ref = create(f).ref;
    const state = disk(f.filename); change(state.rows[0]); put(f.filename, state);
    let calls = 0;
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    assert.equal(calls, 0);
  }
});

test("state rollback after a successful apply cannot restore a consumed pending ref", async t => {
  const f = fixture(t); const ref = create(f).ref;
  const old = disk(f.filename);
  assert.equal((await execute(f.store, ref)).status, "applied");
  put(f.filename, old);
  let calls = 0;
  assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
  assert.equal(calls, 0);
});

test("fresh same-process instances reject recomputed tamper hashes and revived consumed rows", async t => {
  const f = fixture(t); const ref = create(f).ref;
  const state = disk(f.filename);
  state.rows[0].operation.parameters.value = "Mallory";
  // An attacker can compute an ordinary operation digest, but not the process-only seal.
  state.rows[0].operationHash = createHash("sha256").update(JSON.stringify(state.rows[0].operation)).digest("hex");
  state.sequence++; put(f.filename, state);
  let calls = 0;
  assert.equal((await execute(f.reload(), ref, () => { calls++; })).status, "unknown");
  assert.equal(calls, 0);

  const completed = fixture(t); const finishedRef = create(completed).ref;
  const pending = disk(completed.filename);
  assert.equal((await execute(completed.store, finishedRef)).status, "applied");
  pending.sequence = disk(completed.filename).sequence + 1;
  put(completed.filename, pending);
  assert.equal((await execute(completed.reload(), finishedRef, () => { calls++; })).status, "unknown");
  assert.equal(calls, 0);
});

test("a guard-side file mutation is detected and not overwritten or applied", async t => {
  for (const when of [1, 2]) {
    const f = fixture(t); const ref = create(f).ref;
    let guards = 0, calls = 0;
    const result = await execute(f.store, ref, () => { calls++; }, { assertCurrent() {
      if (++guards === when) fs.writeFileSync(f.filename, "{tampered");
    } });
    assert.equal(result.status, "unknown");
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(f.filename, "utf8"), "{tampered");
  }
});

test("failed or no-op draft/claim persistence never invokes apply and never acknowledges an undurable pending claim", async t => {
  for (const write of [() => { throw new Error("private failure"); }, () => false, () => {}, async () => {}]) {
    if (write.constructor.name === "AsyncFunction") {
      assert.throws(() => fixture(t, { write }), TypeError); continue;
    }
    const f = fixture(t, { write });
    assert.equal(create(f).status, "unavailable");
    assert.equal(fs.existsSync(f.filename), false);
  }
  for (const mode of ["throw", "noop", "partial"]) {
    let writes = 0;
    const f = fixture(t, { write(filename, state, options) {
      assert.equal(options.durable, true);
      if (++writes === 2) {
        if (mode === "partial") writeJsonFileSync(filename, state, options);
        if (mode !== "noop") throw new Error("claim failure");
        return;
      }
      writeJsonFileSync(filename, state, options);
    } });
    const ref = create(f).ref;
    let calls = 0;
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    assert.equal(calls, 0);
  }
});

test("terminal receipt-save failure returns unknown, retains durable consumption and cannot retry", async t => {
  for (const mode of ["throw", "noop", "after-save"]) {
    let writes = 0;
    const f = fixture(t, { write(filename, state, options) {
      if (++writes === 3) {
        if (mode === "after-save") writeJsonFileSync(filename, state, options);
        if (mode !== "noop") throw new Error("receipt failure");
        return;
      }
      writeJsonFileSync(filename, state, options);
    } });
    const ref = create(f).ref;
    let calls = 0;
    const result = await execute(f.store, ref, () => { calls++; return { status: "applied" }; });
    assert.equal(result.status, "unknown"); assert.equal(calls, 1);
    assert.equal((await execute(f.store, ref, () => { calls++; })).status, "unknown");
    const recovered = cold(`let calls = 0; const result = await store.execute(scope, ${JSON.stringify(ref)},
      {binding, assertCurrent() {}, apply() { calls++; return {status:'applied'}; }});
      process.stdout.write(JSON.stringify({result, calls}));`, f.filename);
    assert.equal(recovered.calls, 0);
    assert.equal(recovered.result.status, mode === "after-save" ? "applied" : "unknown");
  }
});

test("real process replacement invalidates pending drafts and recovers interrupted executing rows as unknown without replay", async t => {
  const pending = fixture(t);
  const prepared = cold(`const draft = store.create(scope, op, {messageId:'0', binding}); process.stdout.write(JSON.stringify(draft));`, pending.filename);
  assert.equal(prepared.status, "pending");
  let calls = 0;
  assert.equal((await execute(pending.store, prepared.ref, () => { calls++; })).status, "denied");
  assert.equal(disk(pending.filename).rows[0].operation, null);

  const running = fixture(t);
  const interrupted = cold(`const draft = store.create(scope, op, {messageId:'0', binding});
    await store.execute(scope, draft.ref, {binding, assertCurrent() {}, apply() {
      if (JSON.parse(fs.readFileSync(filename, 'utf8')).rows[0].status !== 'executing') process.exit(2);
      process.stdout.write(JSON.stringify(draft)); process.exit(0);
    }});`, running.filename);
  assert.equal(disk(running.filename).rows[0].status, "executing");
  assert.equal((await execute(running.store, interrupted.ref, () => { calls++; })).status, "unknown");
  assert.equal(disk(running.filename).rows[0].status, "unknown");
  assert.equal(disk(running.filename).rows[0].operation, null);
  assert.equal((await execute(running.reload(), interrupted.ref, () => { calls++; })).status, "unknown");
  assert.equal(calls, 0);
});

test("stale locks, clock regression and cold corrupt reads cannot authorize or reset state", async t => {
  const f = fixture(t); const ref = create(f).ref;
  const saved = fs.readFileSync(f.filename, "utf8");
  fs.writeFileSync(`${f.filename}.lock`, "existing lock");
  assert.equal((await execute(f.store, ref)).status, "unknown");
  assert.equal(fs.readFileSync(`${f.filename}.lock`, "utf8"), "existing lock");
  assert.equal(fs.readFileSync(f.filename, "utf8"), saved);
  fs.unlinkSync(`${f.filename}.lock`);
  f.setTime(START - 1);
  assert.equal((await execute(f.store, ref)).status, "unknown");
  assert.equal(fs.readFileSync(f.filename, "utf8"), saved);
  const bad = fixture(t);
  fs.writeFileSync(bad.filename, "{bad");
  assert.equal(create(bad).status, "unavailable");
  assert.equal(fs.readFileSync(bad.filename, "utf8"), "{bad");
});

test("injected reads are bounded and getter-safe; missing-after-seen injection never recreates state", async t => {
  let stored, writes = 0, getters = 0;
  const f = fixture(t, { read(_filename, fallback, options) {
    assert.equal(options.maxBytes, 1024 * 1024);
    return stored === undefined ? fallback : stored;
  }, write(_filename, state, options) { assert.equal(options.durable, true); stored = clone(state); writes++; } });
  const ref = create(f).ref;
  assert.equal(writes, 1);
  Object.defineProperty(stored.rows[0].operation.parameters, "value", { enumerable: true, get() { getters++; return "Alice"; } });
  assert.equal((await execute(f.store, ref)).status, "unknown");
  assert.equal(getters, 0); assert.equal(writes, 1);
  stored = undefined;
  assert.equal(create(f, operation(), "1").status, "unavailable");
  assert.equal(writes, 1);
  const missing = fixture(t, { read: (_filename, fallback) => fallback, write: () => {} });
  assert.equal(create(missing).status, "unavailable");
  const failing = fixture(t, { read: () => { throw new Error("private /tmp/path"); }, write: () => { writes++; } });
  assert.equal(create(failing).status, "unavailable");
  assert.equal(writes, 1);
  assert.equal(readJsonFile(f.filename, null), null);
});
