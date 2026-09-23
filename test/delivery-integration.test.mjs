import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { URL } from "node:url";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-delivery-integration-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { processEvent } = await import("../bridge/reply.mjs");
const { chatDeliveryLedger } = await import("../bridge/cognition/delivery-ledger.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { forgetUserData } = await import("../bridge/user-preferences.mjs");
const { isCommandContext } = await import("../bridge/commands/action-dispatcher.mjs");
CFG.groupWhitelist = [98101]; CFG.friendWhitelist = [98102]; CFG.botBlacklist = [];
function event(id, text, extra = {}) {
  return { post_type: "message", message_type: "private", user_id: 98102, message_id: id, time: Math.floor(Date.now() / 1000) + 1,
    raw_message: text, message: [{ type: "text", data: { text } }], sender: { nickname: "synthetic" }, ...extra };
}
async function admin(method, payload, authorized = true, remoteAddress = "127.0.0.1") {
  const url = new URL("http://localhost/admin/diagnose/deliveries");
  const req = Readable.from([Buffer.from(JSON.stringify(payload || {}))]);
  Object.assign(req, { method, url: url.pathname, headers: authorized ? { "x-qqfriend-admin-token": "synthetic-token" } : {}, socket: { remoteAddress } });
  let response;
  await handleAdminApiRequest(req, {}, { pathname: url.pathname, url, requiredToken: "synthetic-token", sendJson(_res, code, body) { response = { code, body }; } });
  return response;
}

test("actual router drops durable duplicates before generation or history observation", async t => {
  const ledger = chatDeliveryLedger();
  const ticket = ledger.claim({ surface: "group", userId: 98102, groupId: 98101, messageId: 1 });
  ledger.attempt(ticket.key); ledger.finish(ticket.key, "reply");
  const before = JSON.stringify({ users, groupChats });
  t.mock.method(globalThis, "fetch", () => assert.fail("duplicate must not call model, member lookup or QQ"));
  const result = await processEvent(event(1, "synthetic repeated input", { message_type: "group", group_id: 98101 }));
  assert.equal(result.reason, "reply_duplicate");
  assert.equal(JSON.stringify({ users, groupChats }), before);
});

test("command classification uses the existing registry without bypassing mention rules", () => {
  for (const text of ["help", "忘记我", "jm 123456"]) {
    assert.equal(isCommandContext({ message_type: "private", text }), true);
    assert.equal(isCommandContext({ message_type: "group", text, isAtMe: false }), false);
    assert.equal(isCommandContext({ message_type: "group", text, isAtMe: true }), true);
  }
  assert.equal(isCommandContext({ message_type: "private", text: "ordinary synthetic chat" }), false);
});

test("delivery administration is guarded and manual verification never sends", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("manual verification is metadata only"));
  for (const method of ["GET", "POST"]) {
    assert.equal((await admin(method, {}, false)).code, 403);
    assert.equal((await admin(method, {}, true, "203.0.113.8")).code, 403);
  }
  const before = await admin("GET");
  assert.equal(before.code, 200);
  const item = before.body.items.find(row => row.status === "unknown");
  assert.ok(item);
  assert.equal((await admin("POST", { id: item.id, action: "resend" })).code, 400);
  const after = await admin("POST", { id: item.id, action: "confirm-not-delivered" });
  assert.equal(after.code, 200);
  assert.equal(after.body.items.find(row => row.id === item.id).resolution, "checked_not_delivered");
  assert.equal(chatDeliveryLedger().claim({ surface: "group", userId: 98102, groupId: 98101, messageId: 1 }).ok, false);
});

test("corrupt chat delivery storage does not disable help, JM classification or privacy erasure", async t => {
  const filename = path.join(CFG.dataRoot, ".qqfriend", "chat-delivery.json");
  fs.writeFileSync(filename, "synthetic corrupt state");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).endsWith("/send_private_msg"), "no model work on corrupt state");
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  assert.equal((await processEvent(event(2, "help"))).route, "private");
  assert.equal(calls.length, 1);
  assert.equal((await processEvent(event(3, "ordinary synthetic chat"))).reason, "delivery_state_unavailable");
  users[98102] = { chats: [{ text: "synthetic personal text" }], description: "synthetic old profile" };
  const result = forgetUserData(98102);
  assert.equal(result.ok, false);
  assert.match(result.text, /身份关联暂时无法清理/);
  assert.deepEqual(users[98102].chats, []);
  assert.equal(users[98102].description, "");
  assert.equal((await admin("GET")).body.health, "degraded");
  assert.equal(fs.readFileSync(filename, "utf8"), "synthetic corrupt state");
});
