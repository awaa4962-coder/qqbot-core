import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmedOutboundMessageIds, isSuccessfulOutbound } from "../bridge/cognition/index.mjs";

describe("cognition outcome", () => {
  it("accepts only explicit successful outbound results", () => {
    assert.equal(isSuccessfulOutbound({ status: "ok" }), true);
    assert.equal(isSuccessfulOutbound({ retcode: 0 }), true);
    assert.equal(isSuccessfulOutbound([{ status: "ok" }, { retcode: 0 }]), true);
    assert.equal(isSuccessfulOutbound([{ status: "ok" }, null]), false);
    assert.equal(isSuccessfulOutbound(undefined), false);
    assert.equal(isSuccessfulOutbound({ status: "failed", retcode: null }), false);
    assert.equal(isSuccessfulOutbound({ status: "failed", retcode: 1 }), false);
  });

  it("retains only ids from a completely confirmed outbound reply", () => {
    const first = { status: "ok", retcode: 0, data: { message_id: 901 } };
    const second = { status: "ok", retcode: 0, data: { message_id: "902" } };
    assert.deepEqual(confirmedOutboundMessageIds([first, second, first]), ["901", "902"]);
    assert.deepEqual(confirmedOutboundMessageIds([first, { status: "failed", retcode: 100 }]), []);
    assert.deepEqual(confirmedOutboundMessageIds([first, { status: "ok", retcode: 1 }]), []);
    assert.deepEqual(confirmedOutboundMessageIds({ status: "failed", retcode: 0, data: { message_id: 901 } }), []);
    assert.deepEqual(confirmedOutboundMessageIds({ status: "ok", retcode: 0, data: { message_id: Number.MAX_SAFE_INTEGER + 1 } }), []);
  });
});
