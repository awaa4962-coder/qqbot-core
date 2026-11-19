import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { handleAdminApiRequest } from "../bridge/admin-api/routes.mjs";
import { createAdminTaskManager, adminTaskManager } from "../bridge/admin-api/task-manager.mjs";
import { createSummaryManager, summaryManager } from "../bridge/admin-api/summary-manager.mjs";
import { listSummaryCommandTasks, queueGroupSummaryCommand, stopSummaryCommandTasks } from "../bridge/group-summary/commands.mjs";
import { readSummaryDelivery } from "../bridge/group-summary/publisher.mjs";
import { saveReportRevision } from "../bridge/group-summary/reports.mjs";
import { summaryPrivacy } from "../bridge/group-summary/state.mjs";

const day = "2026-06-26";
const confirmed = { status: "ok", retcode: 0, data: { message_id: 1201 } };
const unknown = { status: "unknown", delivery: "unconfirmed" };

function scratch(t) {
  const temp = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, "qqfriend-detached-stop-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), temp);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function assertStillStopping(stopping) {
  assert.equal(await Promise.race([stopping, setImmediate(false)]), false);
}

test("admin task stop closes admission, signals the worker, and waits for it to settle", { timeout: 3000 }, async t => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const manager = createAdminTaskManager({ filename: path.join(scratch(t), "jobs.json"), handlers: {
    stickers: async (_payload, { signal }) => { entered.resolve(signal); return finish.promise; },
  } });
  const body = { module: "stickers", payload: { action: "analyze" } };
  const admitted = manager.start(body);
  const signal = await entered.promise;
  const stopping = manager.stop();
  try {
    assert.equal(signal.aborted, true);
    assert.throws(() => manager.start(body), { code: "bridge_stopping" });
    await assertStillStopping(stopping);
  } finally { finish.resolve({ ok: false }); await stopping; }
  assert.equal(await stopping, true);
  assert.equal(manager.snapshot({ id: admitted.jobId }).task.phase, "failed");
  assert.equal(manager.snapshot().tasks.length, 1);
});

test("already-entered admin routes cannot admit a job after they finish reading the body", { timeout: 3000 }, async () => {
  function request(pathname, body) {
    const reading = Promise.withResolvers();
    const release = Promise.withResolvers();
    const response = [];
    const req = {
      method: "POST", url: pathname, socket: { remoteAddress: "127.0.0.1" }, headers: {},
      async *[Symbol.asyncIterator]() { reading.resolve(); await release.promise; yield JSON.stringify(body); },
    };
    const handling = handleAdminApiRequest(req, {}, { pathname, requiredToken: "",
      sendJson(_res, code, payload) { response.push({ code, payload }); } });
    return { reading, release, handling, response };
  }
  const requests = [request("/admin/tasks", { module: "stickers", payload: { action: "cleanup" } }),
    request("/admin/summaries", { action: "generate", groupId: "0" })];
  await Promise.all(requests.map(req => req.reading.promise));
  try {
    assert.deepEqual(await Promise.all([adminTaskManager.stop(), summaryManager.stop()]), [true, true]);
  } finally { for (const req of requests) req.release.resolve(); }
  for (const { handling, response } of requests) {
    assert.equal(await handling, true);
    assert.deepEqual(response, [{ code: 400, payload: { error: "服务正在关闭。" } }]);
  }
  assert.deepEqual(adminTaskManager.snapshot().tasks, []);
  assert.deepEqual(summaryManager.snapshot().jobs, []);
});

