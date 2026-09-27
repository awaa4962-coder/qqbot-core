import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CFG } from "../bridge/config.mjs";
import { createOneBotLinkManager } from "../bridge/onebot-link.mjs";
import { dispatchGroupCommand } from "../bridge/commands/action-dispatcher.mjs";
import { handlePrivateMessage } from "../bridge/reply-private.mjs";
import { listSummaryCommandTasks, queueGroupSummaryCommand, waitSummaryCommandTasks } from "../bridge/group-summary/commands.mjs";
import * as jm from "../bridge/jm/commands.mjs";
import { transferJmToGroup } from "../bridge/jm/transfer.mjs";
import { runPythonJson } from "../bridge/jm/runtime.mjs";
import { handleResourceTransferCommand, listResourceTasks, transferResourceToGroup, waitResourceTasks } from "../bridge/resource-transfer.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function boundedWait(promise) {
  return Promise.race([promise, delay(1500).then(() => { throw new Error("queue remained blocked"); })]);
}

function summaryMessages(count = 8) {
  const base = Date.parse("2026-06-26T09:00:00+08:00");
  return Array.from({ length: count }, (_, index) => ({ uid: String(index + 1), nickname: "合成成员" + index,
    text: index % 2 ? `讨论 jm 下载和资源测试 ${index}` : `夜星 bot 自动回复修复 ${index}`, ts: base + index * 60000 }));
}

function summaryModelResult() {
  return { choices: [{ message: { content: JSON.stringify({ headline: "", topics: [
    { id: "D001", title: "机器人回复", body: "模型日报正文", status: "chat", evidenceIds: ["E0001"] },
  ] }) } }] };
}

