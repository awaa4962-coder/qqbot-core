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

  it("persists redacted source lengths and separate group/user truncation limits", () => {
    const oldMemoryFile = CFG.memoryFile;
    const oldChatLogFile = CFG.chatLogFile;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-storage-caps-"));
    const uid = "99001123";
    const gid = "88001123";
    const oldUser = users[uid];
    const oldGroup = groupChats[gid];

    try {
      CFG.memoryFile = path.join(tmp, "user_memory.json");
      CFG.chatLogFile = path.join(tmp, "group_chats.json");
      delete users[uid];
      delete groupChats[gid];

      const inputs = [200, 400, 600].map(length => "x".repeat(length));
      const secret = "password=SUPERSECRETVALUE12345678901234567890";
      const sensitiveInput = "x".repeat(509 - secret.length) + " " + secret;
      const redacted = sensitiveInput.replace(secret, "password=[REDACTED]");
      assert.equal(sensitiveInput.length, 510);
      assert.ok(redacted.length < 500);

      for (const text of [...inputs, sensitiveInput]) logGroupMsg(gid, "synthetic tester", text, uid, "member");
      flushSavesSync();

      const savedGroups = JSON.parse(fs.readFileSync(CFG.chatLogFile, "utf8"))[gid];
      const savedUsers = JSON.parse(fs.readFileSync(CFG.memoryFile, "utf8"))[uid].chats;
      assert.equal(savedGroups.length, 4);
      assert.equal(savedUsers.length, 4);
      for (const [index, length] of [200, 400, 600].entries()) {
        assert.deepEqual([savedGroups[index].text, savedGroups[index].textTruncated, savedGroups[index].textChars],
          [inputs[index].slice(0, 500), length > 500, length]);
        assert.deepEqual([savedUsers[index].text, savedUsers[index].textTruncated, savedUsers[index].textChars],
          [inputs[index].slice(0, 300), length > 300, length]);
      }
      assert.deepEqual([savedGroups[3].text, savedGroups[3].textTruncated, savedGroups[3].textChars],
        [redacted, false, redacted.length]);
      assert.deepEqual([savedUsers[3].text, savedUsers[3].textTruncated, savedUsers[3].textChars],
        [redacted.slice(0, 300), true, redacted.length]);
      assert.notEqual(savedGroups[3].textChars, sensitiveInput.length);
      assert.ok(!fs.readFileSync(CFG.chatLogFile, "utf8").includes(secret));
      assert.ok(!fs.readFileSync(CFG.memoryFile, "utf8").includes(secret));
    } finally {
      flushSavesSync();
      if (oldUser === undefined) delete users[uid]; else users[uid] = oldUser;
      if (oldGroup === undefined) delete groupChats[gid]; else groupChats[gid] = oldGroup;
      CFG.memoryFile = oldMemoryFile;
      CFG.chatLogFile = oldChatLogFile;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
