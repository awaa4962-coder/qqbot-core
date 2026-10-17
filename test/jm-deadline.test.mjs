import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createJmDeadline, JM_HARD_TIMEOUT_MS, JM_MAX_RESPONSE_MS, JM_PROGRESS_DELAY_MS } from "../bridge/jm/deadline.mjs";
import { transferJmToGroup, transferJmToPrivate } from "../bridge/jm/transfer.mjs";

async function spinUntil(predicate) {
  const end = performance.now() + 5000;
  while (performance.now() < end) { if (predicate()) return; await immediate(); }
  assert.fail("synthetic stage did not settle");
}

function waitingForAbort(signal, ready) {
  ready();
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function syntheticTransfer(extra = {}) {
  const fixture = { sent: [], roots: [], uploads: 0, packed: 0 };
  const options = {
    jmId: "123456", groupId: 300, userId: 300, startedNotice: false, zipPassword: "FS",
    sender: async (_id, text) => { fixture.sent.push(text); return { status: "ok", retcode: 0 }; },
    runner: async (_id, directory) => {
      fixture.roots.push(path.dirname(directory));
      await fs.writeFile(path.join(directory, "001.jpg"), "synthetic image");
      return { ok: true, all_success: true };
    },
    zipper: async (_source, destination, zipOptions) => {
      fixture.packed++;
      assert.equal(zipOptions.password, "FS");
      await fs.writeFile(destination, "synthetic archive");
    },
    uploader: async (_id, _file, _name, uploadOptions) => {
      fixture.uploads++;
      assert.equal(uploadOptions.chunkSize, 1024 * 1024);
      assert.ok(uploadOptions.totalTimeoutMs <= 90000);
      return { status: "ok", retcode: 0 };
    },
    ...extra,
  };
  return { fixture, options, clean: async () => { for (const root of fixture.roots) await fs.rm(root, { recursive: true, force: true }); } };
}

test("JM uses one 60/90/120 second clock and accounts for acceptance time", t => {
  assert.equal(JM_PROGRESS_DELAY_MS, 60000);
  assert.equal(JM_HARD_TIMEOUT_MS, 90000);
  assert.equal(JM_MAX_RESPONSE_MS, 120000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 3000, reports = 0, errors = 0;
  const budget = createJmDeadline({ now: () => now, startedAt: 0, timeoutMs: 1800000,
    onProgress: () => reports++, onDeadline: () => errors++ });
  assert.equal(budget.remainingMs(), 87000);
  now = 59999; t.mock.timers.tick(56999); assert.equal(reports, 0);
  now = 60000; t.mock.timers.tick(1); assert.equal(reports, 1);
  now = 89999; t.mock.timers.tick(29999); assert.equal(errors, 0);
  now = 90000; t.mock.timers.tick(1);
  assert.equal(errors, 1); assert.equal(budget.signal.aborted, true);
  assert.equal(budget.responseRemainingMs(), 30000);
  t.mock.timers.tick(90000); assert.equal(reports, 1); assert.equal(errors, 1);
  budget.finish();
});

test("successful group/private transfers clear both deadline notices and preserve FS", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const transfer of [transferJmToGroup, transferJmToPrivate]) {
    const f = syntheticTransfer();
    try {
      assert.equal((await transfer(f.options)).ok, true);
      t.mock.timers.tick(120000);
      assert.equal(f.fixture.uploads, 1);
      assert.ok(f.fixture.sent.some(text => text.includes("已转发") && text.includes("FS")));
      assert.ok(!f.fixture.sent.some(text => text.includes("JM 进度") || text.includes("本次处理时限")));
    } finally { await f.clean(); }
  }
});

