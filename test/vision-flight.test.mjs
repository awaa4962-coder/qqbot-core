import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createVisionDescriptionFlights } from "../bridge/vision/description-flight.mjs";

const key = letter => letter.repeat(64);
const tick = () => Promise.resolve();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("equal objective keys compute once while each waiter receives its own shared flag", async () => {
  const pool = createVisionDescriptionFlights(); const hold = deferred(); let calls = 0;
  const compute = async (_signal, requireWaiter) => { calls++; await hold.promise; requireWaiter(); return "objective description"; };
  const first = pool.run(key("a"), compute); const second = pool.run(key("a"), compute);
  await tick(); assert.equal(calls, 1); assert.equal(pool.status().waiters, 2);
  hold.resolve();
  assert.deepEqual(await first, { value: "objective description", shared: false });
  assert.deepEqual(await second, { value: "objective description", shared: true });
  assert.equal(pool.status().active, 0);
});

test("one cancelled waiter cannot cancel the remaining authorized calculation", async () => {
  const pool = createVisionDescriptionFlights(); const hold = deferred();
  const caller = new globalThis.AbortController(); let signal;
  const compute = async (sharedSignal, requireWaiter) => { signal = sharedSignal; await hold.promise; requireWaiter(); return "visible text"; };
  const first = pool.run(key("a"), compute, { signal: caller.signal });
  const rejected = assert.rejects(first, /task_cancelled/);
  const second = pool.run(key("a"), compute);
  await tick(); caller.abort(); await rejected;
  assert.equal(signal.aborted, false); assert.equal(pool.status().waiters, 1);
  hold.resolve(); assert.equal((await second).value, "visible text");
  assert.equal(pool.status().active, 0);
});

test("all waiters cancelling aborts work but retains capacity until that work ends", async () => {
  const pool = createVisionDescriptionFlights({ maxActive: 1 }); const hold = deferred();
  const a = new globalThis.AbortController(); const b = new globalThis.AbortController(); let signal;
  const compute = async sharedSignal => { signal = sharedSignal; await hold.promise; return "late"; };
  const first = pool.run(key("a"), compute, { signal: a.signal });
  const second = pool.run(key("a"), compute, { signal: b.signal });
  const rejected = Promise.all([assert.rejects(first, /task_cancelled/), assert.rejects(second, /task_cancelled/)]);
  await tick(); a.abort(); b.abort(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(pool.status().active, 1);
  await assert.rejects(pool.run(key("b"), () => assert.fail("capacity must remain reserved")), /vision_shared_capacity/);
  hold.resolve(); await tick(); await tick(); await tick();
  assert.equal(pool.status().active, 0);
  assert.equal((await pool.run(key("a"), async () => "fresh")).value, "fresh");
});

test("a shared deadline releases waiters without pretending an ignored abort finished", async () => {
  const pool = createVisionDescriptionFlights({ timeoutMs: 20 }); const hold = deferred(); let signal;
  const answer = pool.run(key("a"), async sharedSignal => { signal = sharedSignal; await hold.promise; return "late"; });
  await assert.rejects(answer, /task_deadline/);
  assert.equal(signal.aborted, true); assert.equal(pool.status().active, 1);
  hold.resolve(); await tick(); await tick(); await tick();
  assert.equal(pool.status().active, 0);
});

test("waiter guards retain their async scope and stale sources cannot authorize publication", async () => {
  const context = new AsyncLocalStorage(); const pool = createVisionDescriptionFlights(); const hold = deferred();
  let validA = true; let published = false; let calls = 0;
  const compute = async (_signal, requireWaiter) => { calls++; await hold.promise; requireWaiter(); published = true; return "valid for B"; };
  const first = context.run("A", () => pool.run(key("a"), compute, { assertCurrent: () => {
    assert.equal(context.getStore(), "A"); if (!validA) throw new Error("source_A_expired");
  } }));
  const failure = assert.rejects(first, /source_A_expired/);
  const second = context.run("B", () => pool.run(key("a"), compute, { assertCurrent: () => assert.equal(context.getStore(), "B") }));
  validA = false; hold.resolve(); await failure;
  assert.equal((await second).value, "valid for B"); assert.equal(calls, 1); assert.equal(published, true);
});

test("no current waiter means late computation cannot publish data", async () => {
  const pool = createVisionDescriptionFlights(); const hold = deferred(); let valid = true; let published = false;
  const answer = pool.run(key("a"), async (_signal, requireWaiter) => {
    await hold.promise; requireWaiter(); published = true; return "stale";
  }, { assertCurrent: () => { if (!valid) throw new Error("source_expired"); } });
  const failure = assert.rejects(answer, /source_expired/);
  await tick(); valid = false; hold.resolve(); await failure;
  assert.equal(published, false); await tick(); assert.equal(pool.status().active, 0);
});

test("different scoped/versioned keys do not share work and failures are not cached", async () => {
  const pool = createVisionDescriptionFlights(); let calls = 0;
  const compute = async () => ++calls;
  const [a, b] = await Promise.all([pool.run(key("a"), compute), pool.run(key("b"), compute)]);
  assert.equal(calls, 2); assert.notEqual(a.value, b.value);
  await assert.rejects(pool.run(key("a"), async () => { throw new Error("unavailable"); }), /unavailable/);
  assert.equal((await pool.run(key("a"), async () => "recovered")).value, "recovered");
});

test("waiter capacity is bounded without interrupting admitted work", async () => {
  const pool = createVisionDescriptionFlights({ maxWaiters: 1 }); const hold = deferred();
  const first = pool.run(key("a"), async () => { await hold.promise; return "allowed"; });
  await assert.rejects(pool.run(key("a"), () => assert.fail("no second calculation")), /vision_shared_capacity/);
  hold.resolve(); assert.equal((await first).value, "allowed");
});

test("privacy clear rejects pending work and exposes no identity or payload metadata", async () => {
  const pool = createVisionDescriptionFlights(); const hold = deferred();
  const answer = pool.run(key("a"), async (_signal, requireWaiter) => { await hold.promise; requireWaiter(); return "private image bytes"; });
  const failure = assert.rejects(answer, /privacy_changed/);
  await tick(); pool.clear(); await failure;
  assert.doesNotMatch(JSON.stringify(pool.status()), /private image|aaaaaaaa|key|userId|groupId/);
  hold.resolve(); await tick(); await tick(); await tick(); assert.equal(pool.status().active, 0);
});

test("invalid identities and unbounded factory settings cannot start a calculation", async () => {
  const pool = createVisionDescriptionFlights();
  await assert.rejects(pool.run("unscoped", () => assert.fail("identity denied")), /vision_shared_identity/);
  for (const settings of [{ maxActive: 9 }, { maxWaiters: 17 }, { timeoutMs: 40001 }, { timeoutMs: 0 }]) {
    assert.throws(() => createVisionDescriptionFlights(settings), /invalid vision flight limit/);
  }
});
