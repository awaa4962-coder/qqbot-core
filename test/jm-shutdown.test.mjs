import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { handleJmTransferCommand, listJmTasks, stopJmTasks } from "../bridge/jm/commands.mjs";

test("JM shutdown closes admission and keeps a dispatched upload unconfirmed", { timeout: 5000 }, async () => {
  const { promise: atUpload, resolve: enteredUpload } = Promise.withResolvers();
  const sent = [];
  let temp;
  const request = { isAtMe: true, group_id: 41001, message_id: 90221 };
  const options = {
    parsedCommand: { jmId: "223344" }, groupWhitelist: [41001],
    sender: async (_group, text) => { sent.push(text); return { status: "ok", retcode: 0 }; },
    runner: async (_id, dir) => {
      temp = path.dirname(dir);
      await fs.writeFile(path.join(dir, "sample.jpg"), "synthetic image");
      return { ok: true, all_success: true };
    },
    zipper: async (_source, zip) => { await fs.writeFile(zip, "synthetic zip"); },
    uploader: async (_group, _file, _name, { onRequestDispatched, signal }) => {
      onRequestDispatched();
      enteredUpload();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  try {
    assert.equal(await handleJmTransferCommand(request, options), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /已开始下载/);
    await atUpload;
    const stopped = stopJmTasks();
    assert.equal(await handleJmTransferCommand({ ...request, message_id: 90222 }, options), true);
    assert.equal(await stopped, true);
    assert.deepEqual(sent.map(text => text.includes("已开始下载")), [true]);
    const jobs = listJmTasks();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].phase, "failed");
    assert.match(jobs[0].error, /未确认.*不会自动重发/);
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
});
