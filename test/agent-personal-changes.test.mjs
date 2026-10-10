import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createPersonalChangeAdapter } from "../bridge/chat-tools/personal-changes.mjs";
import { createMemoryNoteService, memoryNotesSnapshot, applyMemoryNoteAction } from "../bridge/memory-profile/notes.mjs";
import { createJsonSaver, readJsonFile, writeJsonFileSync } from "../bridge/persistence/json-file.mjs";
import { getUserMemoryGeneration, getMemoryPrivacyGeneration, invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";
import { setUserDisplayName, setUserStylePreference, forgetUserData } from "../bridge/user-preferences.mjs";
import { registerAgentOwnedStateCleaner } from "../bridge/chat-tools/owned-state.mjs";
import { memoryProfiles, saveMemoryProfiles, flushMemoryProfilesSync } from "../bridge/memory-profile/store.mjs";
import { CFG } from "../bridge/config.mjs";
import { users, groupChats, saveUsers, saveGroupChats, flushSavesSync, logGroupMsg } from "../bridge/storage.mjs";

const USER = "60100";
const GROUP = "50100";
const NOW = 1790841600000;
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a3-personal-"));
  const userFile = path.join(directory, "users.json");
  const profileFile = path.join(directory, "profiles.json");
  const userStore = {};
  const profiles = {};
  const state = { writes: 0, flushes: 0, noteWrites: 0, noteInvalidations: 0, checks: 0,
    writable: true, permitted: true, privacy: { epoch: 0, users: {} }, now: NOW };
  const saver = createJsonSaver(userFile, () => userStore, { debounceMs: 60000 });
  const notes = createMemoryNoteService({ profiles, now: () => state.now, available: () => true,
    readPrivacy: () => state.privacy, invalidate: () => state.noteInvalidations++,
    persist: () => { state.noteWrites++; if (!state.writable) return false;
      writeJsonFileSync(profileFile, profiles, { durable: true }); return true; } });
  const options = { users: userStore, readPrivacy: () => state.privacy,
    saveUsers: () => { state.writes++; saver.markDirty(); },
    flushSavesSync: settings => { state.flushes++; assert.deepEqual(settings, { durable: true });
      return state.writable && saver.flushSync(settings); },
    memoryNotesSnapshot: scope => notes.snapshot(scope), applyMemoryNoteAction: (payload, context) => notes.act(payload, context), ...overrides };
  const adapter = createPersonalChangeAdapter(options);
  const control = new globalThis.AbortController();
  const runtime = { scope: { surface: "group", userId: USER, groupId: GROUP },
    cfg: { memoryFile: userFile, memoryProfileFile: profileFile, dataRoot: directory, agentWriteGroupWhitelist: [GROUP] }, userMessage: "叫我阿明", messageId: "0",
    signal: control.signal, assertCurrent: () => { state.checks++; }, isPermitted: () => state.permitted };
  cleanups.push(() => { saver.dispose(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  function prepare(args, message) {
    if (message !== undefined) runtime.userMessage = message;
    const result = adapter.prepare(args, runtime);
    assert.equal(result.status, "ready", JSON.stringify(result));
    return result.operation;
  }
  function commit(operation) { runtime.userMessage = "确认 cf_" + "0".repeat(32); return adapter.commit(operation, runtime); }
  function seed(scope = { userId: USER, groupId: GROUP }, body = "我的项目使用 Linux") {
    return notes.act({ ...scope, revision: notes.snapshot(scope).revision, action: "create", title: "项目", text: body },
      { origin: "user_command", messageId: "-7" }).items[0];
  }
  return { adapter, options, runtime, control, state, userStore, profiles, notes, prepare, commit, seed, userFile, profileFile };
}

function denied(result, reason) {
  assert.ok(["not_applied", "denied", "invalid_arguments", "unavailable"].includes(result.status));
  if (result.status === "not_applied") assert.equal(result.ok, false);
  else assert.deepEqual(Object.keys(result), ["status", "reason"]);
  if (reason) assert.equal(result.reason, reason);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|credential|C:\\|\/private|reasoning_content/);
}

function realDefaultFixture({ missing = "" } = {}) {
  assert.equal(process.env.NODE_ENV, "test");
  const root = path.resolve(process.env.QQBOT_DATA_DIR);
  for (const filename of [CFG.memoryFile, CFG.chatLogFile, CFG.memoryProfileFile]) {
    assert.ok(path.resolve(filename).startsWith(root + path.sep));
  }
  const original = [users, groupChats, memoryProfiles].map(value => globalThis.structuredClone(value));
  const groups = CFG.agentWriteGroupWhitelist;
  function replace(target, value) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, value);
  }
  function persist() {
    saveUsers(); saveGroupChats(); assert.equal(flushSavesSync({ durable: true }), true);
    assert.equal(saveMemoryProfiles(), true); assert.equal(flushMemoryProfilesSync(), true);
  }
  cleanups.push(() => {
    [users, groupChats, memoryProfiles].forEach((target, index) => replace(target, original[index]));
    CFG.agentWriteGroupWhitelist = groups; persist();
  });
  replace(users, {}); replace(groupChats, {});
  replace(memoryProfiles, { userProfiles: {}, groupProfiles: {}, userGroupProfiles: {} });
  CFG.agentWriteGroupWhitelist = [GROUP]; persist();
  if (missing) fs.rmSync(missing, { force: true });
  const runtime = { scope: { surface: "group", userId: USER, groupId: GROUP }, cfg: CFG,
    userMessage: "叫我阿明", messageId: "0", signal: new globalThis.AbortController().signal,
    assertCurrent: () => {}, isPermitted: scope => scope.surface === "group" && scope.userId === USER && scope.groupId === GROUP };
  const adapter = createPersonalChangeAdapter();
  function prepare(args, message) {
    runtime.userMessage = message;
    const result = adapter.prepare(args, runtime);
    assert.equal(result.status, "ready"); return result.operation;
  }
  function commit(op) {
    runtime.userMessage = "确认 cf_" + "2".repeat(32);
    return adapter.commit(op, runtime);
  }
  return { runtime, adapter, prepare, commit, persist };
}

