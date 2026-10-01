import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { createReminderService } from "../bridge/agent-reminders/service.mjs";
import { readJsonFile, writeJsonFileSync } from "../bridge/persistence/json-file.mjs";

const root = fs.mkdtempSync(path.join(process.env.QQFRIEND_REMINDER_TEST_ROOT || os.tmpdir(), "qqfriend-agent-reminders-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const scope = Object.freeze({ surface: "group", groupId: "50150", userId: "60150" });
const otherUser = { ...scope, userId: "60151" };
const otherGroup = { ...scope, groupId: "50151" };
const MINUTE = 60000;
const HORIZON = 7 * 86400000;
const GRACE = 5 * MINUTE;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const filename = path.join(directory, "reminders.json");
  let clock = Date.parse("2026-10-01T08:00:00.000Z"), cutoff = 0, allowed = true;
  const deliveries = [];
  const dependencies = { filename, now: () => clock, isPermitted: () => allowed, readPrivacyCutoff: () => cutoff,
    deliver: async job => { deliveries.push(job); return { status: "sent" }; }, ...options };
  const service = createReminderService(dependencies);
  t.after(async () => { await service.stop({ drainMs: 0 }); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, filename, dependencies, deliveries,
    get now() { return clock; }, set now(value) { clock = value; },
    set cutoff(value) { cutoff = value; }, set allowed(value) { allowed = value; },
    state: () => readJsonFile(filename), restart: overrides => createReminderService({ ...dependencies, ...overrides }) };
}
function prepare(f, args = {}, owner = scope) {
  const result = f.service.prepare(owner, { action: "create", text: "Synthetic reminder body", delay_minutes: 2, ...args });
  return result.status === "ready" ? result.operation : result;
}
function create(f, key = "confirmation-1", owner = scope, args = {}) {
  const operation = prepare(f, args, owner);
  const result = f.service.commit(owner, operation, { idempotencyKey: key });
  assert.equal(result.status, "applied");
  return result;
}

test("default missing dependencies deny preparation and never install a timer", async t => {
  const f = fixture(t);
  for (const missing of ["isPermitted", "readPrivacyCutoff", "deliver"]) {
    const service = f.restart({ [missing]: undefined });
    assert.equal(service.prepare(scope, { action: "create", text: "Body", delay_minutes: 1 }).status, "denied");
    assert.equal(service.start().status, "denied");
    assert.equal((await service.tick()).status, "denied");
    assert.equal(await service.stop({ drainMs: 0 }), true);
  }
  const service = createReminderService();
  assert.equal(service.start().status, "denied");
  assert.equal(fs.existsSync(f.filename), false);
});

test("preparation is pure, JSON-only, scope-free, and fixes the reviewed dueAt", t => {
  const f = fixture(t);
  const operation = prepare(f);
  assert.deepEqual(Object.keys(operation), ["domain", "action", "parameters", "baseline", "preview"]);
  assert.equal(operation.domain, "reminder");
  assert.equal(operation.parameters.dueAt, new Date(f.now + 2 * MINUTE).toISOString());
  assert.doesNotMatch(JSON.stringify(operation), /50150|60150|reminders\.json|case-/);
  assert.deepEqual(JSON.parse(JSON.stringify(operation)), operation);
  assert.equal(fs.existsSync(f.filename), false);
  f.now += 20000;
  const result = f.service.commit(scope, operation, { idempotencyKey: "fixed-review" });
  assert.equal(result.status, "applied");
  assert.equal(result.text, "\u5df2\u521b\u5efa\u63d0\u9192\uff0c\u5c1a\u672a\u53d1\u9001");
  assert.deepEqual(Object.keys(result), ["status", "ref", "text"]);
  assert.equal(f.state().rows[0].dueAt, Date.parse(operation.parameters.dueAt));
  assert.equal(f.deliveries.length, 0);
});

test("one-minute review confirmed after one second keeps its exact dueAt; elapsed deadlines cannot arm", t => {
  const f = fixture(t), operation = prepare(f, { delay_minutes: 1 });
  const dueAt = operation.parameters.dueAt, preview = operation.preview;
  f.now += 1000;
  const result = f.service.commit(scope, operation, { idempotencyKey: "one-minute-human-confirmation" });
  assert.equal(result.status, "applied");
  assert.equal(f.state().rows[0].dueAt, Date.parse(dueAt));
  assert.equal(f.state().rows[0].createdAt, f.now);
  assert.equal(f.state().rows[0].dueAt - f.state().rows[0].createdAt, 59000);
  assert.equal(operation.parameters.dueAt, dueAt); assert.equal(operation.preview, preview);
  assert.equal(f.service.list(scope).items[0].dueAt, dueAt); assert.equal(f.deliveries.length, 0);
  for (const elapsedBy of [0, 1]) {
    const boundary = fixture(t), reviewed = prepare(boundary, { delay_minutes: 1 });
    boundary.now = Date.parse(reviewed.parameters.dueAt) + elapsedBy;
    assert.equal(boundary.service.commit(scope, reviewed, { idempotencyKey: "elapsed-human-confirmation" }).status, "not_applied");
    assert.equal(fs.existsSync(boundary.filename), false);
    assert.deepEqual(boundary.service.list(scope).items, []);
  }
});

test("strict finite datetime and relative deadline validation", t => {
  const f = fixture(t);
  for (const delay_minutes of [0, -1, 1.5, 10081, "2", Infinity, NaN]) assert.equal(prepare(f, { delay_minutes }).status, "invalid_arguments");
  assert.equal(prepare(f, { delay_minutes: 1 }).domain, "reminder");
  assert.equal(prepare(f, { delay_minutes: 10080 }).domain, "reminder");
  for (const when of ["tomorrow", "2026-10-01T08:01:00", "2026-02-30T08:01:00Z", "2026-10-01T24:00:00Z",
    "2026-10-01T08:01:60Z", "2026-10-01T08:01:00+14:01", "2026-10-01T08:01:00+99:99",
    new Date(f.now + MINUTE - 1).toISOString(), new Date(f.now + HORIZON + 1).toISOString()]) {
    assert.equal(f.service.prepare(scope, { action: "create", text: "Body", when }).status, "invalid_arguments", when);
  }
  const zoned = f.service.prepare(scope, { action: "create", text: "Body", when: "2026-10-01T16:02:00+08:00" });
  assert.equal(zoned.status, "ready");
  assert.equal(zoned.operation.parameters.dueAt, "2026-10-01T08:02:00.000Z");
  assert.equal(prepare(f, { when: zoned.operation.parameters.dueAt }).status, "invalid_arguments");
});

test("unsafe text, foreign fields, malformed scopes, and accessor inputs fail without invoking getters", t => {
  const f = fixture(t);
  for (const text of ["", " ", " leading", "trailing ", "x".repeat(301), "line\nbreak", "[CQ:at,qq=1]", "<think>private</think>",
    "api_key=synthetic", "Bearer synthetic-value", "sk-syntheticcredential123", "invisible\u200b", "bad\ud800"]) {
    assert.equal(prepare(f, { text }).status, "invalid_arguments");
  }
  let getters = 0;
  const accessor = { action: "create", get text() { getters++; return "Body"; }, delay_minutes: 1 };
  const accessorScope = { surface: "group", groupId: "50150", get userId() { getters++; return "60150"; } };
  assert.equal(f.service.prepare(scope, accessor).status, "invalid_arguments");
  assert.equal(f.service.prepare(accessorScope, {}).status, "denied");
  assert.equal(prepare(f, { path: "/tmp/other" }).status, "invalid_arguments");
  for (const owner of [{ ...scope, surface: "private" }, { ...scope, userId: "060150" }, { ...scope, userId: "-0" },
    { ...scope, userId: 9007199254740992 }, { ...scope, groupId: "1".repeat(21) }]) assert.equal(prepare(f, {}, owner).status, "denied");
  assert.equal(prepare(f, {}, { surface: "group", groupId: 0, userId: "-1" }).status, "denied");
  assert.equal(getters, 0);
});

test("shared sensitive fields and complete Basic/Digest credentials are rejected at prepare and commit", t => {
  let writes = 0;
  const f = fixture(t, { write: (...args) => { writes++; return writeJsonFileSync(...args); } });
  create(f, "credential-guard-existing");
  const ordinary = prepare(f, { text: "Safe placeholder" });
  const before = fs.readFileSync(f.filename, "utf8"), beforeWrites = writes;
  const basic = Buffer.from("synthetic-user:synthetic-private-value").toString("base64");
  const texts = ["token=synthetic-private-value", "refresh_token=synthetic-private-value", "\u5bc6\u7801=synthetic-private-value",
    "client_secret=synthetic-private-value", "passwd=synthetic-private-value", '{"token":"synthetic-private-value"}',
    `Authorization: Basic ${basic}`, `Proxy-Authorization: Basic ${basic}`, `Basic ${basic}`, `Basic ${basic}.`,
    `Basic "${basic}"`, `Basic ${basic.replace(/=+$/, "")}`,
    'Authorization: Digest username="synthetic-user", response="synthetic-private-value"',
    'Digest username="synthetic-user", response="synthetic-private-value"',
    'Digest "username"="synthetic-user", response="synthetic-private-value"'];
  for (const [index, text] of texts.entries()) {
    assert.equal(f.service.prepare(scope, { action: "create", text, delay_minutes: 2 }).status, "invalid_arguments");
    const forged = { ...ordinary, parameters: { ...ordinary.parameters, text },
      preview: ordinary.preview.replace("Safe placeholder", text) };
    assert.equal(f.service.commit(scope, forged, { idempotencyKey: `credential-guard-${index}` }).status, "not_applied");
  }
  assert.equal(writes, beforeWrites); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.equal(f.service.list(scope).status, "ready"); assert.equal(f.deliveries.length, 0);
  for (const text of ["Basic mathematics homework", "Digest report after lunch"]) assert.equal(prepare(f, { text }).domain, "reminder");
});

test("QQ group/user scope identities are positive and canonical even with a permissive callback", t => {
  let calls = 0;
  const f = fixture(t, { isPermitted: () => { calls++; return true; } });
  const operation = prepare(f);
  const created = f.service.commit(scope, operation, { idempotencyKey: "positive-scope" });
  const before = fs.readFileSync(f.filename, "utf8");
  calls = 0;
  const invalidIds = [0, -0, -1, 1, 50150, Number.MAX_SAFE_INTEGER, "0", "-0", "-1", "-50150", "01", "060150", "+1", " 1", "1 ", "1.0", "1e3",
    "\uff11", "1".repeat(21), 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, undefined, true, {}];
  for (const key of ["groupId", "userId"]) for (const id of invalidIds) {
    const invalidScope = { ...scope, [key]: id };
    assert.equal(prepare(f, {}, invalidScope).status, "denied");
    assert.equal(f.service.commit(invalidScope, operation, { idempotencyKey: "invalid-scope" }).status, "not_applied");
    assert.equal(f.service.list(invalidScope).status, "unavailable");
    assert.deepEqual(f.service.list(invalidScope).items, []);
    assert.equal(f.service.cancel(invalidScope, created.ref).status, "unavailable");
  }
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  for (const id of ["1", "50150", "99999999999999999999"]) {
    for (const key of ["groupId", "userId"]) assert.equal(prepare(f, {}, { ...scope, [key]: id }).domain, "reminder");
  }
  const numericScope = { surface: "group", groupId: 50150, userId: 60150 };
  assert.equal(f.service.commit(numericScope, operation, { idempotencyKey: "positive-scope" }).status, "not_applied");
  assert.equal(f.service.commit({ ...scope }, operation, { idempotencyKey: "positive-scope" }).ref, created.ref);
  assert.deepEqual(f.state().rows[0].scope, scope);
});

test("create preview is canonical Chinese Beijing time with controlled self/current-group semantics", t => {
  const f = fixture(t);
  const operation = prepare(f, { text: "Body" });
  assert.equal(operation.preview, "\u521b\u5efa\u63d0\u9192\uff1a\u5317\u4eac\u65f6\u95f4 2026\u5e7410\u670801\u65e5 16:02:00\uff0c\u4ec5\u5728\u5f53\u524d\u7fa4\u63d0\u9192\u672c\u4eba\u3002\u5185\u5bb9\uff1aBody");
  assert.doesNotMatch(operation.preview, /50150|60150|Reminder|2026-10-01T/);
  const zoned = f.service.prepare(scope, { action: "create", text: "Body", when: "2026-10-01T16:02:00+08:00" });
  assert.equal(zoned.operation.preview, operation.preview);
  for (const altered of ["Reminder at 2026-10-01T08:02:00.000Z: Body", operation.preview.replace("16:02:00", "08:02:00"),
    operation.preview.replace("\u5f53\u524d\u7fa4", "\u5176\u4ed6\u7fa4"), operation.preview.replace("\u672c\u4eba", "\u4ed6\u4eba")]) {
    assert.equal(f.service.commit(scope, { ...operation, preview: altered }, { idempotencyKey: "altered-preview" }).status, "not_applied");
  }
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "canonical-preview" }).status, "applied");
});

