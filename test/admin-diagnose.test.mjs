import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { URL } from "node:url";

import {
  buildReplyDiagnosis,
  handleAdminApiRequest,
  normalizeDiagnosticEvent,
} from "../bridge/admin-api/index.mjs";

test("reply diagnosis detects mentioned group command", () => {
  const diagnosis = buildReplyDiagnosis({
    message_type: "group",
    group_id: 1000000002,
    user_id: 123456,
    message: [
      { type: "at", data: { qq: "1000000006" } },
      { type: "text", data: { text: " help" } },
    ],
    raw_message: "[CQ:at,qq=1000000006] help",
  });

  assert.equal(diagnosis.safety.callsModel, false);
  assert.equal(diagnosis.gates.allowed, true);
  assert.equal(diagnosis.mentions.isAtMe, true);
  assert.equal(diagnosis.command.known, true);
  assert.equal(diagnosis.replyPlan.action, "command_reply");
});

test("reply diagnosis follows specialized group command routes", () => {
  const cases = [
    ["jm 123456", "jm"],
    ["download https://example.com/a.zip", "resource_transfer"],
    ["preview https://example.com", "link_preview"],
    ["wordcloud", "wordcloud"],
  ];
  for (const [text, route] of cases) {
    const diagnosis = buildReplyDiagnosis({
      message_type: "group",
      group_id: 1000000002,
      user_id: 123456,
      message: [
        { type: "at", data: { qq: "1000000006" } },
        { type: "text", data: { text: " " + text } },
      ],
      raw_message: "[CQ:at,qq=1000000006] " + text,
    });
    assert.equal(diagnosis.command.route, route);
    assert.equal(diagnosis.replyPlan.action, "command_reply");
    assert.equal(diagnosis.replyPlan.reason, route);
  }
});

test("reply diagnosis explains non-whitelisted group block", () => {
  const diagnosis = buildReplyDiagnosis({
    message_type: "group",
    group_id: 999999999,
    user_id: 123456,
    text: "@夜星 help",
  });

  assert.equal(diagnosis.gates.allowed, false);
  assert.ok(diagnosis.gates.blockedReasons.includes("group_not_whitelisted"));
  assert.equal(diagnosis.replyPlan.action, "ignore");
});

test("reply diagnosis allows admin private commands without friend whitelist", () => {
  const diagnosis = buildReplyDiagnosis({
    message_type: "private",
    user_id: 1000000010,
    text: "runtime",
  }, {
    cfg: {
      selfUin: 1000000006,
      botNames: ["夜星", "QQFriend"],
      groupWhitelist: [],
      friendWhitelist: [],
      botBlacklist: [],
      adminUins: ["1000000010"],
    },
  });

  assert.equal(diagnosis.gates.admin, true);
  assert.equal(diagnosis.gates.allowed, true);
  assert.equal(diagnosis.command.known, true);
  assert.equal(diagnosis.replyPlan.action, "command_reply");
});

test("normalizeDiagnosticEvent accepts simplified messages", () => {
  const event = normalizeDiagnosticEvent({
    groupId: 1000000002,
    userId: 1,
    text: "hello",
  });
  assert.equal(event.message_type, "group");
  assert.equal(event.group_id, 1000000002);
  assert.deepEqual(event.message, [{ type: "text", data: { text: "hello" } }]);
});

test("admin diagnose route returns dry-run payload", async () => {
  const writes = [];
  const req = Readable.from([Buffer.from(JSON.stringify({
    message_type: "group",
    group_id: 1000000002,
    user_id: 123456,
    text: "普通聊天",
  }))]);
  Object.assign(req, {
    method: "POST",
    url: "/admin/diagnose/reply",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  });

  const handled = await handleAdminApiRequest(req, {}, {
    pathname: "/admin/diagnose/reply",
    url: new URL("http://localhost/admin/diagnose/reply"),
    sendJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    },
  });

  assert.equal(handled, true);
  assert.equal(writes[0].statusCode, 200);
  assert.equal(writes[0].payload.dryRun, true);
  assert.equal(writes[0].payload.safety.sendsMessage, false);
});