for (const action of ["set_name", "set_style"]) {
  test("real default CAS " + action + " survives ordinary chats, nickname refresh and unrelated UID durable saves", () => {
    const f = realDefaultFixture();
    const value = action === "set_name" ? "阿明" : "简短 技术";
    const op = f.prepare({ action, value }, action === "set_name" ? "叫我阿明" : "回复风格 简短 技术");
    logGroupMsg(GROUP, "LatestNickname", "ordinary own group message", USER, "member", [], { messageId: "101" });
    logGroupMsg(GROUP, "OtherMember", "ordinary unrelated group message", "60200", "member", [], { messageId: "102" });
    f.persist();
    const chats = globalThis.structuredClone(users[USER].chats);
    const nicknames = [...users[USER].nicknames];
    const unrelated = globalThis.structuredClone(users["60200"]);
    const groups = globalThis.structuredClone(groupChats);
    const result = f.commit(op);
    assert.equal(result.status, "applied", "ordinary durable save must not invalidate an unchanged own preference");
    const disk = readJsonFile(CFG.memoryFile);
    assert.deepEqual(disk[USER].chats, chats); assert.deepEqual(disk["60200"], unrelated);
    for (const nickname of nicknames) assert.ok(disk[USER].nicknames.includes(nickname));
    assert.deepEqual(readJsonFile(CFG.chatLogFile), groups);
    if (action === "set_name") assert.equal(disk[USER].preferences.displayName, value);
    else { assert.equal(disk[USER].preferences.style.tone, "technical"); assert.equal(disk[USER].alias, "LatestNickname"); }
  });
}

test("real default CAS own note survives ordinary chats and unrelated profile debounce durable saves", () => {
  const f = realDefaultFixture();
  const op = f.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶" }, "记住我喜欢绿茶");
  logGroupMsg(GROUP, "LatestNickname", "ordinary own group message", USER, "member", [], { messageId: "103" });
  memoryProfiles.userProfiles[USER] = { summary: "ordinary inferred own profile", updatedAt: NOW };
  memoryProfiles.userProfiles["60200"] = { summary: "ordinary inferred unrelated profile", updatedAt: NOW };
  memoryProfiles.groupProfiles[GROUP] = { summary: "ordinary group profile", updatedAt: NOW };
  f.persist();
  const profiles = globalThis.structuredClone(memoryProfiles.userProfiles);
  assert.equal(f.commit(op).status, "applied", "profile debounce save must not invalidate unchanged own explicit notes");
  const disk = readJsonFile(CFG.memoryProfileFile);
  assert.deepEqual(disk.userProfiles, profiles);
  assert.equal(disk.groupProfiles[GROUP].summary, "ordinary group profile");
  assert.equal(disk.notes.items[0].text, "我喜欢绿茶");
  assert.equal(readJsonFile(CFG.memoryFile)[USER].nicknames[0], "LatestNickname");
});

for (const memory of [false, true]) {
  test("real default CAS first-boot missing " + (memory ? "profiles" : "users") + " may become durably saved without an own edit", () => {
    const filename = memory ? CFG.memoryProfileFile : CFG.memoryFile;
    const f = realDefaultFixture({ missing: filename });
    assert.equal(fs.existsSync(filename), false);
    const args = memory ? { action: "memory_create", title: "饮品", text: "我喜欢绿茶" } : { action: "set_name", value: "阿明" };
    const op = f.prepare(args, memory ? "记住我喜欢绿茶" : "叫我阿明");
    logGroupMsg(GROUP, "LatestNickname", "ordinary first-boot group message", USER, "member", [], { messageId: "104" });
    memoryProfiles.userProfiles["60200"] = { summary: "ordinary unrelated profile", updatedAt: NOW };
    f.persist(); assert.equal(fs.existsSync(filename), true);
    assert.equal(f.commit(op).status, "applied", "first ordinary checkpoint must not invalidate an unchanged own proposal");
    assert.equal(readJsonFile(CFG.memoryFile)[USER].chats[0].text, "ordinary first-boot group message");
    assert.equal(readJsonFile(CFG.memoryProfileFile).userProfiles["60200"].summary, "ordinary unrelated profile");
  });
}

for (const action of ["set_name", "set_style"]) {
  test("real default own preference edit still rejects stale " + action + " without overwriting the newer value", () => {
    const f = realDefaultFixture();
    const value = action === "set_name" ? "阿明" : "简短 技术";
    const op = f.prepare({ action, value }, action === "set_name" ? "叫我阿明" : "回复风格 简短 技术");
    if (action === "set_name") assert.equal(setUserDisplayName(USER, "新称呼").ok, true);
    else assert.equal(setUserStylePreference(USER, "详细 温柔").ok, true);
    f.persist();
    const latest = readJsonFile(CFG.memoryFile);
    denied(f.commit(op), "conflict");
    assert.deepEqual(readJsonFile(CFG.memoryFile), latest);
  });
}

test("real default own note edit still rejects a stale proposal without overwriting the newer revision", () => {
  const f = realDefaultFixture();
  const scope = { userId: USER, groupId: GROUP };
  const original = applyMemoryNoteAction({ ...scope, action: "create", title: "饮品", text: "我喜欢绿茶",
    revision: memoryNotesSnapshot(scope).revision }, { origin: "user_command", messageId: "105" }).items[0];
  const op = f.prepare({ action: "memory_update", noteId: original.id, text: "我喜欢红茶" },
    "更新我的记忆 " + original.id + " 我喜欢红茶");
  applyMemoryNoteAction({ ...scope, action: "update", id: original.id, text: "我喜欢白茶",
    revision: memoryNotesSnapshot(scope).revision }, { origin: "user_command", messageId: "106" });
  const latest = readJsonFile(CFG.memoryProfileFile);
  denied(f.commit(op), "conflict");
  assert.deepEqual(readJsonFile(CFG.memoryProfileFile), latest);
  assert.equal(latest.notes.items[0].text, "我喜欢白茶");
});

