import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createChatDeliveryLedger, inspectChatEvent } from "../bridge/cognition/delivery-ledger.mjs";
import { withChatRun, noteChatOutcome, chatRunSignal } from "../bridge/cognition/chat-run.mjs";
import { sendTextToGroup } from "../bridge/outbound-message.mjs";
import { writeJsonFileSync } from "../bridge/persistence/json-file.mjs";
import { CFG } from "../bridge/config.mjs";

const scope = { surface: "group", userId: 12345678, groupId: 23456789, messageId: 34567890, eventTime: 1000 };
const cfg = { ...CFG, groupWhitelist: [scope.groupId], friendWhitelist: [], botBlacklist: [] };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "state.json");
  return { filename, ledger: createChatDeliveryLedger({ filename, ...options }) };
}
function confirm(ledger, key) { ledger.attempt(key); ledger.receipt(key, "sent"); }

test("delivery journal is content-free, scoped and duplicate-resistant across managers", t => {
  const { filename, ledger } = fixture(t);
  const ticket = ledger.claim({ ...scope, text: "private synthetic body", reasoning_content: "private reasoning" });
  confirm(ledger, ticket.key); ledger.finish(ticket.key, "reply");
  const restarted = createChatDeliveryLedger({ filename });
  assert.equal(restarted.find(scope).status, "sent");
  assert.deepEqual(restarted.claim(scope), { ok: false, reason: "reply_duplicate" });
  for (const other of [{ ...scope, userId: 9 }, { ...scope, groupId: 9 }, { ...scope, surface: "private" }]) assert.equal(restarted.claim(other).ok, true);
  const raw = fs.readFileSync(filename, "utf8");
  for (const privateValue of [scope.userId, scope.groupId, scope.messageId, "private synthetic body", "private reasoning"]) assert.ok(!raw.includes(String(privateValue)));
  const item = restarted.snapshot().items[0];
  for (const hidden of ["salt", "actorHash", "scopeHash", "userId", "groupId", "messageId"]) assert.equal(item[hidden], undefined);
});