test("Beijing preview rolls the calendar date at midnight and preserves fractional seconds", t => {
  const f = fixture(t);
  f.now = Date.parse("2026-10-01T15:59:00.000Z");
  const operation = prepare(f, { text: "Body" });
  assert.match(operation.preview, /2026\u5e7410\u670802\u65e5 00:01:00/);
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "beijing-midnight" }).status, "applied");
  const fractional = f.service.prepare(scope, { action: "create", text: "Body", when: "2026-10-01T16:01:00.123Z" });
  assert.match(fractional.operation.preview, /2026\u5e7410\u670802\u65e5 00:01:00\.123/);
  assert.equal(f.service.commit(scope, fractional.operation, { idempotencyKey: "beijing-fraction" }).status, "applied");
});

test("cancel preview uses the same sealed Chinese self/current-group formatter", t => {
  const f = fixture(t); const created = create(f);
  const prepared = f.service.prepare(scope, { action: "cancel", ref: created.ref });
  assert.equal(prepared.operation.preview, `\u53d6\u6d88\u672c\u4eba\u5728\u5f53\u524d\u7fa4\u7684\u63d0\u9192\uff1a${created.ref}\u3002`);
  assert.doesNotMatch(prepared.operation.preview, /50150|60150|Cancel reminder/);
  const before = fs.readFileSync(f.filename, "utf8");
  const changed = { ...prepared.operation, preview: prepared.operation.preview.replace("\u672c\u4eba", "\u4ed6\u4eba") };
  assert.equal(f.service.commit(scope, changed, { idempotencyKey: "wrong-cancel-preview" }).status, "not_applied");
  assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.equal(f.service.commit(scope, prepared.operation, { idempotencyKey: "canonical-cancel" }).status, "applied");
  assert.equal(f.state().rows[0].state, "cancelled");
});