for (const memory of [false, true]) {
  for (const malformed of [false, true]) {
    test("real default " + (memory ? "profiles" : "users") + " corruption " + (malformed ? "schema" : "JSON") + " remains fail-closed at confirmation", () => {
      const f = realDefaultFixture();
      const filename = memory ? CFG.memoryProfileFile : CFG.memoryFile;
      const args = memory ? { action: "memory_create", title: "饮品", text: "我喜欢绿茶" } : { action: "set_name", value: "阿明" };
      const op = f.prepare(args, memory ? "记住我喜欢绿茶" : "叫我阿明");
      const damage = malformed ? JSON.stringify(memory ? { notes: null } : { [USER]: { preferences: [] } }) : "{broken";
      fs.writeFileSync(filename, damage);
      denied(f.commit(op), "storage_unavailable");
      assert.equal(fs.readFileSync(filename, "utf8"), damage);
      assert.equal(users[USER], undefined); assert.equal(memoryProfiles.notes, undefined);
    });
  }
  test("real default " + (memory ? "profiles" : "users") + " missing-after-seen remains fail-closed at confirmation", () => {
    const f = realDefaultFixture();
    const filename = memory ? CFG.memoryProfileFile : CFG.memoryFile;
    const args = memory ? { action: "memory_create", title: "饮品", text: "我喜欢绿茶" } : { action: "set_name", value: "阿明" };
    const op = f.prepare(args, memory ? "记住我喜欢绿茶" : "叫我阿明");
    fs.rmSync(filename);
    denied(f.commit(op), "storage_unavailable");
    assert.equal(fs.existsSync(filename), false);
    assert.equal(users[USER], undefined); assert.equal(memoryProfiles.notes, undefined);
  });
}

for (const [label, text] of [["basic", "Basic c3ludGhldGljOnNlY3JldA=="],
  ["thinking", "<thinking>synthetic private reasoning</thinking>"], ["home", "~/private/notes"],
  ["relative", "./private/notes"], ["assigned", "path=/srv/private/notes"]]) {
  test("real default rejects unsafe " + label + " in preparation and direct commit before persistence", () => {
    const f = realDefaultFixture();
    f.runtime.userMessage = "remember " + text;
    denied(f.adapter.prepare({ action: "memory_create", title: "Unsafe_" + label, text }, f.runtime), "invalid_arguments");
    const operation = f.prepare({ action: "memory_create", title: "Safe_" + label, text: "Safe literal body" }, "remember Safe literal body");
    operation.parameters.text = text;
    operation.preview = "将保存你的记忆：" + operation.parameters.title + "；内容：" + text + "；有效期：30天。";
    denied(f.commit(operation), "invalid_arguments");
    assert.equal(memoryProfiles.notes, undefined);
    assert.equal(readJsonFile(CFG.memoryProfileFile).notes, undefined);
  });
}

for (const style of [false, true]) {
  test("real default disk-only own " + (style ? "style" : "name") + " edit rejects stale RAM without rewriting the external value", () => {
    const f = realDefaultFixture();
    if (style) assert.equal(setUserStylePreference(USER, "正常 自然").ok, true);
    else assert.equal(setUserDisplayName(USER, "OriginalName").ok, true);
    f.persist();
    const operation = f.prepare({ action: style ? "set_style" : "set_name", value: style ? "简短 技术" : "ReviewedName" },
      style ? "回复风格 简短 技术" : "call me ReviewedName");
    const generation = getUserMemoryGeneration(USER);
    const latest = readJsonFile(CFG.memoryFile);
    if (style) { latest[USER].preferences.style.tone = "warm"; latest[USER].preferences.style.updatedAt++; }
    else latest[USER].preferences.displayName = "ExternalLatestName";
    writeJsonFileSync(CFG.memoryFile, latest, { durable: true });
    denied(f.commit(operation), "conflict");
    assert.deepEqual(readJsonFile(CFG.memoryFile), latest);
    assert.equal(getUserMemoryGeneration(USER), generation);
    if (style) assert.equal(users[USER].preferences.style.tone, "natural");
    else assert.equal(users[USER].preferences.displayName, "OriginalName");
  });
}

test("real default valid disk-only own note revision rejects a stale update without overwriting the latest body", () => {
  const f = realDefaultFixture();
  const scope = { userId: USER, groupId: GROUP };
  const original = applyMemoryNoteAction({ ...scope, action: "create", title: "Original", text: "Original own note",
    revision: memoryNotesSnapshot(scope).revision }, { origin: "user_command", messageId: "107" }).items[0];
  const operation = f.prepare({ action: "memory_update", noteId: original.id, text: "Reviewed own note" },
    "更新我的记忆 " + original.id + " Reviewed own note");
  const generation = getMemoryPrivacyGeneration();
  const latest = readJsonFile(CFG.memoryProfileFile);
  latest.notes.items[0].text = "Valid external latest note";
  latest.notes.items[0].revision++; latest.notes.revision++;
  assert.equal(createMemoryNoteService({ profiles: latest, available: () => true,
    readPrivacy: () => ({ users: {} }) }).snapshot(scope).ok, true);
  writeJsonFileSync(CFG.memoryProfileFile, latest, { durable: true });
  denied(f.commit(operation), "conflict");
  assert.deepEqual(readJsonFile(CFG.memoryProfileFile), latest);
  assert.equal(memoryProfiles.notes.items[0].text, "Original own note");
  assert.equal(getMemoryPrivacyGeneration(), generation);
});

