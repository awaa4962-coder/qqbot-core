import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const entry = relative => JSON.stringify(new URL(relative, import.meta.url).href);
const imports = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import { CFG } from ${entry("../bridge/config.mjs")};
  import { users, groupChats, logGroupMsg, saveUsers, flushSavesSync } from ${entry("../bridge/storage.mjs")};
  import { memoryProfiles, saveMemoryProfiles, flushMemoryProfilesSync } from ${entry("../bridge/memory-profile/store.mjs")};
  import { forgetUserData } from ${entry("../bridge/user-preferences.mjs")};
  import { getMemoryPrivacyGeneration } from ${entry("../bridge/memory-profile/generation.mjs")};
`;
const seed = `
  logGroupMsg('50100', 'ERASE_NAME', 'ERASE_RAW_BODY', '60100', 'member', ['https://example.com/ERASE_IMAGE'], { messageId: 70100 });
  users['60100'].profile = 'ERASE_PROFILE';
  users['60100'].preferences = { displayName: 'ERASE_PREFERENCE' };
  users['60100'].relationshipComments = { '50100': { text: 'ERASE_COMMENT' } };
  memoryProfiles.userProfiles['60100'] = { confidence: 1, expiresAt: Date.now() + 60000, dislikes: ['ERASE_INFERENCE'] };
  memoryProfiles.userGroupProfiles['50100:60100'] = { confidence: 1, expiresAt: Date.now() + 60000, recentTopics: ['ERASE_TOPIC'] };
  saveUsers(); saveMemoryProfiles();
  assert.equal(flushSavesSync(), true); assert.equal(flushMemoryProfilesSync(), true);
`;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-forget-disk-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function run(root, code) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", imports + code], {
    windowsHide: true, encoding: "utf8", timeout: 10000,
    env: { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: root,
      QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") },
  });
}

test("successful forget persists all cleared memory before an immediate process exit", t => {
  const root = sandbox(t);
  const child = run(root, seed + `
    const generation = getMemoryPrivacyGeneration();
    const result = forgetUserData('60100');
    assert.equal(result.ok, true, result.text);
    assert.ok(getMemoryPrivacyGeneration() > generation);
    process.exit(0);
  `);
  assert.equal(child.status, 0, child.stderr);
  for (const file of ["user_memory.json", "group_chats.json", "profiles.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /ERASE_/);
  }
  const restarted = run(root, `
    assert.doesNotMatch(JSON.stringify({users, groupChats, memoryProfiles}), /ERASE_/);
    assert.equal(groupChats['50100'][0].messageId, '70100');
    assert.equal(users['60100'].chats.length, 0);
    assert.equal(memoryProfiles.userProfiles['60100'], undefined);
  `);
  assert.equal(restarted.status, 0, restarted.stderr);
});

for (const failedStore of ["memoryFile", "chatLogFile", "memoryProfileFile"]) {
  test(`forget never acknowledges an unconfirmed ${failedStore} commit and a retry can finish`, t => {
    const root = sandbox(t);
    const child = run(root, seed + `
      const rename = fs.renameSync;
      const failing = CFG[${JSON.stringify(failedStore)}];
      const generation = getMemoryPrivacyGeneration();
      fs.renameSync = (...args) => {
        if (args[1] === failing) throw new Error('synthetic disk failure');
        return rename(...args);
      };
      const result = forgetUserData('60100');
      assert.equal(result.ok, false);
      assert.match(result.text, /未能确认|未能确认落盘/);
      assert.ok(getMemoryPrivacyGeneration() > generation);
      assert.doesNotMatch(JSON.stringify(users), /ERASE_/);
      fs.renameSync = rename;
      assert.equal(forgetUserData('60100').ok, true);
      for (const filename of [CFG.memoryFile, CFG.chatLogFile, CFG.memoryProfileFile]) {
        assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /ERASE_/);
      }
      process.exit(0);
    `);
    assert.equal(child.status, 0, child.stderr);
  });
}

test("an early privacy-ledger failure still invalidates pending work without claiming success", t => {
  const root = sandbox(t);
  const child = run(root, seed + `
    const rename = fs.renameSync;
    fs.renameSync = (...args) => {
      if (String(args[1]).endsWith('privacy.json')) throw new Error('synthetic ledger failure');
      return rename(...args);
    };
    const generation = getMemoryPrivacyGeneration();
    assert.throws(() => forgetUserData('60100'), /synthetic ledger failure/);
    assert.ok(getMemoryPrivacyGeneration() > generation);
    fs.renameSync = rename;
    assert.equal(forgetUserData('60100').ok, true);
  `);
  assert.equal(child.status, 0, child.stderr);
});
