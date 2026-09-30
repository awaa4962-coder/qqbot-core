import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "qqfriend-p5-recipient-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"),
  QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") });
const { withChatRun, noteChatOutcome } = await import("../bridge/cognition/chat-run.mjs");
const { createChatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const { sendTextToGroup, sendTextToPrivate, sendGroupMessagePayload } = await import("../bridge/outbound-message.mjs");
const { withMessageTrace, createTraceRecorder } = await import("../bridge/diagnostics/message-trace.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");
const cfg = { groupWhitelist: [50100, 50101], friendWhitelist: [60100, 60101], botBlacklist: [], selfUin: 70100 };
const baseScope = { surface: "group", groupId: 50100, userId: 60100 };
let event = 80000;
after(() => { cleanupLogger(); assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
function fixture(t, scope) {
  const current = { ...scope, messageId: ++event };
  const ledger = createChatDeliveryLedger({ filename: path.join(root, "ledger-" + event + ".json") });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 90000 + bodies.length } }) };
  });
  return { current, ledger, bodies };
}
for (const scenario of [
  { id: "other-group", scope: baseScope, send: () => sendTextToGroup({ groupId: 50101, text: "synthetic" }) },
  { id: "group-to-private", scope: baseScope, send: () => sendTextToPrivate({ userId: 60100, text: "synthetic" }) },
  { id: "other-private-user", scope: { surface: "private", userId: 60100 }, send: () => sendTextToPrivate({ userId: 60101, text: "synthetic" }) },
  { id: "private-to-group", scope: { surface: "private", userId: 60100 }, send: () => sendTextToGroup({ groupId: 50100, text: "synthetic" }) },
  { id: "preview-other-group", scope: { ...baseScope, lane: "preview" }, send: () => sendTextToGroup({ groupId: 50101, text: "synthetic" }) },
]) test("active response rejects recipient mismatch before ledger attempt: " + scenario.id, async t => {
  const f = fixture(t, scenario.scope);
  const result = await withChatRun(f.current, async () => { noteChatOutcome({ kind: "reply" }); return scenario.send(); }, { cfg, ledger: f.ledger });
  assert.equal(result.kind, "cancelled"); assert.equal(result.reason, "recipient_mismatch");
  assert.equal(f.bodies.length, 0); assert.equal(f.ledger.find(f.current).attempts, 0);
  assert.equal(f.ledger.find(f.current).status, "cancelled");
});
test("correct same-scope chunks retain receipts and emit only a verified-target boolean", async t => {
  const f = fixture(t, baseScope), recorder = createTraceRecorder();
  await withMessageTrace({ message_type: "group", group_id: 50100, user_id: 60100, message_id: f.current.messageId }, () =>
    withChatRun(f.current, async () => {
      noteChatOutcome({ kind: "reply" }); return sendTextToGroup({ groupId: "50100", text: "x".repeat(1900) });
    }, { cfg, ledger: f.ledger }), recorder);
  assert.equal(f.bodies.length, 3); assert.ok(f.bodies.every(body => body.group_id === "50100"));
  assert.equal(f.ledger.find(f.current).confirmed, 3);
  const trace = recorder.list().items[0];
  const attempts = trace.stages.filter(stage => stage.stage === "send" && stage.status === "started");
  assert.equal(attempts.length, 3); assert.ok(attempts.every(stage => stage.recipientVerified === true));
  assert.doesNotMatch(JSON.stringify(trace.stages), /synthetic|group_id|user_id|xxxx/);
});
test("mutable stop guard cannot redirect the encoded message after origin binding", async t => {
  const f = fixture(t, baseScope), payload = { group_id: 50100, message: [{ type: "text", data: { text: "synthetic" } }] };
  const result = await withChatRun(f.current, () => sendGroupMessagePayload(payload, "fixture", {
    stopReason: () => { payload.group_id = 50101; return ""; },
  }), { cfg, ledger: f.ledger });
  assert.equal(result.reason, "recipient_mismatch"); assert.equal(f.bodies.length, 0);
});
test("business-command lane preserves its independently checked authorized target", async t => {
  const f = fixture(t, { ...baseScope, lane: "command" });
  await withChatRun(f.current, () => sendTextToGroup({ groupId: 50101, text: "synthetic cross-group report",
    stopReason: () => cfg.groupWhitelist.includes(50101) ? "" : "permission_changed" }), { cfg, ledger: f.ledger });
  assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].group_id, 50101);
  assert.equal(f.ledger.find(f.current).status, "sent");
});
test("independent business sender without a chat run retains existing contract", async t => {
  const f = fixture(t, baseScope);
  const result = await sendTextToPrivate({ userId: 60101, text: "synthetic standalone business response" });
  assert.equal(result.status, "ok"); assert.equal(f.bodies[0].user_id, 60101);
});