test("unknown default rename-after-write latches reads and checkpoints so the durable new note is never erased", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a3-default-note-unknown-"));
  cleanups.push(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const entry = name => JSON.stringify(new globalThis.URL("../bridge/" + name, import.meta.url).href);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    globalThis.fetch = async () => { throw new Error('network forbidden in unknown-note fixture'); };
    const { CFG } = await import(${entry("config.mjs")});
    const { createPersonalChangeAdapter } = await import(${entry("chat-tools/personal-changes.mjs")});
    const { memoryProfiles, memoryProfilesAvailable, saveMemoryProfiles, flushMemoryProfilesSync } = await import(${entry("memory-profile/store.mjs")});
    const { memoryNotesSnapshot } = await import(${entry("memory-profile/notes.mjs")});
    const { readJsonFile } = await import(${entry("persistence/json-file.mjs")});
    CFG.agentWriteGroupWhitelist = ['50100'];
    const adapter = createPersonalChangeAdapter();
    const scope = { surface: 'group', userId: '60100', groupId: '50100' };
    const runtime = { scope, cfg: CFG, userMessage: 'remember Persisted new body', messageId: '0',
      signal: new AbortController().signal, assertCurrent() {}, isPermitted: () => true };
    const prepared = adapter.prepare({ action: 'memory_create', title: 'Partial', text: 'Persisted new body' }, runtime);
    assert.equal(prepared.status, 'ready');
    const rename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (!injected && path.resolve(to) === path.resolve(CFG.memoryProfileFile)) {
        injected = true; throw new Error('synthetic_after_profile_rename');
      }
    };
    let result;
    try { result = adapter.commit(prepared.operation, runtime); }
    finally { fs.renameSync = rename; }
    assert.equal(injected, true); assert.equal(result.status, 'unknown');
    assert.equal(readJsonFile(CFG.memoryProfileFile).notes.items[0].text, 'Persisted new body');
    assert.equal(memoryProfiles.notes.items[0].text, 'Persisted new body');
    assert.equal(memoryProfilesAvailable(), false);
    assert.throws(() => memoryNotesSnapshot(scope), error => error.statusCode === 503);
    memoryProfiles.userProfiles['60200'] = { summary: 'Unrelated later profile update' };
    assert.equal(saveMemoryProfiles(), false);
    assert.equal(flushMemoryProfilesSync(), false);
    assert.equal(readJsonFile(CFG.memoryProfileFile).notes.items[0].text, 'Persisted new body');
    assert.equal(readJsonFile(CFG.memoryProfileFile).userProfiles['60200'], undefined);
    assert.equal(adapter.prepare({ action: 'memory_create', title: 'Blocked', text: 'Persisted new body' }, runtime).status, 'unavailable');
    console.log('RESULT ' + JSON.stringify({ status: result.status, readBlocked: true, checkpointBlocked: true, durableNotePreserved: true }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory, encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: directory, QQBOT_DATA_DIR: directory,
      QQBOT_LOG_DIR: path.join(directory, "logs"), QQBOT_TEMP_DIR: directory,
      QQBOT_MEMORY_PROFILE_FILE: path.join(directory, "profiles.json") },
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout.split("\n").find(line => line.startsWith("RESULT ")).slice(7));
  assert.deepEqual(result, { status: "unknown", readBlocked: true, checkpointBlocked: true, durableNotePreserved: true });
});

test("preparation is pure for all five actions and never invokes legacy setters or savers", () => {
  const forbidden = () => { throw new Error("setter invoked"); };
  const f = fixture({ setUserDisplayName: forbidden, setUserStylePreference: forbidden, saveUsers: forbidden,
    flushSavesSync: forbidden, applyMemoryNoteAction: forbidden });
  const item = f.seed();
  const before = JSON.stringify([f.userStore, f.profiles]);
  const generations = [getUserMemoryGeneration(USER), getMemoryPrivacyGeneration()];
  const counts = [f.state.writes, f.state.noteWrites, f.state.noteInvalidations];
  const operations = [f.prepare({ action: "set_name", value: "阿明" }),
    f.prepare({ action: "set_style", value: "简短 技术 少吐槽" }, "回复风格 简短 技术 少吐槽"),
    f.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶", ttlDays: 2 }, "记住我喜欢绿茶"),
    f.prepare({ action: "memory_update", noteId: item.id, text: "我的项目使用容器" }, "更新我的记忆 " + item.id + " 我的项目使用容器"),
    f.prepare({ action: "memory_remove", noteId: item.id }, "删除我的记忆 " + item.id)];
  assert.equal(JSON.stringify([f.userStore, f.profiles]), before);
  assert.deepEqual([getUserMemoryGeneration(USER), getMemoryPrivacyGeneration()], generations);
  assert.deepEqual([f.state.writes, f.state.noteWrites, f.state.noteInvalidations], counts);
  for (const op of operations) {
    assert.deepEqual(Object.keys(op), ["domain", "action", "parameters", "baseline", "preview"]);
    assert.match(op.baseline.revision, /^[a-f0-9]{64}$/); assert.match(op.baseline.sourceIdentity, /^[a-f0-9]{64}$/);
    assert.ok(op.preview.length <= 1200 && JSON.stringify(op).length <= 4096);
    assert.doesNotMatch(JSON.stringify(op), /dataRoot|userId|groupId|memoryFile/);
    assert.deepEqual(JSON.parse(JSON.stringify(op)), op);
  }
});

test("name and style commit reuse setters and durably persist before fixed acknowledgements", () => {
  const f = fixture();
  const generation = getUserMemoryGeneration(USER);
  const name = f.prepare({ action: "set_name", value: "阿明" });
  const applied = f.commit(name);
  assert.deepEqual(applied, { ok: true, status: "applied", text: "已更新你的称呼。" });
  assert.equal(readJsonFile(f.userFile)[USER].preferences.displayName, "阿明");
  assert.equal(getUserMemoryGeneration(USER), generation + 1);
  const style = f.prepare({ action: "set_style", value: "简短 技术" }, "@夜星 请把我的回复风格改为简短 技术");
  assert.equal(f.commit(style).status, "applied");
  const disk = readJsonFile(f.userFile)[USER];
  assert.equal(disk.preferences.style.length, "short"); assert.equal(disk.preferences.style.tone, "technical");
  assert.deepEqual([f.state.writes, f.state.flushes], [2, 2]);
  denied(f.commit(name), "conflict");
});

