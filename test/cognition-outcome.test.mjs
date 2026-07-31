import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSuccessfulOutbound } from "../bridge/cognition/index.mjs";

describe("cognition outcome", () => {
  it("accepts only explicit successful outbound results", () => {
    assert.equal(isSuccessfulOutbound({ status: "ok" }), true);
    assert.equal(isSuccessfulOutbound({ retcode: 0 }), true);
    assert.equal(isSuccessfulOutbound([{ status: "ok" }, { retcode: 0 }]), true);
    assert.equal(isSuccessfulOutbound([{ status: "ok" }, null]), false);
    assert.equal(isSuccessfulOutbound(undefined), false);
    assert.equal(isSuccessfulOutbound({ status: "failed", retcode: 1 }), false);
  });
});