test("Chinese acknowledgements distinguish armed, duplicate, cancelled, unavailable and unknown outcomes", t => {
  const f = fixture(t), operation = prepare(f);
  const first = f.service.commit(scope, operation, { idempotencyKey: "chinese-ack" });
  assert.equal(first.text, "\u5df2\u521b\u5efa\u63d0\u9192\uff0c\u5c1a\u672a\u53d1\u9001");
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "chinese-ack" }).text, "\u8be5\u63d0\u9192\u5df2\u8bb0\u5f55\uff0c\u672a\u518d\u6b21\u53d1\u9001");
  assert.equal(f.service.cancel(otherUser, first.ref).text, "\u63d0\u9192\u4e0d\u53ef\u7528");
  assert.equal(f.service.cancel(scope, "invalid").text, "\u63d0\u9192\u4e0d\u53ef\u7528");
  assert.equal(f.service.cancel(scope, first.ref).text, "\u5df2\u53d6\u6d88\u63d0\u9192");
  const cancelled = f.service.prepare(scope, { action: "cancel", ref: first.ref });
  assert.equal(f.service.commit(scope, cancelled.operation, { idempotencyKey: "chinese-cancel" }).text, "\u5df2\u53d6\u6d88\u63d0\u9192");
  assert.equal(f.service.commit(scope, { ...operation, preview: "changed" }, { idempotencyKey: "chinese-invalid" }).text, "\u672a\u6267\u884c\u63d0\u9192\u53d8\u66f4");
  const failed = fixture(t, { write: () => { throw new Error("Synthetic persistence failure"); } });
  const uncertain = failed.service.commit(scope, prepare(failed), { idempotencyKey: "chinese-unknown" });
  assert.equal(uncertain.status, "unknown");
  assert.equal(uncertain.text, "\u63d0\u9192\u53d8\u66f4\u7ed3\u679c\u672a\u77e5\uff0c\u8bf7\u52ff\u91cd\u8bd5");
});

test("commit rejects DTO tampering, stale cutoff, unreviewed rebase, and expired review", t => {
  const f = fixture(t);
  const operation = prepare(f);
  let getters = 0;
  for (const changed of [{ ...operation, path: "/tmp" }, { ...operation, domain: "memory" },
    { ...operation, baseline: { ...operation.baseline, sourceIdentity: "0".repeat(64) } },
    { ...operation, parameters: { ...operation.parameters, dueAt: "tomorrow" } }, { ...operation, preview: "different" },
    { ...operation, get parameters() { getters++; return operation.parameters; } }]) {
    assert.equal(f.service.commit(scope, changed, { idempotencyKey: "tampered" }).status, "not_applied");
  }
  assert.equal(getters, 0);
  assert.equal(f.service.commit(scope, operation, {}).status, "not_applied");
  f.cutoff = f.now - 1;
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "stale" }).status, "not_applied");
  f.cutoff = 0; f.now += 2 * MINUTE + 1;
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "late-review" }).status, "not_applied");
  assert.equal(fs.existsSync(f.filename), false);
});

test("durable idempotent creation survives restart and is owner/group bound", async t => {
  const f = fixture(t);
  const operation = prepare(f);
  const created = f.service.commit(scope, operation, { idempotencyKey: "once" });
  assert.match(created.ref, /^rem_[a-f0-9]{32}$/);
  assert.equal(created.ref.length, 36);
  assert.equal(f.state().rows[0].state, "armed");
  assert.equal(f.service.commit(scope, operation, { idempotencyKey: "once" }).ref, created.ref);
  const replacement = f.restart();
  assert.equal(replacement.commit(scope, operation, { idempotencyKey: "once" }).ref, created.ref);
  const changed = prepare(f, { text: "Changed body" });
  assert.equal(replacement.commit(scope, changed, { idempotencyKey: "once" }).status, "not_applied");
  assert.equal(replacement.commit(otherUser, operation, { idempotencyKey: "once" }).status, "applied");
  assert.equal(replacement.commit(otherGroup, operation, { idempotencyKey: "once" }).status, "applied");
  assert.equal(f.state().rows.length, 3);
  await replacement.stop({ drainMs: 0 });
});

test("owned list exposes only own body while global list is safe metadata", t => {
  const f = fixture(t);
  create(f); create(f, "other", otherUser, { text: "Other synthetic body" });
  const ownView = f.service.list(scope);
  assert.equal(ownView.status, "ready");
  const own = ownView.items;
  assert.equal(own.length, 1); assert.equal(own[0].text, "Synthetic reminder body");
  assert.equal(f.service.list(otherGroup).items.length, 0);
  assert.doesNotMatch(JSON.stringify(f.service.list()), /synthetic|50150|60150|keyHash|operationHash|scope|salt/i);
  f.allowed = false;
  assert.equal(f.service.list(scope).status, "unavailable");
  assert.deepEqual(f.service.list(scope).items, []);
});