test("durable success survives setter invalidation of old assertCurrent and signal", () => {
  const f = fixture({ setUserDisplayName: (uid, value, settings) => {
    const result = setUserDisplayName(uid, value, settings); f.control.abort(); return result; } });
  const op = f.prepare({ action: "set_name", value: "阿明" });
  const generation = getUserMemoryGeneration(USER);
  f.runtime.assertCurrent = () => { assert.equal(getUserMemoryGeneration(USER), generation); };
  assert.equal(f.commit(op).status, "applied");
  assert.equal(readJsonFile(f.userFile)[USER].alias, "阿明");
});

test("memory create, update and remove use own group CAS with real durable files and source zero", () => {
  const f = fixture();
  const create = f.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶", ttlDays: 2 }, "请帮我记住我喜欢绿茶");
  assert.equal(f.commit(create).status, "applied");
  let item = readJsonFile(f.profileFile).notes.items[0];
  assert.deepEqual([item.userId, item.groupId, item.source.kind, item.source.messageId], [USER, GROUP, "user_command", "0"]);
  assert.equal(item.expiresAt, NOW + 2 * 86400000);
  f.state.now++;
  const update = f.prepare({ action: "memory_update", noteId: item.id, text: "我喜欢红茶" }, "修改我的记忆 " + item.id + " 我喜欢红茶");
  f.runtime.messageId = "-9";
  assert.equal(f.commit(update).status, "applied");
  item = readJsonFile(f.profileFile).notes.items[0];
  assert.equal(item.text, "我喜欢红茶"); assert.equal(item.revision, 2); assert.equal(item.source.messageId, "-9");
  f.state.now++;
  const remove = f.prepare({ action: "memory_remove", noteId: item.id }, "删除我的记忆 " + item.id);
  assert.equal(f.commit(remove).status, "applied");
  assert.equal(readJsonFile(f.profileFile).notes.items.length, 0);
  assert.deepEqual([f.state.noteWrites, f.state.noteInvalidations], [3, 3]);
});

test("explicitly reviewed existing own note can retain its body without invented model text", () => {
  const f = fixture(); const item = f.seed(); f.state.now++;
  const op = f.prepare({ action: "memory_update", noteId: item.id, text: item.text }, "更新我的记忆 " + item.id + " 已核对原文，保留原文");
  assert.equal(f.commit(op).status, "applied");
  assert.equal(readJsonFile(f.profileFile).notes.items[0].text, item.text);
});

test("default deny requires every runtime guard and canonical own group identity", () => {
  for (const patch of [{ assertCurrent: undefined }, { isPermitted: undefined }, { signal: undefined }, { cfg: undefined },
    { scope: { surface: "private", userId: USER, groupId: "private" } },
    { scope: { surface: "group", userId: "060100", groupId: GROUP } },
    { scope: { surface: "group", userId: USER, groupId: "0" } }, { messageId: undefined }, { userMessage: "" }]) {
    const f = fixture(); Object.assign(f.runtime, patch);
    denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime));
    assert.equal(f.state.writes, 0);
  }
  const f = fixture(); f.state.permitted = false;
  denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "not_allowed");
  for (const groups of [undefined, [], ["50101"]]) {
    const p = fixture(); p.runtime.cfg.agentWriteGroupWhitelist = groups;
    denied(p.adapter.prepare({ action: "set_name", value: "阿明" }, p.runtime), "not_allowed");
  }
});

test("canonical message identity accepts zero and bounded signed decimal but no aliases", () => {
  const f = fixture();
  for (const id of [0, "0", -9, "-9", "9".repeat(20), "-" + "9".repeat(20)]) {
    f.runtime.messageId = id; f.runtime.userMessage = "叫我阿明";
    assert.equal(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime).status, "ready");
  }
  for (const id of [-0, "-0", "+1", "01", "-01", "9".repeat(21), 1.5, Number.MAX_SAFE_INTEGER + 1, {}, 1n]) {
    f.runtime.messageId = id;
    denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "invalid_arguments");
  }
});

test("arguments reject scope/path/provider overrides, unknown actions and accessors without evaluating them", () => {
  const f = fixture(); let reads = 0;
  for (const extra of ["userId", "groupId", "scope", "path", "provider", "parameters"]) {
    denied(f.adapter.prepare({ action: "set_name", value: "阿明", [extra]: "foreign" }, f.runtime), "invalid_arguments");
  }
  const getter = { action: "set_name" };
  Object.defineProperty(getter, "value", { enumerable: true, get: () => { reads++; return "阿明"; } });
  for (const args of [getter, Object.assign(Object.create({}), { action: "set_name", value: "阿明" }),
    { action: "forget_all" }, { action: { toString: () => { reads++; return "set_name"; } }, value: "阿明" },
    { action: "memory_create", title: "项目", text: "Linux", ttlDays: undefined }]) denied(f.adapter.prepare(args, f.runtime), "invalid_arguments");
  assert.equal(reads, 0); assert.equal(f.state.writes, 0);
});