test("JM releases the group queue after one acknowledgement while retaining one global transfer slot", async () => {
  const hold = deferred();
  const started = deferred();
  const nextMessage = deferred();
  const sent = [];
  let tempRoot = "";
  let uploads = 0;
  let duplicateRuns = 0;
  const sender = async (_id, text) => { sent.push(text); return { status: "ok", retcode: 0 }; };
  const groupId = 601001;
  const manager = createOneBotLinkManager({ processor: event => event.kind === "jm"
    ? jm.handleJmTransferCommand({ isAtMe: true, group_id: groupId, message_id: 901001, text: "jm 654321" }, {
      parsedCommand: { ok: true, jmId: "654321" }, groupWhitelist: [groupId], sender,
      runner: async (_id, outputDir) => {
        tempRoot = path.dirname(outputDir); started.resolve(); await hold.promise;
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "synthetic"); return { ok: true };
      },
      zipper: async (_source, zipPath) => { await fsp.writeFile(zipPath, "synthetic zip"); },
      uploader: async () => { uploads++; return { status: "ok", retcode: 0 }; },
    }) : Promise.resolve(nextMessage.resolve()) });
  try {
    assert.equal(manager.enqueue({ kind: "jm", message_type: "group", group_id: groupId }), true);
    assert.equal(manager.enqueue({ kind: "next", message_type: "group", group_id: groupId }), true);
    await boundedWait(started.promise);
    await boundedWait(nextMessage.promise);
    assert.equal(uploads, 0);
    assert.equal(jm.activeJmTask, "654321");
    assert.equal(await jm.handlePrivateJmTransferCommand({ user_id: 701001, text: "jm 999999" }, {
      userWhitelist: [701001], sender, runner: async () => { duplicateRuns++; },
    }), true);
    assert.equal(duplicateRuns, 0);
    assert.ok(sent.some(text => text.includes("已有 JM 下载任务")));
    hold.resolve(); await jm.waitJmTasks();
    assert.equal(uploads, 1);
    assert.equal(jm.activeJmTask, null);
    assert.equal(sent.filter(text => text.includes("已开始下载")).length, 1);
    assert.equal(jm.listJmTasks().at(-1).phase, "done");
    assert.equal(await jm.handleJmTransferCommand({ isAtMe: true, group_id: groupId, message_id: 901001, text: "jm 654321" }, {
      parsedCommand: { ok: true, jmId: "654321" }, groupWhitelist: [groupId], sender,
      runner: async () => { duplicateRuns++; },
    }), true);
    assert.equal(duplicateRuns, 0);
    assert.equal(uploads, 1);
    assert.ok(sent.some(text => text.includes("已经受理过")));
    const stateFile = path.join(CFG.dataRoot, ".qqfriend", "tasks", `jm-${process.pid}.json`);
    assert.doesNotMatch(fs.readFileSync(stateFile, "utf8"), /654321|601001|701001|synthetic zip/);
  } finally {
    hold.resolve(); await jm.waitJmTasks(); await manager.stop({ drainMs: 1000 });
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("JM whitelist revocation during download prevents upload and suppresses a late notice", async () => {
  const hold = deferred();
  const started = deferred();
  const allowed = [601002];
  const sent = [];
  let tempRoot = "";
  let uploads = 0;
  try {
    assert.equal(await jm.handleJmTransferCommand({ isAtMe: true, group_id: 601002, text: "jm 654322" }, {
      parsedCommand: { ok: true, jmId: "654322" }, groupWhitelist: allowed,
      sender: async (_id, text) => { sent.push(text); return { status: "ok" }; },
      runner: async (_id, outputDir) => {
        tempRoot = path.dirname(outputDir); started.resolve(); await hold.promise;
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "synthetic"); return { ok: true };
      },
      zipper: async (_source, zipPath) => { await fsp.writeFile(zipPath, "synthetic zip"); },
      uploader: async () => { uploads++; return { status: "ok" }; },
    }), true);
    await boundedWait(started.promise);
    allowed.splice(0);
    hold.resolve(); await jm.waitJmTasks();
    assert.equal(uploads, 0);
    assert.equal(jm.listJmTasks().at(-1).phase, "failed");
    assert.equal(sent.length, 1);
  } finally {
    hold.resolve(); await jm.waitJmTasks();
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("JM child process accepts task cancellation without waiting for its full timeout", async () => {
  const controller = new globalThis.AbortController();
  const running = runPythonJson({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
    env: process.env, timeoutMs: 10000, signal: controller.signal });
  await delay(25);
  controller.abort();
  assert.equal((await boundedWait(running)).reason, "timeout");
});

test("cancelled JM work stops before packaging or upload and retains its delayed temp dir", async () => {
  const controller = new globalThis.AbortController();
  const sent = [];
  let zipCalls = 0; let uploads = 0; let tempRoot = "";
  try {
    const result = await transferJmToGroup({ jmId: "654323", groupId: 601023,
      startedNotice: false, signal: controller.signal,
      assertAllowed: () => controller.signal.throwIfAborted(),
      sender: async (_group, text) => { sent.push(text); return { status: "ok" }; },
      runner: async (_id, outputDir) => {
        tempRoot = path.dirname(outputDir);
        await fsp.writeFile(path.join(outputDir, "001.jpg"), "synthetic");
        controller.abort(); return { ok: true };
      },
      zipper: async () => { zipCalls++; },
      uploader: async () => { uploads++; return { status: "ok" }; },
    });
    assert.equal(result.ok, false);
    assert.equal(zipCalls, 0); assert.equal(uploads, 0); assert.deepEqual(sent, []);
    assert.equal(fs.existsSync(tempRoot), true);
  } finally { if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }); }
});

test("confirmed JM upload stays successful when the completion notice cannot be sent", async () => {
  let tempRoot = ""; let uploads = 0; let notices = 0;
  try {
    const result = await transferJmToGroup({ jmId: "654324", groupId: 601025,
      sender: async () => { notices++; if (notices === 2) throw new Error("synthetic notice failure"); return { status: "ok" }; },
      runner: async (_id, outputDir) => {
        tempRoot = path.dirname(outputDir); await fsp.writeFile(path.join(outputDir, "001.jpg"), "synthetic"); return { ok: true };
      },
      zipper: async (_source, zipPath) => { await fsp.writeFile(zipPath, "synthetic zip"); },
      uploader: async () => { uploads++; return { status: "ok", retcode: 0 }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.noticeConfirmed, false);
    assert.equal(uploads, 1); assert.equal(notices, 2);
  } finally { if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }); }
});

test("resource download releases the group queue and rechecks permission before upload", async () => {
  const oldFetch = globalThis.fetch;
  const hold = deferred();
  const fetching = deferred();
  const nextMessage = deferred();
  const allowed = [601003];
  const sent = [];
  let uploads = 0;
  globalThis.fetch = async () => {
    fetching.resolve(); await hold.promise;
    return new globalThis.Response("synthetic resource", { headers: { "content-length": "18" } });
  };
  const manager = createOneBotLinkManager({ processor: event => event.kind === "resource"
    ? handleResourceTransferCommand({ isAtMe: true, group_id: 601003, text: "下载 https://example.com/a.txt" }, {
      parsedCommand: { ok: true, url: "https://example.com/a.txt" }, groupWhitelist: allowed,
      sender: async (_id, text) => { sent.push(text); return { status: "ok" }; },
      uploader: async () => { uploads++; return { status: "ok" }; },
    }) : Promise.resolve(nextMessage.resolve()) });
  try {
    manager.enqueue({ kind: "resource", message_type: "group", group_id: 601003 });
    manager.enqueue({ kind: "next", message_type: "group", group_id: 601003 });
    await boundedWait(fetching.promise);
    await boundedWait(nextMessage.promise);
    assert.equal(await handleResourceTransferCommand({ isAtMe: true, group_id: 601007, text: "下载 https://example.com/other.txt" }, {
      parsedCommand: { ok: true, url: "https://example.com/other.txt" }, groupWhitelist: [601007],
      sender: async (_id, text) => { sent.push(text); return { status: "ok" }; },
      uploader: async () => { uploads++; return { status: "ok" }; },
    }), true);
    assert.ok(sent.some(text => text.includes("已有资源转发任务")));
    allowed.splice(0);
    hold.resolve(); await waitResourceTasks();
    assert.equal(uploads, 0);
    assert.equal(listResourceTasks().at(-1).phase, "failed");
    assert.equal(sent.length, 2);
    const stateFile = path.join(CFG.dataRoot, ".qqfriend", "tasks", `resource-transfers-${process.pid}.json`);
    assert.doesNotMatch(fs.readFileSync(stateFile, "utf8"), /a\.txt|601003|synthetic resource/);
  } finally {
    hold.resolve(); await waitResourceTasks(); await manager.stop({ drainMs: 1000 });
    globalThis.fetch = oldFetch;
  }
});

test("resource command reports success after a confirmed single upload", async () => {
  const oldFetch = globalThis.fetch;
  let uploads = 0;
  let fetches = 0;
  const sent = [];
  globalThis.fetch = async () => { fetches++; return new globalThis.Response("synthetic resource", { headers: { "content-length": "18" } }); };
  const ctx = { isAtMe: true, group_id: 601004, message_id: 901004, text: "下载 https://example.com/b.txt" };
  const options = {
    parsedCommand: { ok: true, url: "https://example.com/b.txt" }, groupWhitelist: [601004],
    sender: async (_id, text) => { sent.push(text); return { status: "ok" }; },
    uploader: async () => { uploads++; return { status: "ok", retcode: 0 }; },
  };
  try {
    assert.equal(await handleResourceTransferCommand(ctx, options), true);
    await waitResourceTasks();
    assert.equal(uploads, 1);
    assert.equal(listResourceTasks().at(-1).phase, "done");
    assert.ok(sent.some(text => text.includes("已开始")));
    assert.ok(sent.some(text => text.includes("资源已转发")));
    assert.equal(await handleResourceTransferCommand(ctx, options), true);
    assert.equal(uploads, 1);
    assert.equal(fetches, 1);
    assert.ok(sent.some(text => text.includes("已经受理过")));
  } finally { await waitResourceTasks(); globalThis.fetch = oldFetch; }
});

test("cancelled resource work removes its temp file without uploading or sending a late notice", async () => {
  const oldFetch = globalThis.fetch;
  const controller = new globalThis.AbortController();
  let checks = 0; let uploads = 0;
  const sent = [];
  globalThis.fetch = async () => new globalThis.Response("synthetic resource", { headers: { "content-length": "18" } });
  try {
    const result = await transferResourceToGroup({ groupId: 601024, url: "https://example.com/resource.txt",
      signal: controller.signal, assertAllowed: () => {
        checks++; if (checks === 2) controller.abort(); controller.signal.throwIfAborted();
      },
      sender: async (_id, text) => { sent.push(text); return { status: "ok" }; },
      uploader: async () => { uploads++; return { status: "ok" }; },
    });
    assert.equal(result.ok, false);
    assert.equal(uploads, 0); assert.deepEqual(sent, []);
  } finally { globalThis.fetch = oldFetch; }
});

test("confirmed resource upload remains successful if the follow-up notice fails", async () => {
  const oldFetch = globalThis.fetch;
  let uploads = 0; let notices = 0;
  globalThis.fetch = async () => new globalThis.Response("synthetic resource", { headers: { "content-length": "18" } });
  try {
    const result = await transferResourceToGroup({ groupId: 601026, url: "https://example.com/resource.txt",
      sender: async () => { notices++; throw new Error("synthetic notice failure"); },
      uploader: async () => { uploads++; return { status: "ok", retcode: 0 }; },
    });
    assert.equal(result.ok, true); assert.equal(result.noticeConfirmed, false);
    assert.equal(uploads, 1); assert.equal(notices, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test("admin group summary releases its group queue and rejects a duplicate running task", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-summary-queue-"));
  const hold = deferred(); const started = deferred(); const nextMessage = deferred();
  const notices = [];
  let modelCalls = 0;
  let businessSends = 0;
  const ctx = { isAtMe: true, text: "@夜星 日报预览 601005 2026-06-26 short", group_id: 601005, user_id: 42, message_id: 901005 };
  const options = { botNames: ["夜星"], admins: ["42"], groupWhitelist: [601005], summaryRoot: root,
    summaryMessages: summaryMessages(), recordCommand: () => {},
    sender: async (_group, text) => { notices.push(text); return { status: "ok", retcode: 0 }; },
    callPrimarySummary: async () => { modelCalls++; started.resolve(); await hold.promise; return summaryModelResult(); },
    sendGroupMessage: async () => { businessSends++; return { status: "ok" }; },
  };
  const manager = createOneBotLinkManager({ processor: event => event.kind === "summary"
    ? dispatchGroupCommand(ctx, options) : Promise.resolve(nextMessage.resolve()) });
  try {
    manager.enqueue({ kind: "summary", message_type: "group", group_id: 601005 });
    manager.enqueue({ kind: "next", message_type: "group", group_id: 601005 });
    await boundedWait(started.promise);
    await boundedWait(nextMessage.promise);
    assert.equal(await dispatchGroupCommand({ ...ctx, message_id: 901007 }, options), true);
    assert.ok(notices.some(text => text.includes("仍在运行")));
    assert.equal(modelCalls, 1);
    assert.equal(businessSends, 0);
    hold.resolve(); await waitSummaryCommandTasks();
    assert.equal(listSummaryCommandTasks().at(-1).phase, "done");
    assert.ok(notices.some(text => text.includes("日报预览完成")));
    assert.equal(await dispatchGroupCommand(ctx, options), true);
    assert.equal(modelCalls, 1);
    assert.ok(notices.some(text => text.includes("已经受理过")));
    const stateFile = path.join(CFG.dataRoot, ".qqfriend", "tasks", `summary-commands-${process.pid}.json`);
    assert.doesNotMatch(fs.readFileSync(stateFile, "utf8"), /模型日报正文|合成成员/);
  } finally {
    hold.resolve(); await waitSummaryCommandTasks(); await manager.stop({ drainMs: 1000 });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("private admin summary remains available outside the ordinary friend whitelist", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-private-summary-"));
  const adminId = 7901006;
  const originalAdmins = [...CFG.adminUins];
  const notices = [];
  CFG.adminUins.push(adminId);
  try {
    await handlePrivateMessage({ user_id: adminId, message_id: 901006,
      text: "日报预览 601006 2026-06-26 short", rawText: "日报预览 601006 2026-06-26 short", files: [], images: [] }, {
      summaryRoot: root, groupWhitelist: [601006], summaryMessages: summaryMessages(2),
      sendPrivateMsg: async (_user, text) => { notices.push(text); return { status: "ok", retcode: 0 }; },
    });
    await waitSummaryCommandTasks();
    assert.ok(notices.some(text => text.includes("任务已接收")));
    assert.ok(notices.some(text => text.includes("日报预览完成")));
    assert.equal(listSummaryCommandTasks().at(-1).phase, "done");
  } finally {
    CFG.adminUins.splice(0, CFG.adminUins.length, ...originalAdmins);
    await waitSummaryCommandTasks(); await fsp.rm(root, { recursive: true, force: true });
  }
});

test("queued summary send has one confirmed publisher and no replay of the same event", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-summary-send-"));
  const notices = [];
  let sends = 0;
  const options = { surface: "group", groupId: 601008, userId: 42, messageId: 901008, admins: ["42"],
    summaryRoot: root, groupWhitelist: [601008], summaryMessages: summaryMessages(),
    callPrimarySummary: async () => summaryModelResult(),
    sendGroupMessage: async () => { sends++; return { status: "ok", retcode: 0 }; },
    sendReply: async text => { notices.push(text); return { status: "ok", retcode: 0 }; } };
  try {
    assert.equal(await queueGroupSummaryCommand("日报发送 601008 2026-06-26 short", options), true);
    await waitSummaryCommandTasks();
    assert.equal(sends, 1);
    assert.equal(listSummaryCommandTasks().at(-1).phase, "done");
    assert.ok(notices.some(text => text.includes("日报已发送")));
    assert.equal(await queueGroupSummaryCommand("日报发送 601008 2026-06-26 short", options), true);
    assert.equal(sends, 1);
    assert.ok(notices.some(text => text.includes("已经受理过")));
  } finally { await waitSummaryCommandTasks(); await fsp.rm(root, { recursive: true, force: true }); }
});

test("queued summary reports model failure as a failed task without sending a report", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-summary-failed-"));
  const notices = [];
  let sends = 0;
  try {
    assert.equal(await queueGroupSummaryCommand("日报发送 601009 2026-06-26 short", {
      surface: "group", groupId: 601009, userId: 42, messageId: 901009, admins: ["42"],
      summaryRoot: root, groupWhitelist: [601009], summaryMessages: summaryMessages(),
      callPrimarySummary: async () => null, callFallbackSummary: async () => null,
      sendGroupMessage: async () => { sends++; return { status: "ok" }; },
      sendReply: async text => { notices.push(text); return { status: "ok" }; },
    }), true);
    await waitSummaryCommandTasks();
    assert.equal(sends, 0);
    assert.equal(listSummaryCommandTasks().at(-1).phase, "failed");
    assert.ok(notices.some(text => text.includes("未生成通过证据校验")));
    assert.equal(notices.some(text => text.includes("日报已发送")), false);
  } finally { await waitSummaryCommandTasks(); await fsp.rm(root, { recursive: true, force: true }); }
});

test("admin revocation during summary generation stops before draft save or upload", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "qqfriend-summary-revoked-"));
  const hold = deferred(); const started = deferred();
  const admins = ["42"];
  let sends = 0;
  try {
    assert.equal(await queueGroupSummaryCommand("日报发送 601010 2026-06-26 short", {
      surface: "group", groupId: 601010, userId: 42, messageId: 901010, admins,
      summaryRoot: root, groupWhitelist: [601010], summaryMessages: summaryMessages(),
      callPrimarySummary: async () => { started.resolve(); await hold.promise; return summaryModelResult(); },
      sendGroupMessage: async () => { sends++; return { status: "ok" }; },
      sendReply: async () => ({ status: "ok" }),
    }), true);
    await boundedWait(started.promise);
    admins.splice(0);
    hold.resolve(); await waitSummaryCommandTasks();
    assert.equal(sends, 0);
    assert.equal(listSummaryCommandTasks().at(-1).phase, "failed");
    assert.equal(fs.existsSync(path.join(root, "reports")), false);
  } finally { hold.resolve(); await waitSummaryCommandTasks(); await fsp.rm(root, { recursive: true, force: true }); }
});