test("per-user active limit spans groups, global store and retained history remain bounded", t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) create(f, `owner-${i}`, i % 2 ? otherGroup : scope);
  assert.equal(f.service.commit(scope, prepare(f), { idempotencyKey: "owner-overflow" }).status, "not_applied");
  for (let i = 8; i < 128; i++) create(f, `global-${i}`, { ...scope, userId: String(70000 + i) });
  assert.equal(f.state().rows.length, 128);
  assert.equal(f.service.commit(otherUser, prepare(f, {}, otherUser), { idempotencyKey: "global-overflow" }).status, "not_applied");
  f.service.revokeUser(scope.userId);
  assert.equal(f.service.commit(otherUser, prepare(f, {}, otherUser), { idempotencyKey: "retained-history" }).status, "applied");
  assert.equal(f.state().rows.length, 129);
  f.now += HORIZON + 2 * MINUTE + GRACE + 1;
  assert.equal(f.service.commit(scope, prepare(f), { idempotencyKey: "new-window" }).status, "applied");
  assert.ok(f.state().rows.length <= 256);
});

test("UTF candidate capacity rejection never writes or faults the healthy ledger and existing reminders still send", async t => {
  let writes = 0;
  const f = fixture(t, { write: (...args) => { writes++; return writeJsonFileSync(...args); } });
  const ordinary = create(f, "utf-existing", scope, { text: "Ordinary armed reminder" });
  const text = "\u{1f680}".repeat(300);
  let rejected = false;
  for (let index = 0; index < 255; index++) {
    const operation = prepare(f, { text });
    assert.equal(operation.domain, "reminder");
    const before = fs.readFileSync(f.filename, "utf8"), beforeWrites = writes;
    const result = f.service.commit(scope, operation, { idempotencyKey: `utf-history-${index}` });
    if (result.status === "not_applied") {
      rejected = true;
      assert.equal(writes, beforeWrites); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
      assert.equal(f.service.list(scope).status, "ready");
      assert.equal(f.state().rows.find(row => row.ref === ordinary.ref).state, "armed");
      assert.ok(Buffer.byteLength(before, "utf8") < 256 * 1024);
      assert.equal(f.service.commit(scope, operation, { idempotencyKey: `utf-history-${index}` }).status, "not_applied");
      assert.equal(writes, beforeWrites); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
      break;
    }
    assert.equal(result.status, "applied");
    assert.equal(f.service.cancel(scope, result.ref).status, "cancelled");
  }
  assert.equal(rejected, true);
  f.now += 2 * MINUTE;
  const tick = await f.service.tick();
  assert.equal(tick.status, "ok"); assert.equal(tick.delivered, 1);
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].ref, ordinary.ref);
  assert.equal(f.state().rows.find(row => row.ref === ordinary.ref).state, "sent");
  assert.ok(fs.statSync(f.filename).size <= 256 * 1024);
  const replacement = f.restart();
  assert.equal((await replacement.tick()).delivered, 0); assert.equal(f.deliveries.length, 1);
  await replacement.stop({ drainMs: 0 });
});

test("unknown and partial transport outcomes retain owner/global capacity across restart", async t => {
  let calls = 0;
  const f = fixture(t, { deliver: async () => ({ status: ++calls <= 4 ? "unknown" : "partial" }) });
  for (let i = 0; i < 8; i++) create(f, `uncertain-${i}`);
  f.now += 2 * MINUTE;
  const result = await f.service.tick();
  assert.equal(result.attempted, 8); assert.equal(result.delivered, 0);
  assert.equal(f.service.commit(scope, prepare(f), { idempotencyKey: "uncertain-owner-overflow" }).status, "not_applied");
  for (let i = 8; i < 128; i++) create(f, `armed-${i}`, { ...scope, userId: String(80000 + i) });
  const replacement = f.restart();
  const ready = replacement.prepare(otherUser, { action: "create", text: "Body", delay_minutes: 2 });
  assert.equal(ready.status, "ready");
  assert.equal(replacement.commit(otherUser, ready.operation, { idempotencyKey: "uncertain-global-overflow" }).status, "not_applied");
  assert.equal(replacement.revokeUser(scope.userId, { persist: true }), true);
  assert.equal(replacement.commit(otherUser, ready.operation, { idempotencyKey: "scrubbed-unknown-still-reserved" }).status, "not_applied");
  assert.equal(calls, 8); assert.equal(f.state().rows.length, 128);
  await replacement.stop({ drainMs: 0 });
});

test("unknown/partial replay records survive age GC and explicit privacy scrubbing without old-key reuse", async t => {
  for (const outcome of ["unknown", "partial"]) {
    let calls = 0;
    const f = fixture(t, { deliver: async () => { calls++; return { status: outcome }; } });
    const first = create(f, "ambiguous-send-key");
    f.now += 2 * MINUTE;
    assert.equal((await f.service.tick()).delivered, 0); assert.equal(calls, 1);
    const original = f.state().rows.find(row => row.ref === first.ref);
    assert.equal(original.state, outcome);
    f.now += HORIZON + GRACE + 1;
    const future = prepare(f, { text: "Different future reminder" });
    assert.equal(f.service.commit(scope, future, { idempotencyKey: "ambiguous-send-key" }).status, "not_applied");
    assert.equal(f.service.commit(scope, future, { idempotencyKey: "independent-new-key" }).status, "applied");
    const retained = f.state().rows.find(row => row.ref === first.ref);
    assert.equal(retained.state, outcome); assert.equal(retained.keyHash, original.keyHash);
    assert.equal(retained.operationHash, original.operationHash); assert.equal(calls, 1);
    const replacement = f.restart();
    assert.equal(replacement.commit(scope, future, { idempotencyKey: "ambiguous-send-key" }).status, "not_applied");
    assert.equal(replacement.revokeUser(scope.userId, { persist: true }), true);
    const scrubbed = f.state().rows.find(row => row.ref === first.ref);
    assert.equal(scrubbed.state, outcome); assert.equal(scrubbed.keyHash, original.keyHash);
    assert.equal(scrubbed.scope, null); assert.equal(scrubbed.text, "");
    assert.equal(replacement.commit(scope, future, { idempotencyKey: "ambiguous-send-key" }).status, "not_applied");
    assert.equal(calls, 1);
    await replacement.stop({ drainMs: 0 });
  }
});