for (const [receipt, status, completed] of [[confirmed, "partial", 1], [unknown, "unconfirmed", 0]]) {
  test(`admin summary stop retains ${status} delivery and blocks the next chunk`, { timeout: 3000 }, async t => {
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const groupId = "601041";
    const sends = [];
    const options = { root: scratch(t), whitelist: [groupId], delayMs: 0,
      sendGroupMessage: async (_group, text) => { sends.push(text); entered.resolve(); return finish.promise; } };
    const target = { dateText: day, groupId };
    const revision = saveReportRevision({ ...target, summary: "synthetic report body ".repeat(90),
      privacyEpoch: summaryPrivacy(options).epoch }, options);
    const manager = createSummaryManager(options);
    await manager.act({ ...target, revisionId: revision.id, action: "send" });
    await entered.promise;
    const stopping = manager.stop();
    try {
      for (const action of ["generate", "save", "resume"]) {
        await assert.rejects(manager.act({ ...target, action }), { code: "bridge_stopping" });
      }
      await assertStillStopping(stopping);
    } finally { finish.resolve(receipt); await stopping; }
    assert.equal(await stopping, true);
    assert.equal(sends.length, 1);
    const delivery = readSummaryDelivery(day, groupId, options);
    assert.equal(delivery.status, status);
    assert.equal(delivery.completed, completed);
    assert.deepEqual(delivery.receipts, completed ? ["1201"] : []);
    const jobs = manager.snapshot(target).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].phase, "failed");
    if (status === "unconfirmed") assert.equal(jobs[0].pending, true);
  });
}

test("summary command stop fences ACK-gated work and retains an in-flight unknown receipt", { timeout: 3000 }, async t => {
  const root = scratch(t);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const ackStarted = Promise.withResolvers();
  const finishAck = Promise.withResolvers();
  const messages = Array.from({ length: 8 }, (_, index) => ({ uid: String(index + 1), nickname: "合成成员" + index,
    text: `机器人回复修复 ${index}`, ts: Date.parse("2026-06-26T09:00:00+08:00") + index * 60000 }));
  const options = { summaryRoot: root, surface: "group", groupId: 601051, messageId: 901051, userId: 42,
    admins: ["42"], groupWhitelist: [601051, 601052], summaryMessages: messages,
    callPrimarySummary: async () => ({ choices: [{ message: { content: JSON.stringify({ headline: "", topics: [
      { id: "D001", title: "机器人回复", body: "模型日报正文", status: "chat", evidenceIds: ["E0001"] },
    ] }) } }] }),
    callFallbackSummary: () => assert.fail("unexpected fallback"),
    sendGroupMessage: () => assert.fail("unexpected report dispatch"),
  };
  let notices = 0;
  let sends = 0;
  const first = { ...options, sendReply: async () => { notices++; return confirmed; },
    sendGroupMessage: async () => { sends++; entered.resolve(); return finish.promise; } };
  assert.equal(await queueGroupSummaryCommand(`日报发送 601051 ${day} short`, first), true);
  await entered.promise;
  const second = { ...options, groupId: 601052, messageId: 901052,
    sendReply: async () => { ackStarted.resolve(); return finishAck.promise; },
    callPrimarySummary: () => assert.fail("the ACK-gated worker must not start after shutdown") };
  const pendingAck = queueGroupSummaryCommand(`日报发送 601052 ${day} short`, second);
  await ackStarted.promise;
  const stopping = stopSummaryCommandTasks();
  try {
    assert.equal(await queueGroupSummaryCommand(`日报发送 601051 ${day} short`, { ...first, messageId: 901053 }), true);
    finishAck.resolve(confirmed);
    assert.equal(await pendingAck, true);
    await assertStillStopping(stopping);
  } finally { finishAck.resolve(confirmed); finish.resolve(unknown); await stopping; }
  assert.equal(await stopping, true);
  assert.equal(sends, 1);
  assert.equal(notices, 1);
  assert.equal(readSummaryDelivery(day, 601051, { root }).status, "unconfirmed");
  assert.equal(readSummaryDelivery(day, 601052, { root }).status, "not_sent");
  assert.equal(listSummaryCommandTasks().filter(job => job.targetGroupId === "601051")[0].pending, true);
  assert.equal(listSummaryCommandTasks().filter(job => job.targetGroupId === "601052").length, 1);
});
