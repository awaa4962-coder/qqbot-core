import assert from "node:assert/strict";
import test from "node:test";
import { setInterval, clearInterval } from "node:timers";
import { sendTextToGroup, sendTextToPrivate } from "../bridge/outbound-message.mjs";

test("an expired JM notice cannot dispatch through the shared text sender", async () => {
  const prior = globalThis.fetch;
  const controller = new globalThis.AbortController(); controller.abort();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not dispatch"); };
  try {
    const result = await sendTextToGroup({ groupId: 300, text: "synthetic JM notice", signal: controller.signal });
    assert.equal(result.status, "cancelled"); assert.equal(calls, 0);
  } finally { globalThis.fetch = prior; }
});

test("abort after notice dispatch is unknown and never retried", async () => {
  const prior = globalThis.fetch;
  const controller = new globalThis.AbortController();
  let calls = 0, ready;
  const started = new Promise(resolve => { ready = resolve; });
  globalThis.fetch = async (_url, options) => {
    calls++; ready();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  try {
    const running = sendTextToPrivate({ userId: 300, text: "synthetic JM progress", signal: controller.signal, maxAttempts: 3 });
    await started; controller.abort();
    const result = await running;
    assert.equal(result.delivery, "unconfirmed"); assert.equal(calls, 1);
  } finally { controller.abort(); globalThis.fetch = prior; }
});

test("text cancellation between chunks prevents later segments", async () => {
  const prior = globalThis.fetch;
  const controller = new globalThis.AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => { controller.abort(); return { status: "ok", retcode: 0 }; } };
  };
  try {
    const result = await sendTextToGroup({ groupId: 300, text: "x".repeat(1200), signal: controller.signal });
    assert.equal(result[0].status, "ok"); assert.equal(result[1].status, "cancelled"); assert.equal(calls, 1);
  } finally { globalThis.fetch = prior; }
});

test("a notice's short timeout bounds its HTTP request and does not retry", async () => {
  const prior = globalThis.fetch;
  const hold = setInterval(() => {}, 1000);
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  try {
    const result = await sendTextToPrivate({ userId: 300, text: "synthetic deadline", timeoutMs: 20, maxAttempts: 3 });
    assert.equal(result.delivery, "unconfirmed"); assert.equal(calls, 1);
  } finally { clearInterval(hold); globalThis.fetch = prior; }
});