test("B exact age sequence retains both UNKNOWN/PARTIAL records and rejects fresh future operations using their keys", async t => {
  let writes = 0;
  const calls = [];
  const f = fixture(t, {
    write: (...args) => { writes++; return writeJsonFileSync(...args); },
    deliver: async job => { calls.push(job.text); return { status: job.text === "UNKNOWN" ? "unknown" : "partial" }; },
  });
  const unknown = create(f, "UNKNOWN", scope, { text: "UNKNOWN", delay_minutes: 1 });
  const partial = create(f, "PARTIAL", scope, { text: "PARTIAL", delay_minutes: 1 });
  f.now += MINUTE;
  const tick = await f.service.tick();
  assert.equal(tick.attempted, 2); assert.equal(tick.delivered, 0);
  assert.deepEqual(calls, ["UNKNOWN", "PARTIAL"]);
  f.now += HORIZON + GRACE + 1;
  assert.equal(f.service.commit(scope, prepare(f, { text: "NEW" }), { idempotencyKey: "NEW" }).status, "applied");
  assert.equal(f.state().rows.find(row => row.ref === unknown.ref).state, "unknown");
  assert.equal(f.state().rows.find(row => row.ref === partial.ref).state, "partial");
  const future = prepare(f, { text: "NEW_KEY_REUSE" });
  assert.ok(Date.parse(future.parameters.dueAt) > f.now);
  const before = fs.readFileSync(f.filename, "utf8"), beforeWrites = writes;
  for (const idempotencyKey of ["UNKNOWN", "PARTIAL"]) {
    assert.equal(f.service.commit(scope, future, { idempotencyKey }).status, "not_applied");
  }
  assert.equal(writes, beforeWrites); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.equal(f.state().rows.length, 3); assert.deepEqual(calls, ["UNKNOWN", "PARTIAL"]);
});

test("frozen public DTOs disclose no backend identity and permission receives only scope", t => {
  const f = fixture(t, { isPermitted: (...args) => { assert.equal(args.length, 1); assert.deepEqual(args[0], scope); return true; } });
  const ready = f.service.prepare(scope, { action: "create", text: "Body", delay_minutes: 2 });
  assert.deepEqual(Object.keys(ready), ["status", "operation"]);
  const applied = f.service.commit(scope, ready.operation, { idempotencyKey: "frozen-shapes" });
  assert.deepEqual(Object.keys(applied), ["status", "ref", "text"]);
  assert.equal(f.service.list(scope).items[0].phase, "armed");
  assert.equal(f.service.list().items[0].text, undefined);
  assert.doesNotMatch(JSON.stringify(f.service.list()), /50150|60150|scope|keyHash|body/i);
  const cancelled = f.service.cancel(scope, applied.ref);
  assert.deepEqual(Object.keys(cancelled), ["status", "ref", "text"]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.service.revokeUser(scope.userId, { persist: true }), true);
  assert.equal(f.service.revokeUser(scope.userId, { persist: "yes" }), false);
  assert.equal(f.service.revokeUser("invalid", { persist: true }), false);
});

test("parent chat scope message metadata is bounded and never stored or delivered", async t => {
  const f = fixture(t);
  const parentScope = { ...scope, messageId: "0", currentMessageId: "-70150" };
  const prepared = f.service.prepare(parentScope, { action: "create", text: "Body", delay_minutes: 2 });
  assert.equal(prepared.status, "ready");
  assert.equal(f.service.commit(parentScope, prepared.operation, { idempotencyKey: "parent-scope" }).status, "applied");
  assert.deepEqual(f.state().rows[0].scope, scope);
  f.now += 2 * MINUTE; await f.service.tick();
  assert.deepEqual(f.deliveries[0].scope, scope);
  assert.doesNotMatch(fs.readFileSync(f.filename, "utf8"), /messageId|currentMessageId|70150/);
  for (const messageId of ["01", "-0", "1".repeat(21), {}, null]) {
    assert.equal(f.service.prepare({ ...scope, messageId }, { action: "create", text: "Body", delay_minutes: 2 }).status, "denied");
  }
  for (const key of ["messageId", "currentMessageId"]) for (const id of [0, -70150, "0", "-70150"]) {
    assert.equal(f.service.prepare({ ...scope, [key]: id }, { action: "create", text: "Body", delay_minutes: 2 }).status, "ready");
  }
});

test("durable sending claim precedes transport and concurrent ticks cannot resend", async t => {
  const entered = deferred(), released = deferred();
  let f, calls = 0;
  f = fixture(t, { deliver: async (job, transport) => {
    calls++;
    assert.equal(f.state().rows[0].state, "sending");
    assert.equal(f.state().rows[0].claimedAt, f.now);
    assert.equal(job.scope.userId, scope.userId);
    assert.equal(job.createdAt, f.state().rows[0].createdAt);
    assert.deepEqual(Object.keys(job), ["ref", "scope", "text", "createdAt", "dueAt"]);
    assert.equal(job.signal, undefined);
    assert.equal(transport.signal.aborted, false);
    assert.ok(Object.isFrozen(transport));
    assert.ok(Object.isFrozen(job)); assert.ok(Object.isFrozen(job.scope));
    entered.resolve(); await released.promise; return { status: "sent", messageId: "synthetic" };
  } });
  const created = create(f); f.now += 2 * MINUTE;
  const first = f.service.tick(); await entered.promise;
  assert.equal(f.service.tick(), first);
  assert.equal(f.service.list(scope).items[0].phase, "sending");
  released.resolve(); assert.equal((await first).delivered, 1);
  assert.equal(f.state().rows[0].state, "sent");
  assert.equal((await f.service.tick()).delivered, 0);
  assert.equal(f.service.list(scope).items[0].ref, created.ref);
  assert.equal(calls, 1);
});

test("all receipt outcomes and throwing/malformed receipts terminate without retries", async t => {
  for (const outcome of ["sent", "failed", "unknown", "partial", "malformed", "throw", "getter"]) {
    let calls = 0, getters = 0;
    const f = fixture(t, { deliver: async () => {
      calls++;
      if (outcome === "throw") throw new Error("private transport detail");
      if (outcome === "getter") return { get status() { getters++; return "sent"; } };
      return { status: outcome, error: "private detail" };
    } });
    create(f); f.now += 2 * MINUTE;
    const result = await f.service.tick(); await f.service.tick();
    assert.equal(result.attempted, 1);
    assert.equal(result.delivered, outcome === "sent" ? 1 : 0);
    assert.equal(f.state().rows[0].state, ["malformed", "throw", "getter"].includes(outcome) ? "unknown" : outcome);
    const replacement = f.restart(); await replacement.tick();
    assert.equal(calls, 1); assert.equal(getters, 0);
    assert.doesNotMatch(JSON.stringify(f.service.list()), /private detail|private transport/);
    await replacement.stop({ drainMs: 0 });
  }
});

