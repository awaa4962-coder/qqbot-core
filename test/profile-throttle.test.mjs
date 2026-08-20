import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CFG } from "../bridge/config.mjs";
import { flushSavesSync, users } from "../bridge/storage.mjs";
import { maybeGenerateProfile, shouldGenerateProfile } from "../bridge/reply.mjs";

function makeChats(count) {
  return Array.from({ length: count }, (_, i) => ({
    group: "1",
    text: "message " + i,
    ts: Date.now() - i,
  }));
}

describe("profile generation throttle", () => {
  it("does not generate profile repeatedly for consecutive replies", async () => {
    const oldMemoryFile = CFG.memoryFile;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-profile-"));
    const uid = "profile-throttle-user";
    const now = Date.now();
    let calls = 0;

    try {
      CFG.memoryFile = path.join(tmp, "user_memory.json");
      users[uid] = { uid, nicknames: [], chats: makeChats(10) };

      assert.equal(shouldGenerateProfile(uid, now), true);
      await maybeGenerateProfile(uid, async () => {
        calls++;
        return "ok";
      }, now);
      await maybeGenerateProfile(uid, async () => {
        calls++;
        return "ok";
      }, now + 1000);

      assert.equal(calls, 1);
      assert.equal(shouldGenerateProfile(uid, now + 1000), false);

      users[uid].chats.push(...makeChats(30));
      assert.equal(shouldGenerateProfile(uid, now + 2000), true);
      flushSavesSync();
    } finally {
      delete users[uid];
      CFG.memoryFile = oldMemoryFile;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not consume the throttle window when generation fails", async () => {
    const uid = "profile-throttle-failure";
    const now = Date.now();
    users[uid] = { uid, nicknames: [], chats: makeChats(10) };
    try {
      await assert.rejects(
        maybeGenerateProfile(uid, async () => { throw new Error("model unavailable"); }, now),
        /model unavailable/,
      );
      assert.equal(shouldGenerateProfile(uid, now + 1000), true);
      assert.equal(users[uid].profileGeneratedAt, undefined);
    } finally {
      delete users[uid];
    }
  });
});
