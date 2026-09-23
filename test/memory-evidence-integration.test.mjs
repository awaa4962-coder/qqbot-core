import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-evidence-"));
Object.assign(process.env, { QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { CFG } = await import("../bridge/config.mjs");
const { memoryNotesSnapshot, applyMemoryNoteAction, memoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { memoryProfiles } = await import("../bridge/memory-profile.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { users, groupChats } = await import("../bridge/storage.mjs");
const { forgetUserData, setUserDisplayName } = await import("../bridge/user-preferences.mjs");
const { handleAdminApiRequest } = await import("../bridge/admin-api/routes.mjs");
const { withChatRun, assertChatRunCurrent } = await import("../bridge/cognition/chat-run.mjs");
const { createTraceRecorder, withMessageTrace } = await import("../bridge/diagnostics/message-trace.mjs");
const { recordConversationTurn, getConversationThread } = await import("../bridge/cognition/index.mjs");
const { processEvent } = await import("../bridge/reply.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { buildMemoryCommandReplyAsync } = await import("../bridge/commands/modules/memory.mjs");
CFG.groupWhitelist = [50100]; CFG.friendWhitelist = [60100]; CFG.botBlacklist = [];
const scope = { userId: "60100", groupId: "50100" };
function save(payload = {}, context = {}) {
  return applyMemoryNoteAction({ ...scope, action: "create", title: "项目", text: "项目只部署 Linux", revision: memoryNotesSnapshot(scope).revision, ...payload }, context);
}
async function api(method, query = "", body, authorized = true) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  Object.assign(req, { method, url: "/admin/memory" + query, headers: authorized ? { "x-qqfriend-admin-token": "synthetic-admin" } : {}, socket: { remoteAddress: "127.0.0.1" } });
  let result;
  await handleAdminApiRequest(req, {}, { requiredToken: "synthetic-admin", pathname: "/admin/memory", url: new URL(req.url, "http://localhost"),
    sendJson: (_res, status, value) => { result = { status, value }; } });
  return result;
}

test("memory API requires management auth and an explicit whitelisted scope", async () => {
  assert.equal((await api("GET", "?userId=60100&groupId=50100", null, false)).status, 403);
  assert.equal((await api("GET")).status, 400);
  assert.equal((await api("GET", "?userId=60100&groupId=50101")).status, 403);
  assert.equal((await api("GET", "?userId=60100&groupId=private")).value.items.length, 0);
});

test("memory API uses revisions and server-assigned operator provenance, without auditing contents", async () => {
  const view = (await api("GET", "?userId=60100&groupId=50100")).value;
  const payload = { ...scope, revision: view.revision, action: "create", title: "ADMIN_ONLY_TITLE", text: "ADMIN_ONLY_BODY", origin: "user_command", source: { kind: "user_command", messageId: 999 } };
  const result = await api("POST", "", payload);
  assert.equal(result.status, 200);
  assert.equal(result.value.items[0].kind, "operator_note");
  assert.equal(result.value.items[0].source.messageId, "");
  assert.equal((await api("POST", "", payload)).status, 409);
  const audit = fs.readFileSync(CFG.adminAuditFile, "utf8");
  assert.doesNotMatch(audit, /ADMIN_ONLY_TITLE|ADMIN_ONLY_BODY|60100|synthetic-admin/);
});

test("corrected source statements do not reappear via history or group-background retrieval", () => {
  const original = save({}, { origin: "user_command", messageId: 80100 }).items.find(item => item.title === "项目");
  recordConversationTurn({ uid: scope.userId, groupId: scope.groupId, messageId: 80000, userText: "我的项目怎么部署", assistantText: "OLD_THREAD_ASSERTION", now: Date.now() - 1000 }, { save: false });
  recordConversationTurn({ uid: scope.userId, groupId: "50101", messageId: 80001, userText: "其他项目怎么部署", assistantText: "OTHER_GROUP_THREAD", now: Date.now() - 1000 }, { save: false });
  save({ action: "update", id: original.id, text: "项目现在部署 Debian 容器" }, { origin: "user_command", messageId: 80101 });
  Object.assign(users[scope.userId], { nicknames: [], chats: [{ group: scope.groupId, text: "项目只部署 Linux", messageId: "80100", ts: Date.now() - 100 }] });
  groupChats[scope.groupId] = [{ uid: scope.userId, text: "项目只部署 Linux", messageId: "80100", ts: Date.now() - 100 }];
  const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "我的项目现在怎么部署？", userName: "测试者" });
  assert.match(JSON.stringify(packet.messages), /Debian/);
  assert.doesNotMatch(JSON.stringify(packet.messages), /项目只部署 Linux/);
  assert.doesNotMatch(JSON.stringify(packet.messages), /OLD_THREAD_ASSERTION|OTHER_GROUP_THREAD/);
  assert.ok(getConversationThread(scope.userId, "50101"));
  assert.ok(packet.retrieval.sources.some(source => source.kind === "note" && source.revision === 2));
});

test("explicit preferences remain authoritative and legacy inferred fields are not factual prompt input", () => {
  setUserDisplayName(scope.userId, "小甲", { skipSave: true });
  memoryProfiles.userGroupProfiles[scope.groupId + ":" + scope.userId] = { expiresAt: Date.now() + 60000, confidence: 1, recentTopics: ["OLD_UNSOURCED_TOPIC"] };
  const packet = buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "项目进展", userName: "旧名" });
  assert.match(packet.currentInput, /小甲/);
  assert.doesNotMatch(JSON.stringify(packet.messages), /OLD_UNSOURCED_TOPIC|confidence=/);
  assert.ok(packet.messages.some(item => item.content.includes("用户主动设置")));
});

