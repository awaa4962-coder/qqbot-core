import assert from "node:assert/strict";
import test from "node:test";

import { CFG } from "../bridge/config.mjs";
import {
  refreshNapCatReadiness,
  resetNapCatReadinessForTest,
} from "../bridge/napcat-readiness.mjs";

test("NapCat readiness requires the expected logged-in account", async () => {
  const originalSelf = CFG.selfUin;
  CFG.selfUin = 12345;
  resetNapCatReadinessForTest();
  try {
    const ready = await refreshNapCatReadiness({
      force: true,
      fetcher: async () => response(12345),
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.loggedIn, true);

    const wrong = await refreshNapCatReadiness({
      force: true,
      fetcher: async () => response(54321),
    });
    assert.equal(wrong.ready, false);
    assert.equal(wrong.reason, "unexpected_account");
  } finally {
    CFG.selfUin = originalSelf;
    resetNapCatReadinessForTest();
  }
});

test("NapCat readiness fails closed when the API is unavailable", async () => {
  resetNapCatReadinessForTest();
  const result = await refreshNapCatReadiness({
    force: true,
    fetcher: async () => { throw new Error("offline"); },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "api_unreachable");
});

function response(userId) {
  return {
    ok: true,
    json: async () => ({ status: "ok", retcode: 0, data: { user_id: userId } }),
  };
}
