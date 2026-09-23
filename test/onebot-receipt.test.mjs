import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOneBotReceipt, isOneBotResponseSuccessful } from "../bridge/onebot-receipt.mjs";
import { isSuccessfulOutbound } from "../bridge/cognition/outcome.mjs";
import { sendTextToGroup } from "../bridge/outbound-message.mjs";
import { fetchReplyData, getGroupMemberInfo } from "../bridge/napcat.mjs";
import { postNapCat } from "../bridge/features/stickers/napcat-adapter.mjs";

test("OneBot receipt classification preserves compatible successes without contradictions", () => {
  for (const value of [{ status: "ok", retcode: 0 }, { status: "ok" }, { retcode: "0" }, { data: { message_id: -12 } }]) {
    assert.equal(classifyOneBotReceipt(value), "sent");
  }
  for (const value of [{ status: "failed", retcode: 100 }, { status: "failed" }, { retcode: -1 }]) {
    assert.equal(classifyOneBotReceipt(value), "failed");
  }
  assert.equal(classifyOneBotReceipt({ status: "cancelled" }), "cancelled");
  assert.equal(isOneBotResponseSuccessful({ data: { message_id: 12 } }), false);
});

test("read APIs do not consume data from contradictory responses", async t => {
  for (const [ok, receipt] of [[true, { status: "failed", retcode: 0 }], [true, { status: "async", retcode: 1 }],
    [true, { status: "ok", retcode: false }], [false, { status: "ok", retcode: 0 }]]) {
    const data = { message: [{ type: "text", data: { text: "rejected synthetic quote" } }], user_id: 123, card: "rejected card" };
    const fetchImpl = async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ ...receipt, data }) });
    t.mock.method(globalThis, "fetch", fetchImpl);
    assert.deepEqual(await fetchReplyData({ id: 1 }), { text: "", images: [] });
    assert.equal(await getGroupMemberInfo(123, 456), null);
    const response = await postNapCat("fetch_custom_face", {}, { fetchImpl });
    assert.equal(response.ok, false);
    assert.equal(response.data, null);
    t.mock.restoreAll();
  }
});

test("confirmed reply lookup supports message id zero without losing attribution", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.match(String(url), /message_id=0$/);
    return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: {
      message: [{ type: "text", data: { text: "synthetic quote" } }], user_id: 123, sender: { nickname: "synthetic actor" },
    } }) };
  });
  assert.deepEqual(await fetchReplyData({ id: 0 }), { text: "synthetic quote", images: [], userId: "123", nickname: "synthetic actor" });
});

test("conflicting, async and malformed receipts remain unknown even when an id exists", () => {
  for (const value of [
    { status: "failed", retcode: 0 }, { status: "ok", retcode: 100 },
    { status: "failed", retcode: 100, data: { message_id: 12 } },
    { status: "async", retcode: 1, data: { message_id: 12 } }, { status: "failed", retcode: 1 },
    { status: "ok", retcode: false }, { status: "ok", retcode: "0junk" },
    { status: "ok", retcode: null }, { status: "ok", retcode: "" },
    { status: "unknown", retcode: 0 }, { status: "ok", delivery: "unconfirmed" }, null, [], {},
  ]) {
    assert.equal(classifyOneBotReceipt(value), "unknown", JSON.stringify(value));
    assert.equal(isSuccessfulOutbound(value), false);
  }
});

test("ambiguous receipt stops long sending and cannot be retried as a failure", async () => {
  const original = globalThis.fetch;
  try {
    for (const receipt of [{ status: "failed", retcode: 0 }, { status: "async", retcode: 1 }, { status: "ok", retcode: 100 }]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return { ok: true, json: async () => receipt }; };
      const result = await sendTextToGroup({ groupId: 123, text: "synthetic text ".repeat(200), retryDelayMs: 0 });
      assert.equal(calls, 1);
      assert.deepEqual(result, { status: "unknown", delivery: "unconfirmed" });
    }
  } finally { globalThis.fetch = original; }
});
