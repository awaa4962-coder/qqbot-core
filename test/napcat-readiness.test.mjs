import assert from "node:assert/strict";
import test from "node:test";

import { CFG } from "../bridge/config.mjs";
import {
  getCachedNapCatReadiness,
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

test("login-shaped data cannot override failed, async, malformed or HTTP error responses", async () => {
  try {
    for (const [ok, receipt] of [[true, { status: "failed", retcode: 0 }], [true, { status: "ok", retcode: 100 }],
      [true, { status: "async", retcode: 1 }], [true, { status: "ok", retcode: null }], [false, { status: "ok", retcode: 0 }]]) {
      const result = await refreshNapCatReadiness({ force: true,
        fetcher: async () => ({ ok, json: async () => ({ ...receipt, data: { user_id: CFG.selfUin || 12345 } }) }),
      });
      assert.equal(result.ready, false);
      assert.equal(result.loggedIn, false);
      assert.equal(result.reason, "not_logged_in");
    }
  } finally { resetNapCatReadinessForTest(); }
});

test("forced readiness ignores even a fresh cache and concurrent readers share the new probe", async t => {
  t.after(resetNapCatReadinessForTest);
  resetNapCatReadinessForTest();
  const fetcher = async () => response(CFG.selfUin || 12345);
  const initial = await refreshNapCatReadiness({ cacheNow: 100, fetcher });
  assert.equal(initial.ready, true);
  const cached = await refreshNapCatReadiness({ cacheNow: 101, fetcher: unexpectedProbe });
  assert.equal(cached.ready, true);

  let probes = 0;
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  const forced = refreshNapCatReadiness({ cacheNow: 200, force: true, fetcher: () => { probes++; return reply; } });
  const other = refreshNapCatReadiness({ cacheNow: 201, force: true, fetcher: unexpectedProbe });
  const reader = refreshNapCatReadiness({ cacheNow: 201, fetcher: unexpectedProbe });
  finish({ ok: true, json: async () => ({ status: "failed", retcode: 100 }) });
  const results = await Promise.all([forced, other, reader]);
  assert.equal(probes, 1);
  assert.deepEqual(results.map(result => result.reason), Array(3).fill("not_logged_in"));
  results[0].ready = true;
  assert.equal(results[1].ready, false);
  assert.equal(getCachedNapCatReadiness().ready, false);
  assert.equal((await refreshNapCatReadiness({ cacheNow: 5200, fetcher })).ready, true);

  function unexpectedProbe() {
    probes++;
    throw new Error("unexpected split probe");
  }
});

function response(userId) {
  return {
    ok: true,
    json: async () => ({ status: "ok", retcode: 0, data: { user_id: userId } }),
  };
}
