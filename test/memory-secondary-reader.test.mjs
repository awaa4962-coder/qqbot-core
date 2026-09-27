import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import test from "node:test";

for (const entry of ["../daily_summary.mjs", "../scripts/send-summary-for-date.mjs"]) {
  test(`${entry}: a secondary importer cannot overwrite newer shared memory with its repaired old snapshot`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-secondary-reader-"));
    const files = ["user_memory.json", "group_chats.json", "profiles.json"].map(file => path.join(root, file));
    const future = Date.now() + 365 * 86400000;
    fs.writeFileSync(files[0], JSON.stringify({ "61901": { uid: "61901", profile: "password=OLD_REPAIR_BODY",
      chats: [{ group: "51901", ts: future, text: "secret=OLD_REPAIR_BODY" }] } }));
    fs.writeFileSync(files[1], JSON.stringify({ "51901": [{ uid: "61901", ts: future, text: "password=OLD_REPAIR_BODY" }] }));
    fs.writeFileSync(files[2], JSON.stringify({ userProfiles: { "61901": { dislikes: ["token=OLD_REPAIR_BODY"], expiresAt: future } } }));
    const code = `
      const realTimeout = globalThis.setTimeout;
      const scheduled = [];
      globalThis.setTimeout = (callback, _delay, ...args) => {
        scheduled.push(() => callback(...args)); return { unref() {} };
      };
      globalThis.fetch = async () => { throw new Error('network forbidden in secondary reader test'); };
      await import(${JSON.stringify(new URL(entry, import.meta.url).href)});
      process.on('message', async message => {
        if (message !== 'release') return;
        const count = scheduled.length;
        for (const callback of scheduled.splice(0)) callback();
        await new Promise(resolve => realTimeout(resolve, 150));
        process.send({ done: true, scheduled: count });
        process.disconnect();
      });
      process.send({ loaded: true });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: root,
        QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: files[2], QQBOT_SUMMARY_GROUP_WHITELIST: "51901" },
    });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; }); child.stdout.resume();
    t.after(() => {
      if (child.exitCode === null) child.kill();
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
    const waitMessage = key => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("secondary reader timeout: " + stderr)), 8000);
      const receive = message => {
        if (!message[key]) return;
        clearTimeout(timer); child.off("message", receive); resolve(message);
      };
      child.on("message", receive);
    });
    await waitMessage("loaded");
    const latest = files.map((_, index) => JSON.stringify({ current: "AUTHORITATIVE_AFTER_READ_" + index }));
    files.forEach((file, index) => fs.writeFileSync(file, latest[index]));
    const done = waitMessage("done"); child.send("release");
    assert.equal((await done).scheduled, 0, "read-only import must schedule no repair saves");
    assert.equal(await exit, 0, stderr);
    files.forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), latest[index]));
  });
}