test("restart recovers old sending as unknown and never replays it", async t => {
  const f = fixture(t); create(f); f.now += 2 * MINUTE;
  const state = f.state(); state.rows[0].state = "sending"; state.rows[0].claimedAt = f.now; state.updatedAt = f.now; state.revision++;
  writeJsonFileSync(f.filename, state, { durable: true });
  const replacement = f.restart();
  assert.equal((await replacement.tick()).delivered, 0);
  assert.equal(f.state().rows[0].state, "unknown");
  assert.equal(f.deliveries.length, 0);
  await replacement.stop({ drainMs: 0 });
});

test("restart grace is five minutes inclusive; old armed jobs expire without flooding", async t => {
  for (const lateBy of [0, GRACE, GRACE + 1, HORIZON]) {
    const f = fixture(t); create(f); f.now += 2 * MINUTE + lateBy;
    const replacement = f.restart(); await replacement.tick();
    assert.equal(f.state().rows[0].state, lateBy <= GRACE ? "sent" : "expired");
    assert.equal(f.deliveries.length, lateBy <= GRACE ? 1 : 0);
    await replacement.stop({ drainMs: 0 });
  }
});

test("permission revocation and persisted forget cutoff cancel across restart", async t => {
  for (const reason of ["permission", "cutoff"]) {
    const f = fixture(t); create(f);
    if (reason === "permission") f.allowed = false;
    else f.cutoff = f.now;
    f.now += 2 * MINUTE;
    const replacement = f.restart(); await replacement.tick();
    assert.equal(f.state().rows[0].state, "cancelled");
    assert.equal(f.state().rows[0].text, "");
    assert.equal(f.deliveries.length, 0);
    if (reason === "cutoff") assert.equal(f.state().rows[0].scope, null);
    await replacement.stop({ drainMs: 0 });
  }
});

test("unavailable, asynchronous, invalid, or regressed cutoff can never authorize a send", async t => {
  const f = fixture(t); create(f); f.now += 2 * MINUTE;
  for (const cutoff of [null, undefined, -1, Infinity, Promise.resolve(0)]) {
    const replacement = f.restart({ readPrivacyCutoff: () => cutoff });
    await replacement.tick(); assert.equal(f.deliveries.length, 0);
    assert.equal(replacement.prepare(scope, { action: "create", text: "Body", delay_minutes: 2 }).status, "denied");
    await replacement.stop({ drainMs: 0 });
  }
  const g = fixture(t); g.cutoff = g.now - 100; create(g); g.cutoff = 0; g.now += 2 * MINUTE;
  await g.service.tick(); assert.equal(g.state().rows[0].state, "cancelled"); assert.equal(g.deliveries.length, 0);
});

test("guards are rechecked after durable claim before an unstarted transport", async t => {
  let f;
  f = fixture(t, { write: (filename, state, settings) => {
    writeJsonFileSync(filename, state, settings);
    if (state.rows.some(row => row.state === "sending")) f.cutoff = f.now;
  } });
  create(f); f.now += 2 * MINUTE;
  await f.service.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.state().rows[0].state, "cancelled");
});

test("own cancellation is durable, cross-scope cancellation cannot affect another reminder", async t => {
  const f = fixture(t); const created = create(f);
  for (const owner of [otherUser, otherGroup]) assert.equal(f.service.cancel(owner, created.ref).status, "unavailable");
  const prepared = f.service.prepare(scope, { action: "cancel", ref: created.ref });
  assert.equal(prepared.status, "ready");
  assert.equal(f.service.commit(scope, prepared.operation, { idempotencyKey: "cancel-confirmation" }).status, "applied");
  assert.equal(f.state().rows[0].state, "cancelled");
  const replacement = f.restart(); f.now += 2 * MINUTE; await replacement.tick();
  assert.equal(f.deliveries.length, 0);
  assert.equal(replacement.cancel(scope, created.ref).status, "cancelled");
  await replacement.stop({ drainMs: 0 });
});

test("cancelling a terminal send never invents an applied cancellation or rewrites its receipt", async t => {
  for (const outcome of ["sent", "partial", "unknown", "failed"]) {
    const f = fixture(t, { deliver: async () => ({ status: outcome }) });
    const created = create(f); f.now += 2 * MINUTE; await f.service.tick();
    const before = fs.readFileSync(f.filename, "utf8");
    const prepared = f.service.prepare(scope, { action: "cancel", ref: created.ref });
    assert.equal(f.service.commit(scope, prepared.operation, { idempotencyKey: "terminal-cancel" }).status, "not_applied");
    assert.equal(f.service.cancel(scope, created.ref).status, outcome === "failed" ? "unavailable" : "unknown");
    assert.equal(fs.readFileSync(f.filename, "utf8"), before);
    assert.equal(f.state().rows[0].state, outcome);
  }
});

test("cancellation of ignored-signal transport keeps sending and drains actual pending work", async t => {
  const entered = deferred(), released = deferred();
  let signal, calls = 0;
  const f = fixture(t, { deliver: async (_job, transport) => { calls++; signal = transport.signal; entered.resolve(); await released.promise; return { status: "sent" }; } });
  const created = create(f); create(f, "second"); f.now += 2 * MINUTE;
  const tick = f.service.tick(); await entered.promise;
  const cancellation = f.service.cancel(scope, created.ref);
  assert.equal(cancellation.status, "unknown");
  assert.equal(cancellation.text, "\u63d0\u9192\u53ef\u80fd\u6b63\u5728\u53d1\u9001\u6216\u5df2\u53d1\u9001\uff0c\u672a\u91cd\u65b0\u5c1d\u8bd5\u53d1\u9001");
  const cancelReview = f.service.prepare(scope, { action: "cancel", ref: created.ref });
  assert.equal(f.service.commit(scope, cancelReview.operation, { idempotencyKey: "chinese-sending-cancel" }).text,
    "\u5df2\u8bf7\u6c42\u53d6\u6d88\uff0c\u53d1\u9001\u53ef\u80fd\u5df2\u7ecf\u5f00\u59cb");
  assert.equal(f.state().rows[0].state, "sending"); assert.equal(f.state().rows[0].cancelRequested, true);
  assert.equal(signal.aborted, true);
  assert.equal(await f.service.stop({ drainMs: 1 }), false);
  assert.equal(f.service.start().status, "denied");
  assert.equal(f.state().rows[0].state, "sending");
  assert.equal(calls, 1);
  const draining = f.service.stop({ drainMs: 1000 });
  released.resolve(); await tick;
  assert.equal(await draining, true);
  assert.equal(f.state().rows[0].state, "sent");
  assert.equal(f.state().rows[1].state, "armed");
  assert.equal(calls, 1);
});