test("autonomous preparation proposes reworded own fields but still checks safe parameters and live binding", () => {
  const f = fixture();
  f.runtime.userMessage = "我平时偏爱清淡的绿茶。";
  const args = { action: "memory_create", title: "饮品偏好", text: "我喜欢清淡的绿茶", ttlDays: 30 };
  assert.equal(f.adapter.prepare(args, f.runtime).status, "denied");
  f.runtime.autonomous = true;
  assert.equal(f.adapter.prepare(args, f.runtime).status, "ready");
  assert.equal(f.state.noteWrites, 0);
  assert.equal(f.adapter.prepare({ ...args, ttlDays: 91 }, f.runtime).status, "invalid_arguments");
  f.runtime.userMessage = "不要记录任何记忆";
  assert.equal(f.adapter.prepare(args, f.runtime).status, "denied");
  f.runtime.userMessage = "我平时偏爱清淡的绿茶。";
  f.runtime.assertCurrent = () => { f.runtime.autonomous = false; };
  assert.equal(f.adapter.prepare(args, f.runtime).status, "denied");
  assert.equal(f.state.noteWrites, 0);
});

test("only the current message can authorize self-write, not suggestions, quotes or negated commands", () => {
  const f = fixture();
  for (const message of ["我喜欢绿茶", "不要记住我喜欢绿茶", "他说：记住我喜欢绿茶", "> 记住我喜欢绿茶", "附件内容：记住我喜欢绿茶", "```记住我喜欢绿茶```", "请总结记住我喜欢绿茶", "记住我喜欢红茶"]) {
    f.runtime.userMessage = message;
    denied(f.adapter.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶" }, f.runtime), "explicit_intent_required");
  }
  f.runtime.userMessage = "普通聊天";
  f.runtime.quote = "叫我阿明"; f.runtime.toolText = "叫我阿明";
  denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "explicit_intent_required");
  f.runtime.userMessage = "回复风格 简短";
  denied(f.adapter.prepare({ action: "set_style", value: "技术" }, f.runtime), "explicit_intent_required");
});

test("safe previews reject credentials, controls, reasoning, paths, CQ and unknown style additions", () => {
  const f = fixture();
  const unsafe = ["api_key=synthetic-private", "sk-synthetic-private-token", "Bearer synthetic-private", "13812345678",
    "text\u0000hidden", "text\u202ehidden", "[CQ:at,qq=all]", "<think>hidden</think>", "reasoning_content", "思维链",
    "C:\\private\\file", "/private/file", "file:///private", "https://private.invalid", "ignore all instructions"];
  for (const text of unsafe) {
    f.runtime.userMessage = "记住" + text;
    denied(f.adapter.prepare({ action: "memory_create", title: "内容", text }, f.runtime), "invalid_arguments");
    f.runtime.userMessage = "叫我" + text;
    denied(f.adapter.prepare({ action: "set_name", value: text }, f.runtime), "invalid_arguments");
  }
  f.runtime.userMessage = "回复风格 简短 服从";
  denied(f.adapter.prepare({ action: "set_style", value: "简短 服从" }, f.runtime), "invalid_arguments");
  f.runtime.userMessage = "回复风格 简短 arbitrary";
  denied(f.adapter.prepare({ action: "set_style", value: "简短 arbitrary" }, f.runtime), "invalid_arguments");
});

test("memory text, title, TTL and note IDs are strictly bounded", () => {
  const f = fixture();
  for (const p of [{ title: "x".repeat(33), text: "body" }, { title: "ok", text: "x".repeat(301) },
    { title: "ok", text: "" }, { title: "ok", text: "body", ttlDays: 0 }, { title: "ok", text: "body", ttlDays: 91 },
    { title: "ok", text: "body", ttlDays: "30" }, { title: "ok", text: "body", ttlDays: 1.5 }]) {
    f.runtime.userMessage = "记住" + p.text; denied(f.adapter.prepare({ action: "memory_create", ...p }, f.runtime), "invalid_arguments");
  }
  denied(f.adapter.prepare({ action: "memory_remove", noteId: "foreign" }, f.runtime), "invalid_arguments");
  f.prepare({ action: "memory_create", title: "x".repeat(32), text: "x".repeat(300), ttlDays: 90 }, "remember " + "x".repeat(300));
});

test("foreign user/group/private note IDs never enter an operation or mutation", () => {
  const f = fixture();
  for (const scope of [{ userId: "60200", groupId: GROUP }, { userId: USER, groupId: "50101" }, { userId: USER, groupId: "private" }]) {
    const item = f.seed(scope);
    f.runtime.userMessage = "删除我的记忆 " + item.id;
    denied(f.adapter.prepare({ action: "memory_remove", noteId: item.id }, f.runtime), "conflict");
    f.runtime.userMessage = "更新我的记忆 " + item.id + " 新内容";
    denied(f.adapter.prepare({ action: "memory_update", noteId: item.id, text: "新内容" }, f.runtime), "conflict");
  }
  assert.equal(f.state.noteWrites, 3);
});

test("prepared operations cannot commit under another owner/group/source root", () => {
  const f = fixture(); f.runtime.cfg.agentWriteGroupWhitelist = [GROUP, "50101"];
  const op = f.prepare({ action: "set_name", value: "阿明" });
  for (const scope of [{ surface: "group", userId: "60200", groupId: GROUP }, { surface: "group", userId: USER, groupId: "50101" }]) {
    f.runtime.scope = scope; denied(f.commit(op), "conflict");
  }
  f.runtime.scope = { surface: "group", userId: USER, groupId: GROUP };
  f.runtime.cfg.memoryFile += ".other"; denied(f.commit(op), "conflict");
  assert.equal(f.state.writes, 0); assert.deepEqual(f.userStore, {});
});

