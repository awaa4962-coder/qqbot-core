import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import test from "node:test";

const entry = name => JSON.stringify(new URL("../bridge/" + name, import.meta.url).href);
const prelude = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import { setTimeout as sleep } from 'node:timers/promises';
  import { CFG } from ${entry("config.mjs")};
`;
const load = `const storage = await import(${entry("storage.mjs")});`;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-storage-recovery-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function run(root, code) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", prelude + code], {
    cwd: root, windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: root,
      QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_TEMP_DIR: root,
      QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") },
  });
}

function unchanged(root, before) {
  for (const [name, bytes] of Object.entries(before)) {
    assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  }
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".json") || name.includes(".tmp.")), Object.keys(before).sort());
}

for (const filename of ["user_memory.json", "group_chats.json"]) {
  for (const [name, text] of [["malformed", '{"secret":"PRIVATE_STORAGE_SENTINEL"'],
    ["array root", '[{"legacy":true}]'], ["null root", "null"], ["scalar root", '"PRIVATE_STORAGE_SENTINEL"']]) {
    test(`${filename}: ${name} fails closed without changing either file`, t => {
      const root = sandbox(t);
      const before = { "user_memory.json": Buffer.from('{"legacy":{"custom":true}}\r\n'),
        "group_chats.json": Buffer.from('{"legacy":{"custom":true}}\r\n') };
      before[filename] = Buffer.from(text);
      for (const [file, bytes] of Object.entries(before)) fs.writeFileSync(path.join(root, file), bytes);
      const child = run(root, `${load}
        storage.logGroupMsg('50100', 'synthetic', 'must not run', '60100');
        storage.flushSavesSync();
      `);
      assert.notEqual(child.status, 0);
      assert.equal(child.error, undefined);
      assert.match(child.stderr, /Storage initialization failed/);
      assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_STORAGE_SENTINEL/);
      unchanged(root, before);
    });
  }

  for (const operation of ["statSync", "readFileSync"]) {
    test(`${filename}: ${operation} access failure never resets existing bytes`, t => {
      const root = sandbox(t);
      const before = { "user_memory.json": Buffer.from('{"legacy":{"extra":"unchanged"}}\r\n'),
        "group_chats.json": Buffer.from('{"legacy":{"extra":"unchanged"}}\r\n') };
      for (const [file, bytes] of Object.entries(before)) fs.writeFileSync(path.join(root, file), bytes);
      const child = run(root, `
        const original = fs[${JSON.stringify(operation)}];
        const target = CFG[${JSON.stringify(filename === "user_memory.json" ? "memoryFile" : "chatLogFile")}];
        fs[${JSON.stringify(operation)}] = (...args) => {
          if (args[0] === target) throw Object.assign(new Error('PRIVATE_READ_SENTINEL'), {code:'EACCES'});
          return original(...args);
        };
        ${load}
        storage.saveUsers(); storage.saveGroupChats(); storage.flushSavesSync();
      `);
      assert.notEqual(child.status, 0);
      assert.equal(child.error, undefined);
      assert.match(child.stderr, /Storage initialization failed.*read_failed/);
      assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_READ_SENTINEL/);
      unchanged(root, before);
    });
  }

  for (const operation of ["statSync", "readFileSync"]) {
    test(`${filename}: ${operation} ENOENT after path detection fails closed without overwriting history`, t => {
      const root = sandbox(t);
      const before = { "user_memory.json": Buffer.from('{"60100":{"uid":"60100","chats":[{"text":"old user history","ts":1}],"custom":true}}\r\n'),
        "group_chats.json": Buffer.from('{"50100":[{"uid":"60100","text":"old group history","ts":1}]}\r\n') };
      for (const [file, bytes] of Object.entries(before)) fs.writeFileSync(path.join(root, file), bytes);
      const child = run(root, `
        const target = CFG[${JSON.stringify(filename === "user_memory.json" ? "memoryFile" : "chatLogFile")}];
        const originalLstat = fs.lstatSync; const originalStat = fs.statSync;
        const originalRead = fs.readFileSync;
        let detected = 0; let successfulStats = 0;
        fs.lstatSync = (...args) => {
          const value = originalLstat(...args);
          if (args[0] === target) detected++;
          return value;
        };
        fs.statSync = (...args) => {
          if (args[0] === target && ${JSON.stringify(operation)} === 'statSync') {
            throw Object.assign(new Error('PRIVATE_READ_SENTINEL'), {code:'ENOENT'});
          }
          const value = originalStat(...args);
          if (args[0] === target) successfulStats++;
          return value;
        };
        fs.readFileSync = (...args) => {
          if (args[0] === target && ${JSON.stringify(operation)} === 'readFileSync') {
            throw Object.assign(new Error('PRIVATE_READ_SENTINEL'), {code:'ENOENT'});
          }
          return originalRead(...args);
        };
        await assert.rejects(async () => {
          ${load}
          storage.logGroupMsg('50100', 'synthetic', 'must not overwrite history', '60100');
          storage.flushSavesSync();
        }, /Storage initialization failed.*read_failed/);
        assert.equal(detected, 1);
        assert.equal(successfulStats, ${operation === "readFileSync" ? 1 : 0});
      `);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.error, undefined);
      assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_READ_SENTINEL/);
      unchanged(root, before);
    });
  }
}

test("missing files are valid first boot; save and restart retain both chat histories", t => {
  const root = sandbox(t);
  const child = run(root, `${load}
    assert.deepEqual(storage.users, {}); assert.deepEqual(storage.groupChats, {});
    assert.equal(fs.existsSync(CFG.memoryFile), false);
    assert.equal(fs.existsSync(CFG.chatLogFile), false);
    storage.logGroupMsg('50100', 'synthetic', 'first boot', '60100', 'member', [], {messageId:70100});
    assert.equal(storage.flushSavesSync(), true);
  `);
  assert.equal(child.status, 0, child.stderr);
  const restarted = run(root, `${load}
    assert.equal(storage.users['60100'].chats.length, 1);
    assert.equal(storage.groupChats['50100'].length, 1);
    assert.equal(storage.users['60100'].chats[0].text, 'first boot');
    assert.equal(storage.groupChats['50100'][0].messageId, '70100');
    assert.equal(storage.flushSavesSync(), true);
  `);
  assert.equal(restarted.status, 0, restarted.stderr);
});

test("legacy object records and extension fields are preserved without import writes", t => {
  const root = sandbox(t);
  const before = { "user_memory.json": Buffer.from(JSON.stringify({legacy:{chats:[], nicknames:[], custom:{keep:7}}, opaque:{v:1}}) + "\r\n"),
    "group_chats.json": Buffer.from(JSON.stringify({legacy:{custom:{keep:9}}, "50100":[]}) + "\r\n") };
  for (const [file, bytes] of Object.entries(before)) fs.writeFileSync(path.join(root, file), bytes);
  const child = run(root, `${load} assert.equal(storage.flushSavesSync(), true);`);
  assert.equal(child.status, 0, child.stderr);
  unchanged(root, before);
  const saved = run(root, `${load}
    storage.logGroupMsg('50100', 'synthetic', 'new chat', '60100');
    assert.equal(storage.flushSavesSync(), true);
    assert.deepEqual(storage.users.legacy.custom, {keep:7});
    assert.deepEqual(storage.users.opaque, {v:1});
    assert.deepEqual(storage.groupChats.legacy, {custom:{keep:9}});
  `);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "group_chats.json"))).legacy, {custom:{keep:9}});
});

test("debounced logGroupMsg writes each store once and does not duplicate chat entries", t => {
  const root = sandbox(t);
  const child = run(root, `${load}
    const rename = fs.renameSync; const commits = [];
    fs.renameSync = (...args) => { commits.push(args[1]); return rename(...args); };
    storage.logGroupMsg('50100', 'synthetic', 'one', '60100');
    storage.logGroupMsg('50100', 'synthetic', 'two', '60100');
    assert.equal(commits.length, 0);
    await sleep(5500);
    assert.equal(storage.flushSavesSync(), true);
    assert.equal(commits.filter(file => file === CFG.memoryFile).length, 1);
    assert.equal(commits.filter(file => file === CFG.chatLogFile).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(CFG.memoryFile))['60100'].chats.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(CFG.chatLogFile))['50100'].length, 2);
  `);
  assert.equal(child.status, 0, child.stderr);
});

test("failed atomic saves attempt both stores, preserve bytes and retain dirty data for explicit flush", t => {
  const root = sandbox(t);
  const child = run(root, `${load}
    storage.logGroupMsg('50100', 'synthetic', 'old', '60100');
    assert.equal(storage.flushSavesSync(), true);
    const oldUsers = fs.readFileSync(CFG.memoryFile); const oldChats = fs.readFileSync(CFG.chatLogFile);
    const rename = fs.renameSync; const attempts = [];
    fs.renameSync = (...args) => { attempts.push(args[1]); throw new Error('synthetic disk failure'); };
    storage.logGroupMsg('50100', 'synthetic', 'pending', '60100');
    assert.equal(storage.flushSavesSync(), false);
    assert.deepEqual(attempts, [CFG.memoryFile, CFG.chatLogFile]);
    assert.deepEqual(fs.readFileSync(CFG.memoryFile), oldUsers);
    assert.deepEqual(fs.readFileSync(CFG.chatLogFile), oldChats);
    fs.renameSync = rename;
    assert.equal(storage.flushSavesSync(), true);
    assert.equal(JSON.parse(fs.readFileSync(CFG.memoryFile))['60100'].chats.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(CFG.chatLogFile))['50100'].length, 2);
  `);
  assert.equal(child.status, 0, child.stderr);
});