test("revoke scrubs identity/body, aborts in-flight work, and preserves opaque replay prevention", async t => {
  const entered = deferred(), released = deferred();
  let signal;
  const f = fixture(t, { deliver: async (_job, transport) => { signal = transport.signal; entered.resolve(); await released.promise; return { status: "partial" }; } });
  const operation = prepare(f);
  f.service.commit(scope, operation, { idempotencyKey: "forget-key" }); create(f, "forget-armed");
  f.now += 2 * MINUTE;
  const tick = f.service.tick(); await entered.promise;
  assert.equal(f.service.revokeUser(scope.userId, { persist: true }), true);
  assert.equal(signal.aborted, true);
  assert.equal(await f.service.stop({ drainMs: 1 }), false);
  const serialized = fs.readFileSync(f.filename, "utf8");
  assert.doesNotMatch(serialized, /Synthetic reminder body|50150|60150|forget-key/);
  assert.equal(f.state().rows[0].state, "sending");
  assert.equal(f.state().rows[1].state, "cancelled");
  released.resolve(); await tick;
  assert.equal(await f.service.stop({ drainMs: 10 }), true);
  const replacement = f.restart();
  assert.equal(replacement.commit(scope, operation, { idempotencyKey: "forget-key" }).status, "not_applied");
  assert.equal(f.state().rows[0].state, "partial");
  assert.deepEqual(replacement.list(scope).items, []);
  await replacement.stop({ drainMs: 0 });
});

test("nonpersisting forget is synchronous, scrubs local views, and persisted parent cutoff protects restart", async t => {
  let writes = 0;
  const f = fixture(t, { write: (...args) => { writes++; return writeJsonFileSync(...args); } });
  create(f); const before = fs.readFileSync(f.filename, "utf8");
  assert.equal(f.service.revokeUser(scope.userId, { persist: false }), true);
  assert.equal(writes, 1); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.deepEqual(f.service.list(scope).items, []);
  assert.equal(f.service.list().items[0].phase, "cancelled");
  f.cutoff = f.now; f.now += 2 * MINUTE;
  const replacement = f.restart(); await replacement.tick();
  assert.equal(f.state().rows[0].state, "cancelled"); assert.equal(f.state().rows[0].scope, null);
  assert.equal(f.deliveries.length, 0);
  await replacement.stop({ drainMs: 0 });
});

test("nonpersisting forget retains and aborts actual pending transport until drained", async t => {
  const entered = deferred(), released = deferred(); let writes = 0, signal;
  const f = fixture(t, {
    write: (...args) => { writes++; return writeJsonFileSync(...args); },
    deliver: async (_job, transport) => { signal = transport.signal; entered.resolve(); await released.promise; return { status: "unknown" }; },
  });
  create(f); f.now += 2 * MINUTE; const tick = f.service.tick(); await entered.promise;
  const before = fs.readFileSync(f.filename, "utf8");
  assert.equal(f.service.revokeUser(scope.userId, { persist: false }), true);
  assert.equal(writes, 2); assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  assert.equal(signal.aborted, true); assert.deepEqual(f.service.list(scope).items, []);
  assert.equal(await f.service.stop({ drainMs: 1 }), false);
  const draining = f.service.stop({ drainMs: 1000 }); released.resolve(); await tick;
  assert.equal(await draining, true);
  assert.equal(f.state().rows[0].state, "unknown"); assert.equal(f.state().rows[0].scope, null);
  assert.doesNotMatch(fs.readFileSync(f.filename, "utf8"), /Synthetic reminder body|50150|60150/);
});

test("a second service cannot recover a live ignored-signal transport as interrupted", async t => {
  const entered = deferred(), released = deferred(); let calls = 0;
  const f = fixture(t, { deliver: async () => { calls++; entered.resolve(); await released.promise; return { status: "sent" }; } });
  create(f); f.now += 2 * MINUTE; const tick = f.service.tick(); await entered.promise;
  const replacement = f.restart(); await replacement.tick();
  assert.equal(replacement.list(scope).items[0].phase, "sending"); assert.equal(calls, 1);
  released.resolve(); await tick;
  await replacement.stop({ drainMs: 0 });
});

test("cross-instance cancellation retains the same-owner live transport lock", async t => {
  const entered = deferred(), released = deferred(); let calls = 0, signal;
  const f = fixture(t, { deliver: async (_job, transport) => { calls++; signal = transport.signal; entered.resolve(); await released.promise; return { status: "sent" }; } });
  const first = create(f); create(f, "same-owner-next");
  f.now += 2 * MINUTE; const tick = f.service.tick(); await entered.promise;
  const replacement = f.restart();
  assert.equal(replacement.cancel(scope, first.ref).status, "unknown");
  assert.equal(signal.aborted, true);
  assert.equal((await replacement.tick()).attempted, 0);
  assert.equal(f.state().rows[1].state, "armed"); assert.equal(calls, 1);
  const draining = f.service.stop({ drainMs: 1000 });
  released.resolve(); await tick; assert.equal(await draining, true);
  assert.equal(calls, 1);
  await replacement.stop({ drainMs: 0 });
});

test("corrupt, oversized, invalid-schema and missing-after-seen stores fail closed without empty writes", async t => {
  for (const damage of ["{broken", "x".repeat(256 * 1024 + 1), '{"version":1,"rows":[]}', null]) {
    let writes = 0;
    const f = fixture(t, { write: (...args) => { writes++; return writeJsonFileSync(...args); } });
    create(f); const operation = prepare(f);
    if (damage === null) fs.unlinkSync(f.filename); else fs.writeFileSync(f.filename, damage);
    assert.equal(f.service.commit(scope, operation, { idempotencyKey: "no-empty-rebuild" }).status, "not_applied");
    assert.equal((await f.service.tick()).status, "unavailable");
    assert.equal(f.service.revokeUser(scope.userId, { persist: true }), false);
    assert.equal(writes, 1); assert.equal(f.deliveries.length, 0);
    if (damage !== null) assert.equal(fs.readFileSync(f.filename, "utf8"), damage);
    else assert.equal(fs.existsSync(f.filename), false);
  }
});

test("unknown creation persistence never retries or rolls back old jobs", async t => {
  for (const partial of [false, true]) {
    let writes = 0;
    const f = fixture(t, { write: (filename, state, settings) => {
      writes++; if (writes === 1 || partial) writeJsonFileSync(filename, state, settings);
      if (writes === 2) throw new Error("private persistence detail");
    } });
    create(f); const before = fs.readFileSync(f.filename, "utf8");
    const operation = prepare(f);
    const result = f.service.commit(scope, operation, { idempotencyKey: "unknown-creation" });
    assert.equal(result.status, "unknown"); assert.doesNotMatch(JSON.stringify(result), /private persistence/);
    assert.equal(f.service.commit(scope, operation, { idempotencyKey: "unknown-creation" }).status, "not_applied");
    f.now += 2 * MINUTE; await f.service.tick();
    assert.equal(writes, 2); assert.equal(f.deliveries.length, 0);
    assert.equal(f.state().rows.length, partial ? 2 : 1);
    if (!partial) assert.equal(fs.readFileSync(f.filename, "utf8"), before);
  }
});