test("preference, note CAS, privacy generation and forget cutoff changes reject before any new writes", () => {
  const f = fixture(); const name = f.prepare({ action: "set_name", value: "阿明" });
  setUserStylePreference(USER, "简短", { users: f.userStore, skipSave: true });
  denied(f.commit(name), "conflict");
  const item = f.seed();
  const remove = f.prepare({ action: "memory_remove", noteId: item.id }, "删除我的记忆 " + item.id);
  f.state.now++;
  f.notes.act({ userId: USER, groupId: GROUP, action: "update", id: item.id,
    revision: f.notes.snapshot({ userId: USER, groupId: GROUP }).revision, text: "我的项目使用容器" },
  { origin: "user_command", messageId: "8" });
  denied(f.commit(remove), "conflict");
  const next = f.prepare({ action: "set_name", value: "阿明" }, "叫我阿明");
  f.state.privacy.epoch++; f.state.privacy.users[USER] = NOW;
  denied(f.commit(next), "conflict");
  const last = f.prepare({ action: "set_name", value: "阿明" }, "叫我阿明");
  invalidateMemoryPrivacyGeneration(); denied(f.commit(last), "conflict");
  assert.equal(f.state.writes, 0);
});

test("permissions, cancellation and old-context guards are rechecked at commit", () => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.runtime.cfg.agentWriteGroupWhitelist = []; }, f => f.control.abort(),
    f => { f.runtime.assertCurrent = () => false; },
    f => { f.runtime.assertCurrent = () => { throw new Error("synthetic-private credential /private"); }; }]) {
    const f = fixture(); const op = f.prepare({ action: "set_name", value: "阿明" }); mutate(f);
    denied(f.commit(op)); assert.equal(f.state.writes, 0); assert.deepEqual(f.userStore, {});
  }
});

test("guard callbacks cannot rebind the source message, config, scope or signal during a request", () => {
  for (const mutate of [f => { f.runtime.userMessage = "changed"; }, f => { f.runtime.messageId = "8"; },
    f => { f.runtime.scope.groupId = "50101"; }, f => { f.runtime.cfg.memoryFile += ".other"; },
    f => { f.runtime.signal = new globalThis.AbortController().signal; }, f => { f.runtime.assertCurrent = () => {}; }]) {
    const f = fixture(); f.runtime.isPermitted = () => { mutate(f); return true; };
    denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "stale_request");
    assert.equal(f.state.writes, 0);
  }
});

test("operations reject altered previews, extra fields, invalid baseline and nested getters", () => {
  const f = fixture(); const original = f.prepare({ action: "set_name", value: "阿明" }); let reads = 0;
  for (const mutate of [op => { op.preview = "invented"; }, op => { op.userId = "60200"; },
    op => { op.parameters.path = "/private"; }, op => { op.parameters.action = "set_style"; },
    op => { op.baseline.revision = "0"; }, op => { op.baseline.path = "private"; },
    op => { Object.defineProperty(op.parameters, "value", { enumerable: true, get: () => { reads++; return "阿明"; } }); },
    op => { Object.defineProperty(op, "baseline", { enumerable: true, get: () => { reads++; return original.baseline; } }); }]) {
    const op = globalThis.structuredClone(original); mutate(op); denied(f.commit(op), "invalid_arguments");
  }
  assert.equal(reads, 0); assert.equal(f.state.writes, 0);
});

test("save failure or throw after a setter is unknown and never rolls back or retries", () => {
  for (const mode of ["false", "throw", "undefined"]) {
    const f = fixture({ flushSavesSync: () => { f.state.flushes++;
      if (mode === "throw") throw new Error("synthetic-private credential /private");
      return mode === "false" ? false : undefined; } });
    const op = f.prepare({ action: "set_name", value: "阿明" }); const result = f.commit(op);
    assert.equal(result.status, "unknown"); assert.equal(result.ok, false);
    assert.equal(f.userStore[USER].preferences.displayName, "阿明");
    assert.deepEqual([f.state.writes, f.state.flushes], [1, 1]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|credential|\/private/);
    denied(f.commit(op), "conflict");
  }
});

test("partial durable preference write remains new and is reported unknown without rollback", () => {
  const f = fixture({ flushSavesSync: () => {
    f.state.flushes++; writeJsonFileSync(f.userFile, f.userStore, { durable: true });
    throw new Error("directory fsync uncertain /private"); } });
  const op = f.prepare({ action: "set_name", value: "阿明" });
  assert.equal(f.commit(op).status, "unknown");
  assert.equal(readJsonFile(f.userFile)[USER].alias, "阿明");
  assert.equal(f.userStore[USER].alias, "阿明"); assert.equal(f.state.flushes, 1);
});

test("setter exception or false service result cannot claim no write or durable success", () => {
  for (const outcome of [false, "throw"]) {
    const f = fixture({ setUserDisplayName: (uid, value, settings) => {
      setUserDisplayName(uid, value, settings);
      if (outcome === "throw") throw new Error("synthetic-private"); return { ok: false }; } });
    const op = f.prepare({ action: "set_name", value: "阿明" });
    assert.equal(f.commit(op).status, "unknown"); assert.equal(f.userStore[USER].alias, "阿明");
    assert.deepEqual([f.state.writes, f.state.flushes], [0, 0]);
  }
});

test("note service persistence failure is unknown even when its legacy in-memory rollback restores baseline", () => {
  const f = fixture(); const op = f.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶" }, "记住我喜欢绿茶");
  f.state.writable = false;
  const result = f.commit(op); assert.equal(result.status, "unknown"); assert.equal(result.ok, false);
  assert.equal(f.state.noteWrites, 1); assert.equal(f.state.noteInvalidations, 0);
  assert.equal(fs.existsSync(f.profileFile), false);
});

test("partial note persistence followed by exception is unknown and no adapter rollback removes the disk value", () => {
  const f = fixture({ applyMemoryNoteAction: (payload, context) => {
    f.notes.act(payload, context); throw new Error("synthetic-private receipt error"); } });
  const op = f.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶" }, "记住我喜欢绿茶");
  const result = f.commit(op); assert.equal(result.status, "unknown");
  assert.equal(readJsonFile(f.profileFile).notes.items[0].text, "我喜欢绿茶");
  assert.equal(f.state.noteWrites, 1); assert.doesNotMatch(JSON.stringify(result), /receipt|synthetic-private/);
});