test("at 60 seconds report real files once, at 90 stop download without packing or uploading", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ready = false, stopped = false;
  const f = syntheticTransfer();
  f.options.runner = async (_id, directory, options) => {
    f.fixture.roots.push(path.dirname(directory));
    await fs.writeFile(path.join(directory, "001.jpg"), "synthetic image");
    options.onProgress({ phase: "downloading", completed: 1, total: 2, bytes: 15, failed: 0 });
    try { return await waitingForAbort(options.signal, () => { ready = true; }); }
    finally { stopped = true; }
  };
  const running = transferJmToGroup(f.options);
  try {
    await spinUntil(() => ready);
    t.mock.timers.tick(60000);
    await spinUntil(() => f.fixture.sent.some(text => text.includes("JM 进度")));
    assert.ok(f.fixture.sent.some(text => text.includes("1/2") && text.includes("下载")));
    t.mock.timers.tick(30000);
    const result = await running;
    assert.equal(stopped, true); assert.equal(result.reason, "job_timeout");
    assert.equal(f.fixture.uploads, 0); assert.equal(f.fixture.packed, 0);
    assert.equal(f.fixture.sent.filter(text => text.includes("本次处理时限")).length, 1);
    t.mock.timers.tick(120000);
    assert.equal(f.fixture.sent.filter(text => text.includes("JM 进度")).length, 1);
  } finally { await f.clean(); }
});

test("packing shares the download deadline instead of getting another full budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let packing = false, stopped = false;
  const f = syntheticTransfer();
  f.options.zipper = async (_source, _zip, options) => {
    try { await waitingForAbort(options.signal, () => { packing = true; }); }
    finally { stopped = true; }
  };
  const running = transferJmToGroup(f.options);
  try {
    await spinUntil(() => packing);
    t.mock.timers.tick(60000);
    await spinUntil(() => f.fixture.sent.some(text => text.includes("JM 进度")));
    assert.ok(f.fixture.sent.some(text => text.includes("打包")));
    t.mock.timers.tick(30000);
    assert.equal((await running).reason, "job_timeout");
    assert.equal(stopped, true); assert.equal(f.fixture.uploads, 0);
  } finally { await f.clean(); }
});

for (const dispatched of [false, true]) {
  test("upload deadline preserves the " + (dispatched ? "unknown dispatched" : "not dispatched") + " boundary", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let uploading = false;
    const f = syntheticTransfer({ trackUploadDispatch: true });
    f.options.uploader = async (_id, _file, _name, options) => {
      f.fixture.uploads++;
      if (dispatched) options.onRequestDispatched();
      return waitingForAbort(options.signal, () => { uploading = true; });
    };
    const running = transferJmToPrivate(f.options);
    try {
      await spinUntil(() => uploading);
      t.mock.timers.tick(90000);
      assert.equal((await running).reason, dispatched ? "upload_unconfirmed" : "job_timeout");
      assert.equal(f.fixture.uploads, 1);
      assert.equal(f.fixture.sent.some(text => text.includes("结果未确认")), dispatched);
      assert.ok(!f.fixture.sent.some(text => text.includes("已转发")));
      t.mock.timers.tick(120000); assert.equal(f.fixture.uploads, 1);
    } finally { await f.clean(); }
  });
}

test("an incomplete downloader result never becomes an archive or success", async () => {
  const f = syntheticTransfer();
  f.options.runner = async (_id, directory) => {
    f.fixture.roots.push(path.dirname(directory));
    return { ok: true, all_success: false };
  };
  try {
    const result = await transferJmToGroup(f.options);
    assert.equal(result.ok, false); assert.equal(f.fixture.packed, 0); assert.equal(f.fixture.uploads, 0);
  } finally { await f.clean(); }
});

test("an external cancellation does not emit a delayed timeout notice", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new globalThis.AbortController(); controller.abort();
  const f = syntheticTransfer({ signal: controller.signal });
  const result = await transferJmToGroup(f.options);
  assert.equal(result.ok, false);
  t.mock.timers.tick(120000);
  assert.equal(f.fixture.sent.length, 0); assert.equal(f.fixture.uploads, 0);
});