test("a real process exit retains pending, partial and interrupted boundaries", t => {
  const { filename } = fixture(t);
  const moduleUrl = new URL("../bridge/cognition/delivery-ledger.mjs", import.meta.url).href;
  const script = `import { createChatDeliveryLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = createChatDeliveryLedger({filename: ${JSON.stringify(filename)}});
    const scope = ${JSON.stringify(scope)};
    const a = ledger.claim(scope); ledger.attempt(a.key);
    const b = ledger.claim({...scope, messageId: 2}); ledger.attempt(b.key); ledger.receipt(b.key, 'sent');
    ledger.claim({...scope, messageId: 3}); process.exit(0);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const restarted = createChatDeliveryLedger({ filename });
  assert.equal(restarted.find(scope).status, "unknown");
  assert.equal(restarted.find({ ...scope, messageId: 2 }).status, "partial");
  assert.equal(restarted.find({ ...scope, messageId: 3 }).status, "interrupted");
  assert.equal(restarted.claim(scope).ok, false);
});

test("terminal states distinguish silent, rejected, cancelled and partial replies", t => {
  const { ledger } = fixture(t);
  const cases = [
    { outcome: "silence", expected: "silent" },
    { outcome: "error", expected: "failed" },
    { cancel: true, expected: "cancelled" },
    { sent: true, cancel: true, expected: "partial" },
    { sent: true, outcome: "error", expected: "partial" },
    { sent: true, reject: true, expected: "partial" },
    { unknown: true, expected: "unknown" },
  ];
  for (const [index, item] of cases.entries()) {
    const request = { ...scope, messageId: index + 1 };
    const { key } = ledger.claim(request);
    if (item.sent) confirm(ledger, key);
    if (item.reject) ledger.reject(key);
    if (item.unknown) { ledger.attempt(key); ledger.receipt(key, "unknown"); }
    ledger.finish(key, item.outcome, item.cancel);
    assert.equal(ledger.find(request).status, item.expected);
  }
});

test("expiry removes terminal records only and unresolved capacity fails closed", t => {
  let now = 1000;
  const { filename, ledger } = fixture(t, { now: () => now, maxRecords: 2 });
  assert.equal(ledger.cleanup(), 0);
  assert.equal(fs.existsSync(filename), false);
  const sent = ledger.claim(scope); confirm(ledger, sent.key); ledger.finish(sent.key, "reply");
  const unknownScope = { ...scope, messageId: 2 };
  const unknown = ledger.claim(unknownScope); ledger.attempt(unknown.key); ledger.finish(unknown.key, "reply");
  assert.throws(() => ledger.claim({ ...scope, messageId: 3 }), /delivery_capacity/);
  now += 86400001;
  assert.equal(ledger.cleanup(), 1);
  assert.equal(ledger.find(scope), null);
  assert.equal(ledger.find(unknownScope).status, "unknown");
  ledger.resolve(unknown.key, false);
  assert.equal(ledger.claim(unknownScope).ok, false);
  now += 86400001;
  assert.equal(ledger.cleanup(), 1);
});

test("manual verification never clears the replay fence or resolves active requests", t => {
  const { ledger } = fixture(t);
  const { key } = ledger.claim(scope);
  assert.throws(() => ledger.resolve(key, true), /仍在处理/);
  ledger.attempt(key); ledger.finish(key, "reply");
  ledger.resolve(key, true);
  assert.equal(ledger.find(scope).status, "resolved");
  assert.equal(ledger.find(scope).resolution, "checked_delivered");
  assert.equal(ledger.claim(scope).ok, false);
  assert.throws(() => ledger.resolve(key, false), /不需要核实/);
});

test("forget unlinks identity while late receipts retain the negative event fence", t => {
  const { filename, ledger } = fixture(t);
  const { key } = ledger.claim(scope); ledger.attempt(key);
  assert.equal(ledger.forget(scope.userId), 1);
  ledger.receipt(key, "sent"); ledger.finish(key, "reply", true);
  const row = JSON.parse(fs.readFileSync(filename, "utf8")).records[key];
  assert.equal(row.actorHash, ""); assert.equal(row.scopeHash, "");
  assert.equal(ledger.snapshot({ userId: scope.userId }).total, 0);
  assert.equal(ledger.snapshot({ groupId: scope.groupId }).total, 0);
  assert.equal(ledger.claim(scope).ok, false);
});

test("corrupt JSON and malformed schema never reset existing delivery evidence", t => {
  const { filename } = fixture(t);
  for (const raw of ["broken", "null", "false", "0", "[]", '{"schema":1,"salt":"x","records":{}}']) {
    fs.writeFileSync(filename, raw);
    const ledger = createChatDeliveryLedger({ filename });
    assert.throws(() => ledger.claim(scope));
    assert.throws(() => ledger.snapshot());
    assert.equal(fs.readFileSync(filename, "utf8"), raw);
  }
});

test("erasure and stale events are rejected before the history pipeline", t => {
  const { ledger } = fixture(t);
  const event = { message_type: "group", user_id: scope.userId, group_id: scope.groupId, message_id: scope.messageId, eventTime: 1000 };
  const options = { ledger, now: 1001, readPrivacy: () => ({ users: { [scope.userId]: 1000 } }) };
  assert.equal(inspectChatEvent(event, options), "forgotten_event");
  assert.equal(inspectChatEvent({ ...event, eventTime: 0 }, options), "forgotten_event");
  assert.equal(inspectChatEvent({ ...event, eventTime: 1001 }, options), "");
  const fresh = { ...options, now: 86401001, readPrivacy: () => ({ users: {} }) };
  assert.equal(inspectChatEvent(event, fresh), "stale_event");
  ledger.claim(scope);
  assert.equal(inspectChatEvent({ ...event, eventTime: fresh.now }, fresh), "reply_duplicate");
});

test("missing event ids stay compatible without creating a persistence file", t => {
  const { filename, ledger } = fixture(t);
  assert.deepEqual(ledger.claim({ ...scope, messageId: undefined }), { ok: true, key: "" });
  assert.equal(fs.existsSync(filename), false);
  assert.throws(() => ledger.claim({ ...scope, messageId: {} }), /delivery_invalid_source/);
  for (const invalid of [{ ...scope, surface: "other" }, { ...scope, userId: null }, { ...scope, groupId: {} }]) assert.throws(() => ledger.claim(invalid), /delivery_invalid_scope/);
  assert.equal(fs.existsSync(filename), false);
});

test("duplicate arrival does not supersede the original active generation", async t => {
  const { ledger } = fixture(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let signal;
  const first = withChatRun(scope, async () => { signal = chatRunSignal(); noteChatOutcome({ kind: "silence" }); await pending; return "first"; }, { cfg, ledger });
  try {
    const duplicate = await withChatRun(scope, () => assert.fail("no repeated work"), { cfg, ledger });
    assert.equal(duplicate.reason, "reply_duplicate");
    assert.equal(signal.aborted, false);
  } finally { release(); }
  assert.equal(await first, "first");
  assert.equal(ledger.find(scope).status, "silent");
});

test("journal claim and pre-send write failures prevent network work", async t => {
  for (const failureWrite of [1, 2]) {
    const { filename } = fixture(t);
    let writes = 0;
    const ledger = createChatDeliveryLedger({ filename, write(value) {
      if (++writes === failureWrite) throw new Error("synthetic disk failure");
      writeJsonFileSync(filename, value, { durable: true });
    } });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
    const result = await withChatRun(scope, () => sendTextToGroup({ groupId: scope.groupId, text: "synthetic" }), { cfg, ledger });
    assert.equal(result.reason, "delivery_state_unavailable");
    assert.equal(calls, 0);
    t.mock.restoreAll();
  }
});

test("receipt persistence failure remains unknown and never retries or sends later chunks", async t => {
  const { filename } = fixture(t);
  let writes = 0;
  const ledger = createChatDeliveryLedger({ filename, write(value) {
    if (++writes === 3) throw new Error("synthetic receipt failure");
    writeJsonFileSync(filename, value, { durable: true });
  } });
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => { sends++; return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) }; });
  const result = await withChatRun(scope, () => sendTextToGroup({ groupId: scope.groupId, text: "a".repeat(1900), retryDelayMs: 0 }), { cfg, ledger });
  assert.equal(result.reason, "delivery_state_unavailable");
  assert.equal(sends, 1);
  assert.equal(ledger.find(scope).status, "unknown");
  assert.equal(ledger.find(scope).uncertain, 1);
});

test("confirmed retryable rejection can retry, but does not count as an extra delivery", async t => {
  const { ledger } = fixture(t);
  let sends = 0;
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ++sends === 1 ? { status: "failed", retcode: 100 } : { status: "ok", retcode: 0 } }));
  await withChatRun(scope, async () => {
    noteChatOutcome({ kind: "reply" });
    await sendTextToGroup({ groupId: scope.groupId, text: "synthetic", retryDelayMs: 0 });
  }, { cfg, ledger });
  const result = ledger.find(scope);
  assert.equal(result.status, "sent"); assert.equal(result.attempts, 2); assert.equal(result.confirmed, 1);
  const duplicate = await withChatRun(scope, () => assert.fail("no model on duplicate"), { cfg, ledger });
  assert.equal(duplicate.reason, "reply_duplicate");
});