test("corrupt existing memory/user/privately unreadable state fails closed before setters", () => {
  const f = fixture(); f.profiles.notes = null;
  f.runtime.userMessage = "记住我喜欢绿茶";
  denied(f.adapter.prepare({ action: "memory_create", title: "饮品", text: "我喜欢绿茶" }, f.runtime), "storage_unavailable");
  f.userStore[USER] = { preferences: [] }; f.runtime.userMessage = "叫我阿明";
  denied(f.adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "storage_unavailable");
  const p = fixture({ readPrivacy: () => { throw new Error("synthetic-private credential /private"); } });
  denied(p.adapter.prepare({ action: "set_name", value: "阿明" }, p.runtime), "storage_unavailable");
  assert.equal(f.state.writes + f.state.noteWrites + p.state.writes, 0);
});

test("default storage adapter rejects actual disk corruption and missing-after-seen, isolated config only", () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(path.resolve(CFG.memoryFile).startsWith(path.resolve(process.env.QQBOT_DATA_DIR) + path.sep));
  const filename = CFG.memoryFile;
  const old = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
  cleanups.push(() => { if (old) fs.writeFileSync(filename, old); else fs.rmSync(filename, { force: true }); delete users[USER]; });
  const f = fixture(); const adapter = createPersonalChangeAdapter();
  const groups = CFG.agentWriteGroupWhitelist; CFG.agentWriteGroupWhitelist = [GROUP];
  cleanups.push(() => { CFG.agentWriteGroupWhitelist = groups; });
  f.runtime.cfg = CFG;
  writeJsonFileSync(filename, {});
  const op = adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime);
  assert.equal(op.status, "ready");
  fs.writeFileSync(filename, "{broken");
  denied(adapter.commit(op.operation, f.runtime), "storage_unavailable");
  assert.equal(users[USER], undefined); assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  fs.rmSync(filename);
  denied(adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime), "storage_unavailable");
});

test("default setters and existing storage saver persist through the isolated runtime roots", () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(path.resolve(CFG.memoryFile).startsWith(path.resolve(process.env.QQBOT_DATA_DIR) + path.sep));
  const f = fixture(); f.runtime.cfg = CFG;
  const groups = CFG.agentWriteGroupWhitelist; CFG.agentWriteGroupWhitelist = [GROUP];
  cleanups.push(() => { CFG.agentWriteGroupWhitelist = groups; });
  const adapter = createPersonalChangeAdapter();
  const op = adapter.prepare({ action: "set_name", value: "阿明" }, f.runtime);
  assert.equal(op.status, "ready");
  f.runtime.userMessage = "确认 cf_" + "1".repeat(32);
  assert.equal(adapter.commit(op.operation, f.runtime).status, "applied");
  assert.equal(readJsonFile(CFG.memoryFile)[USER].preferences.displayName, "阿明");
});

test("forget invokes every synchronous owned-state cleaner with persist false and aggregates failure safely", () => {
  const calls = [];
  cleanups.push(registerAgentOwnedStateCleaner((uid, options) => { calls.push([uid, options]); return true; }));
  cleanups.push(registerAgentOwnedStateCleaner(() => { calls.push("failed"); throw new Error("synthetic-private credential /private"); }));
  cleanups.push(registerAgentOwnedStateCleaner(() => { calls.push("after_failure"); return true; }));
  const result = forgetUserData(USER, { users: {}, groupChats: {}, skipSave: true });
  assert.deepEqual(calls, [[USER, { persist: false }], "failed", "after_failure"]);
  assert.equal(result.ok, false);
  assert.match(result.text, /待确认操作或提醒/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|credential|\/private/);
});

test("forget cleaner must return literal true; promises, partial and missing confirmation fail closed", () => {
  for (const value of [undefined, false, { status: "partial" }, Promise.resolve(true)]) {
    const unregister = registerAgentOwnedStateCleaner(() => value);
    try { assert.equal(forgetUserData(USER, { users: {}, groupChats: {}, skipSave: true }).ok, false); }
    finally { unregister(); }
  }
  const unregister = registerAgentOwnedStateCleaner(() => true);
  try { assert.equal(forgetUserData(USER, { users: {}, groupChats: {}, skipSave: true }).ok, true); }
  finally { unregister(); }
});

test("forget owned-state cleanup runs even when existing memory cleanup fails", () => {
  const original = memoryProfiles.notes;
  memoryProfiles.notes = null;
  let calls = 0;
  cleanups.push(() => { if (original === undefined) delete memoryProfiles.notes; else memoryProfiles.notes = original; });
  cleanups.push(registerAgentOwnedStateCleaner(() => { calls++; return true; }));
  const result = forgetUserData(USER, { users: {}, groupChats: {}, skipSave: true });
  assert.equal(calls, 1); assert.equal(result.ok, false);
  assert.match(result.text, /明确记忆文件/);
});

test("forget owned-state cleanup receives durable persist true under isolated default storage", () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(path.resolve(CFG.memoryFile).startsWith(path.resolve(process.env.QQBOT_DATA_DIR) + path.sep));
  let received;
  cleanups.push(registerAgentOwnedStateCleaner((uid, options) => { received = [uid, options]; return true; }));
  const result = forgetUserData(USER);
  assert.deepEqual(received, [USER, { persist: true }]); assert.equal(result.ok, true);
});

test("forget invokes owned-state cleaners before a throwing legacy summary ledger without rewriting the old API", () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(path.resolve(CFG.memoryFile).startsWith(path.resolve(process.env.QQBOT_DATA_DIR) + path.sep));
  let called = false;
  cleanups.push(registerAgentOwnedStateCleaner(() => { called = true; return true; }));
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).endsWith("privacy.json")) {
      assert.equal(called, true); throw new Error("synthetic ledger failure");
    }
    return rename(...args);
  };
  try { assert.throws(() => forgetUserData(USER), /synthetic ledger failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(called, true);
});
