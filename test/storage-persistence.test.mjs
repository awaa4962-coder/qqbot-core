import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CFG } from "../bridge/config.mjs";
import { flushSavesSync, groupChats, logGroupMsg, users } from "../bridge/storage.mjs";

describe("storage persistence", () => {
  it("persists user chats after logGroupMsg and flush", () => {
    const oldMemoryFile = CFG.memoryFile;
    const oldChatLogFile = CFG.chatLogFile;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-storage-"));
    const uid = "99001122";
    const gid = "88001122";

    try {
      CFG.memoryFile = path.join(tmp, "user_memory.json");
      CFG.chatLogFile = path.join(tmp, "group_chats.json");
      delete users[uid];
      delete groupChats[gid];

      logGroupMsg(gid, "tester", "hello memory", uid, "member");
      flushSavesSync();

      const savedUsers = JSON.parse(fs.readFileSync(CFG.memoryFile, "utf8"));
      assert.equal(savedUsers[uid].chats.length, 1);
      assert.equal(savedUsers[uid].chats[0].text, "hello memory");
    } finally {
      delete users[uid];
      delete groupChats[gid];
      CFG.memoryFile = oldMemoryFile;
      CFG.chatLogFile = oldChatLogFile;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