test("note diagnostics expose IDs and revisions, never the note body or private scope", async () => {
  const recorder = createTraceRecorder();
  await withMessageTrace({ group_id: scope.groupId, user_id: scope.userId }, () => {
    buildReplyContextPacket({ uid: scope.userId, groupId: scope.groupId, userMsg: "我的项目" });
  }, recorder);
  const record = recorder.list().items[0];
  const source = record.stages.flatMap(item => item.sources || []).find(item => item.kind === "note");
  assert.equal(source.revision, 2); assert.match(source.noteId, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(record), /Debian|ADMIN_ONLY|项目/);
  const privatePacket = buildReplyContextPacket({ uid: scope.userId, groupId: "private", mode: "private", userMsg: "我的项目" });
  assert.doesNotMatch(JSON.stringify(privatePacket.messages), /Debian|ADMIN_ONLY/);
});

test("an editor correction invalidates a running chat before any later send or model step", async () => {
  let reached = false;
  const result = await withChatRun({ surface: "group", groupId: scope.groupId, userId: scope.userId }, async () => {
    save({ title: "本轮纠正", text: "新资料" });
    assertChatRunCurrent(); reached = true;
  });
  assert.equal(reached, false); assert.equal(result.reason, "privacy_changed");
});

test("forget clears group and explicitly opted-in private notes without retaining their content", () => {
  const privateScope = { ...scope, groupId: "private" };
  applyMemoryNoteAction({ ...privateScope, revision: memoryNotesSnapshot(privateScope).revision, action: "create", title: "PRIVATE_ONLY", text: "私聊明确记忆" }, { origin: "user_command", messageId: 80200 });
  assert.equal(forgetUserData(scope.userId).ok, true);
  assert.equal(memoryNotesSnapshot(scope).items.length, 0);
  assert.equal(memoryNotesSnapshot(privateScope).items.length, 0);
  assert.doesNotMatch(fs.readFileSync(CFG.memoryProfileFile, "utf8"), /PRIVATE_ONLY|Debian|ADMIN_ONLY/);
});