test("failed sending-claim write cannot start transport, including partial persistence", async t => {
  for (const partial of [false, true]) {
    let writes = 0;
    const f = fixture(t, { write: (filename, state, settings) => {
      writes++; if (writes === 1 || partial) writeJsonFileSync(filename, state, settings);
      if (writes === 2) throw new Error("claim failure");
    } });
    create(f); f.now += 2 * MINUTE;
    assert.equal((await f.service.tick()).status, "unknown");
    await f.service.tick(); assert.equal(f.deliveries.length, 0); assert.equal(writes, 2);
    assert.equal(f.state().rows[0].state, partial ? "sending" : "armed");
    if (partial) {
      const replacement = f.restart({ write: writeJsonFileSync }); await replacement.tick();
      assert.equal(f.state().rows[0].state, "unknown"); assert.equal(f.deliveries.length, 0);
      await replacement.stop({ drainMs: 0 });
    }
  }
});

test("terminal receipt-save failure becomes unknown and cannot cause a second send", async t => {
  let writes = 0;
  const f = fixture(t, { write: (filename, state, settings) => {
    writes++; if (writes === 3) throw new Error("receipt failure");
    return writeJsonFileSync(filename, state, settings);
  } });
  create(f); f.now += 2 * MINUTE;
  assert.equal((await f.service.tick()).status, "unknown");
  assert.equal(f.deliveries.length, 1); assert.equal(f.state().rows[0].state, "sending");
  assert.equal(await f.service.stop({ drainMs: 0 }), true);
  const replacement = f.restart({ write: writeJsonFileSync }); await replacement.tick();
  assert.equal(f.state().rows[0].state, "unknown"); assert.equal(f.deliveries.length, 1);
  await replacement.stop({ drainMs: 0 });
});

test("silent no-op writers and unverifiable persistence cannot acknowledge or deliver", async t => {
  const f = fixture(t, { write: () => undefined });
  const result = f.service.commit(scope, prepare(f), { idempotencyKey: "noop" });
  assert.equal(result.status, "unknown"); assert.equal(fs.existsSync(f.filename), false);
  assert.equal((await f.service.tick()).status, "unavailable"); assert.equal(f.deliveries.length, 0);
});

test("claim lock cleanup failure cannot authorize delivery after a successful rename", async t => {
  const f = fixture(t, { write: (filename, state, settings) => {
    writeJsonFileSync(filename, state, settings);
    if (state.rows.some(row => row.state === "sending")) fs.unlinkSync(`${filename}.lock`);
  } });
  create(f); f.now += 2 * MINUTE;
  assert.equal((await f.service.tick()).status, "unknown");
  assert.equal(f.state().rows[0].state, "sending");
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.service.tick()).status, "unavailable");
});

test("recovery persistence failure cannot dispatch other armed reminders", async t => {
  const f = fixture(t); create(f); create(f, "armed-after-recovery"); f.now += 2 * MINUTE;
  const state = f.state(); state.rows[0].state = "sending"; state.rows[0].claimedAt = f.now;
  state.updatedAt = f.now; state.revision++; writeJsonFileSync(f.filename, state, { durable: true });
  const replacement = f.restart({ write: () => { throw new Error("recovery failure"); } });
  assert.equal((await replacement.tick()).status, "unknown");
  assert.equal(f.deliveries.length, 0); assert.equal(f.state().rows[1].state, "armed");
  await replacement.stop({ drainMs: 0 });
});

test("failed forget persistence still aborts and drains the real ignored-signal transport", async t => {
  const entered = deferred(), released = deferred(); let writes = 0, signal;
  const f = fixture(t, {
    write: (filename, state, settings) => { writes++; if (writes === 3) throw new Error("forget failure"); return writeJsonFileSync(filename, state, settings); },
    deliver: async (_job, transport) => { signal = transport.signal; entered.resolve(); await released.promise; return { status: "unknown" }; },
  });
  create(f); f.now += 2 * MINUTE; const tick = f.service.tick(); await entered.promise;
  assert.equal(f.service.revokeUser(scope.userId, { persist: true }), false); assert.equal(signal.aborted, true);
  assert.equal(await f.service.stop({ drainMs: 1 }), false);
  const draining = f.service.stop({ drainMs: 1000 }); released.resolve(); await tick;
  assert.equal(await draining, true); assert.equal(writes, 3);
  const replacement = f.restart({ write: writeJsonFileSync, readPrivacyCutoff: () => f.now });
  await replacement.tick(); assert.equal(f.state().rows[0].state, "unknown");
  assert.deepEqual(replacement.list(scope).items, []);
  await replacement.stop({ drainMs: 0 });
});

test("asynchronous and throwing permission callbacks default to denial", async t => {
  const f = fixture(t);
  for (const isPermitted of [() => Promise.resolve(true), () => { throw new Error("permission failure"); }, () => 1]) {
    const replacement = f.restart({ isPermitted });
    assert.equal(replacement.prepare(scope, { action: "create", text: "Body", delay_minutes: 2 }).status, "denied");
    assert.equal(fs.existsSync(f.filename), false);
    await replacement.stop({ drainMs: 0 });
  }
});

test("backward clocks and state rollback fail closed", async t => {
  const f = fixture(t); const created = create(f); const old = f.state();
  f.service.cancel(scope, created.ref); writeJsonFileSync(f.filename, old, { durable: true });
  assert.equal((await f.service.tick()).status, "unavailable"); assert.equal(f.deliveries.length, 0);
  const g = fixture(t); create(g); g.now--;
  assert.equal((await g.service.tick()).status, "unavailable"); assert.equal(g.deliveries.length, 0);
});

test("exclusive durable mutation lock denies concurrent writes without deleting another lock", t => {
  const f = fixture(t); create(f);
  fs.writeFileSync(`${f.filename}.lock`, "synthetic other writer");
  assert.equal(f.service.commit(scope, prepare(f), { idempotencyKey: "lock-conflict" }).status, "not_applied");
  assert.equal(f.state().rows.length, 1);
  assert.equal(fs.readFileSync(`${f.filename}.lock`, "utf8"), "synthetic other writer");
});

test("timer startup is idempotent and stop drains an immediate tick", async t => {
  const f = fixture(t); create(f); f.now += 2 * MINUTE;
  assert.equal(f.service.start().status, "started"); assert.equal(f.service.start().status, "started");
  assert.equal(await f.service.stop({ drainMs: 1000 }), true);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.state().rows[0].state, "armed");
});
