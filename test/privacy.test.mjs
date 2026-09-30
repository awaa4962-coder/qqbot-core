import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSensitiveText, redactSensitiveText } from "../bridge/privacy.mjs";

test("validated sender and signed message attribution survive numeric privacy redaction", () => {
  for (const id of ["13800138000", "123456789012345", "123456789012345678"]) {
    const label = "消息发送人 uid=" + id + "，message_id=-" + id;
    assert.equal(redactSensitiveText(label), label);
    for (const field of ["message_id", "messageId", "replyToMessageId", "turn_id"]) {
      const text = JSON.stringify({ [field]: "-" + id });
      assert.equal(redactSensitiveText(text), text);
    }
  }
});

test("signed message attribution never exempts plain personal numbers or credential values", () => {
  const id = "13800138000";
  for (const text of ["phone=-" + id, "uid=-" + id, "qq=-" + id, "message_id=--" + id,
    "other_message_id=-" + id, "message_id=-" + id + ".5", "message_id=-12345678901234567X",
    "token=message_id=-" + id, "password=uid=" + id]) {
    assert.match(redactSensitiveText(text), /\[REDACTED\]/);
    assert.notEqual(redactSensitiveText(text), text);
  }
});

test("redacts credential fields, JSON strings and bearer credentials", () => {
  const input = JSON.stringify({ api_key: "synthetic-key", password: 'escaped"secret', accessToken: "synthetic-token" });
  const result = redactSensitiveText(input);
  assert.deepEqual(JSON.parse(result), { api_key: "[REDACTED]", password: "[REDACTED]", accessToken: "[REDACTED]" });
  assert.equal(containsSensitiveText(input), true);
  assert.doesNotMatch(redactSensitiveText("token=synthetic-value Authorization: Bearer synthetic-value sk-audit_not_a_real_key"), /synthetic-value|sk-audit/);
  assert.equal(containsSensitiveText(result), false);
  assert.equal(redactSensitiveText(result), result);
});

test("redacts personal numbers without destroying explicit attribution IDs", () => {
  const input = 'uid=13800138000 qq=13800138000 {"user_id":"13800138000","groupId":13800138000,"message_id":"123456789012345678"} phone=13800138000 identity=123456789012345678';
  const result = redactSensitiveText(input);
  assert.match(result, /uid=13800138000 qq=13800138000/);
  assert.match(result, /"groupId":13800138000/);
  assert.match(result, /"message_id":"123456789012345678"/);
  assert.match(result, /phone=\[REDACTED\] identity=\[REDACTED\]/);
  assert.equal(containsSensitiveText("ordinary archive discussion"), false);
});