test("saved notes survive a fresh process and corrupt profile files are not overwritten", () => {
  const childRoot = path.join(root, "child"); fs.mkdirSync(childRoot);
  const notesUrl = new URL("../bridge/memory-profile/notes.mjs", import.meta.url).href;
  const storeUrl = new URL("../bridge/memory-profile/store.mjs", import.meta.url).href;
  const env = { ...process.env, QQBOT_DATA_DIR: childRoot, QQBOT_LOG_DIR: path.join(childRoot, "logs") };
  const run = code => spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
  let result = run(`import { memoryNotesSnapshot, applyMemoryNoteAction } from ${JSON.stringify(notesUrl)}; const s={userId:'60101',groupId:'private'}; applyMemoryNoteAction({...s,revision:memoryNotesSnapshot(s).revision,action:'create',title:'持久化',text:'测试资料'},{origin:'user_command',messageId:80400});`);
  assert.equal(result.status, 0, result.stderr);
  result = run(`import assert from 'node:assert/strict'; import { memoryNotesSnapshot } from ${JSON.stringify(notesUrl)}; assert.equal(memoryNotesSnapshot({userId:'60101',groupId:'private'}).items[0].text,'测试资料');`);
  assert.equal(result.status, 0, result.stderr);
  result = run(`import fs from 'node:fs'; import {CFG} from ${JSON.stringify(new URL("../bridge/config.mjs", import.meta.url).href)}; fs.writeFileSync(CFG.memoryProfileFile,'{broken');`);
  assert.equal(result.status, 0, result.stderr);
  result = run(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import { memoryProfilesAvailable, saveMemoryProfiles, flushMemoryProfilesSync, PROFILE_FILE } from ${JSON.stringify(storeUrl)}; assert.equal(memoryProfilesAvailable(),false); assert.equal(saveMemoryProfiles(),false); assert.equal(flushMemoryProfilesSync(),false); assert.equal(fs.readFileSync(PROFILE_FILE,'utf8'),'{broken');`);
  assert.equal(result.status, 0, result.stderr);
});

test("actual group/private entrypoints store only explicit self commands with real source IDs", async t => {
  const uid = 60110; CFG.friendWhitelist.push(uid);
  const sends = [];
  t.mock.method(Math, "random", () => 0.99999);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /\/send_(?:group|private)_msg$/);
    sends.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
  });
  const base = { post_type: "message", message_type: "group", group_id: 50100, user_id: uid, time: Math.floor(Date.now() / 1000), sender: { nickname: "测试者" } };
  await processEvent({ ...base, message_id: 90010, message: [{ type: "text", data: { text: "记住 Demo = PascalCase!" } }] });
  assert.equal(memoryNotesSnapshot({ userId: uid, groupId: 50100 }).items.length, 0);
  await processEvent({ ...base, message_id: 90011, message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: "记住 Demo = PascalCase!" } }] });
  const group = memoryNotesSnapshot({ userId: uid, groupId: 50100 }).items[0];
  assert.equal(group.title, "Demo"); assert.equal(group.text, "PascalCase!"); assert.equal(group.source.messageId, "90011");
  await processEvent({ ...base, message_type: "private", group_id: undefined, message_id: 90012, message: [{ type: "text", data: { text: "记住 私聊主题 = PrivateCase!" } }] });
  const direct = memoryNotesSnapshot({ userId: uid, groupId: "private" }).items[0];
  assert.equal(direct.source.messageId, "90012"); assert.equal(direct.text, "PrivateCase!");
  assert.equal(sends.length, 2);
  assert.equal(users[String(uid)].chats.filter(item => item.group === "private").length, 0);
});

test("pre-forget private command cannot recreate a note after its initial await", async t => {
  const uid = 60112; CFG.friendWhitelist.push(uid);
  t.mock.method(globalThis, "fetch", async () => assert.fail("stale private command must not send"));
  const pending = handlePrivateMessage({ message_type: "private", user_id: uid, message_id: 90112, text: "记住 旧内容 = 不应重建", images: [], files: [] });
  forgetUserData(uid);
  await pending;
  assert.equal(memoryNotesSnapshot({ userId: uid, groupId: "private" }).items.length, 0);
});

test("private permission revoked while the command yields prevents the synchronous write", async () => {
  const uid = 60113; const cfg = { ...CFG, friendWhitelist: [uid], adminUins: [] };
  let writes = 0;
  const pending = buildMemoryCommandReplyAsync("记住 项目 = 禁止旧写入", { userId: uid, surface: "private", messageId: 90113, cfg,
    noteService: { snapshot: memoryNotesSnapshot, act: (...args) => { writes++; return applyMemoryNoteAction(...args); } } });
  cfg.friendWhitelist.length = 0;
  await pending;
  assert.equal(writes, 0);
  assert.equal(memoryNotesSnapshot({ userId: uid, groupId: "private" }).items.length, 0);
});

test("forgetting after first note-list chunk stops remaining group and private chunks", async t => {
  for (const surface of ["private", "group"]) {
    const uid = surface === "private" ? 60114 : 60115; CFG.friendWhitelist.push(uid);
    const localScope = { userId: String(uid), groupId: surface === "private" ? "private" : "50100" };
    for (let i = 0; i < 6; i++) applyMemoryNoteAction({ ...localScope, revision: memoryNotesSnapshot(localScope).revision,
      action: "create", title: "长条目" + i, text: "合成旧资料".repeat(50) });
    let sends = 0;
    t.mock.method(globalThis, "fetch", async url => {
      assert.match(String(url), /\/send_(?:private|group)_msg$/); sends++;
      if (sends === 1) forgetUserData(uid);
      return { ok: true, json: async () => ({ status: "ok", retcode: 0 }) };
    });
    await processEvent({ post_type: "message", message_type: surface, group_id: surface === "group" ? 50100 : undefined,
      user_id: uid, message_id: uid + 30000, time: Math.floor(Date.now() / 1000), sender: { nickname: "测试者" },
      message: [...(surface === "group" ? [{ type: "at", data: { qq: String(CFG.selfUin) } }] : []), { type: "text", data: { text: "我的记忆" } }] });
    assert.equal(sends, 1);
    assert.equal(memoryNotesSnapshot(localScope).items.length, 0);
    t.mock.restoreAll();
  }
});

test("correction follows prior note dependencies even when the question uses only obsolete wording", () => {
  const uid = "60116"; const localScope = { userId: uid, groupId: "50100" };
  const old = applyMemoryNoteAction({ ...localScope, revision: memoryNotesSnapshot(localScope).revision,
    action: "create", title: "Language", text: "Use Ruby" }, { origin: "user_command", messageId: 90116 }).items[0];
  recordConversationTurn({ uid, groupId: "50100", messageId: 81116, userText: "Ruby framework?", assistantText: "OLD_RUBY_ADVICE", now: Date.now() - 1000,
    memorySources: [{ noteId: old.id, revision: 1 }] }, { save: false });
  applyMemoryNoteAction({ ...localScope, revision: memoryNotesSnapshot(localScope).revision, action: "update", id: old.id, text: "Use Rust" }, { origin: "user_command", messageId: 91116 });
  const packet = buildReplyContextPacket({ uid, groupId: "50100", userMsg: "Ruby framework?" });
  assert.match(JSON.stringify(packet.messages), /Use Rust/);
  assert.doesNotMatch(JSON.stringify(packet.messages), /OLD_RUBY_ADVICE/);
});

test("nine corrections, another speaker and passive context cannot restore an old source", () => {
  const uid = "60117"; const localScope = { userId: uid, groupId: "50100" };
  const old = applyMemoryNoteAction({ ...localScope, revision: memoryNotesSnapshot(localScope).revision,
    action: "create", title: "Language", text: "OBSOLETE_RUBY_SOURCE" }, { origin: "user_command", messageId: 90117 }).items[0];
  groupChats[50100] = [{ uid, nickname: "测试甲", text: "OBSOLETE_RUBY_SOURCE", messageId: "90117", ts: Date.now() }];
  for (let i = 0; i < 9; i++) applyMemoryNoteAction({ ...localScope, revision: memoryNotesSnapshot(localScope).revision,
    action: "update", id: old.id, text: "LATEST_RUST_NOTE" }, { origin: "user_command", messageId: 92117 + i });
  for (const mode of ["group-at", "interjection"]) {
    const packet = buildReplyContextPacket({ uid: "60118", groupId: "50100", userMsg: "OBSOLETE_RUBY_SOURCE", mode });
    assert.doesNotMatch(JSON.stringify(packet.messages), /OBSOLETE_RUBY_SOURCE|LATEST_RUST_NOTE/);
  }
  memoryNoteService.prune(Date.now() + 100 * 86400000);
  const packet = buildReplyContextPacket({ uid: "60118", groupId: "50100", userMsg: "OBSOLETE_RUBY_SOURCE" });
  assert.doesNotMatch(JSON.stringify(packet.messages), /OBSOLETE_RUBY_SOURCE/);
});
