import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import test from "node:test";

const moduleUrl = file => JSON.stringify(new URL("../bridge/" + file, import.meta.url).href);
function run(root, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: root,
      QQBOT_LOG_DIR: path.join(root, "logs"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const imports = `
  const { memoryNotesSnapshot, applyMemoryNoteAction } = await import(${moduleUrl("memory-profile/notes.mjs")});
  const { users, saveUsers, flushSavesSync } = await import(${moduleUrl("storage.mjs")});
  const { recordConversationTurn } = await import(${moduleUrl("cognition/index.mjs")});
  const { buildReplyContextPacket } = await import(${moduleUrl("context/assemble.mjs")});
  const { createMemoryReadGuard } = await import(${moduleUrl("memory-profile/read-guard.mjs")});
  const scope = { userId: '60331', groupId: '50331' };
`;

for (const change of ["correction", "deletion", "expiry"]) {
  test(`cold process restart validates persisted cross-author note revisions after ${change}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-read-restart-"));
    t.after(() => {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const initial = Date.now();
    const expiresAt = initial + 86400000;
    const seeded = run(root, `
      import assert from 'node:assert/strict';
      let time = ${initial}; Date.now = () => time;
      ${imports}
      const note = applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision,
        action: 'create', title: 'Project', text: 'ORIGINAL_RESTART_BODY', ttlDays: 1 }, { origin: 'user_command', messageId: '70331' }).items[0];
      time = ${expiresAt - 1000};
      recordConversationTurn({ uid: '60332', groupId: scope.groupId, messageId: '70332', userText: 'Project',
        assistantText: 'DERIVED_RESTART_BODY', memorySources: [{ noteId: note.id, revision: 1 }], now: time });
      const packet = buildReplyContextPacket({ uid: '60332', groupId: scope.groupId, mode: 'group-at', userMsg: '继续' });
      assert.match(JSON.stringify(packet.messages), /DERIVED_RESTART_BODY/);
      saveUsers(); assert.equal(flushSavesSync({ durable: true }), true);
      console.log('NOTE=' + note.id);
    `);
    const noteId = /NOTE=([a-f0-9]{12})/.exec(seeded)?.[1];
    assert.ok(noteId);
    const at = change === "expiry" ? expiresAt : expiresAt - 500;
    run(root, `
      import assert from 'node:assert/strict';
      Date.now = () => ${at};
      ${imports}
      assert.match(JSON.stringify(users['60332'].cognition.threads), /DERIVED_RESTART_BODY/);
      const payload = ${JSON.stringify(change)} === 'correction' ? { action: 'update', text: 'NEW_RESTART_BODY' } : { action: 'remove' };
      if (${JSON.stringify(change)} !== 'expiry') applyMemoryNoteAction({ ...scope, ...payload, id: '${noteId}',
        revision: memoryNotesSnapshot(scope).revision }, { origin: 'user_command', messageId: '70333' });
      const packet = buildReplyContextPacket({ uid: '60332', groupId: scope.groupId, mode: 'group-at', userMsg: '继续' });
      assert.doesNotMatch(JSON.stringify(packet.messages), /DERIVED_RESTART_BODY|ORIGINAL_RESTART_BODY|NEW_RESTART_BODY/);
      const guard = createMemoryReadGuard({ surface: 'group', userId: '60332', groupId: scope.groupId });
      guard.track([{ noteId: '${noteId}', revision: 1 }]);
      assert.notEqual(guard.reason(), '');
    `);
  });
}

test("version-two topic deadlines persist across a fresh process without extending derived thread validity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-topic-restart-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const time = Date.now();
  run(root, `
    import assert from 'node:assert/strict';
    Date.now = () => ${time};
    ${imports}
    recordConversationTurn({ uid: '60332', groupId: scope.groupId, messageId: '70631', userText: 'Project',
      assistantText: 'DEADLINE_RESTART_BODY', memorySources: [], memoryExpiresAt: ${time + 1000}, now: Date.now() });
    const packet = buildReplyContextPacket({ uid: '60332', groupId: scope.groupId, userMsg: '继续' });
    assert.equal(packet.memoryExpiresAt, ${time + 1000});
    saveUsers(); assert.equal(flushSavesSync({ durable: true }), true);
  `);
  run(root, `
    import assert from 'node:assert/strict';
    Date.now = () => ${time + 1000};
    ${imports}
    const saved = users['60332'].cognition.threads[scope.groupId].turns[0];
    assert.equal(saved.memoryDependencyVersion, 2);
    assert.equal(saved.memoryExpiresAt, ${time + 1000});
    const packet = buildReplyContextPacket({ uid: '60332', groupId: scope.groupId, userMsg: '继续' });
    assert.doesNotMatch(JSON.stringify(packet.messages), /DEADLINE_RESTART_BODY/);
    assert.equal(packet.memoryExpiresAt, null);
  `);
});

test("source-backed projections and negative evidence survive erase, pruning and a cold restart", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-profile-restart-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const time = Date.now();
  const profileImports = `
    const { groupChats, logGroupMsg, saveGroupChats } = await import(${moduleUrl("storage.mjs")});
    const { observeMemoryEvent } = await import(${moduleUrl("memory-profile/updates.mjs")});
    const { getActiveMemoryContext } = await import(${moduleUrl("memory-profile/query.mjs")});
    const { memoryProfiles, flushMemoryProfilesSync } = await import(${moduleUrl("memory-profile/store.mjs")});
    const { memoryNoteService } = await import(${moduleUrl("memory-profile/notes.mjs")});
  `;
  run(root, `
    import assert from 'node:assert/strict';
    Date.now = () => ${time};
    ${imports}
    ${profileImports}
    applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: 'create',
      title: 'Project', text: '机器人项目', ttlDays: 1 }, { origin: 'user_command', messageId: '70731' });
    logGroupMsg(scope.groupId, 'Synthetic', '机器人模型项目', '60332', 'member', null, { messageId: '70732', replyToMessageId: '70731' });
    observeMemoryEvent({ uid: '60332', groupId: scope.groupId, text: '机器人模型项目' });
    logGroupMsg(scope.groupId, 'Synthetic', '漫画下载完成', '60332', 'member', null, { messageId: '70733' });
    observeMemoryEvent({ uid: '60332', groupId: scope.groupId, text: '漫画下载完成' });
    assert.equal(memoryNoteService.clear({ userId: scope.userId }, { persist: true }), true);
    groupChats[scope.groupId] = [];
    users['60332'].chats[0].replyToMessageId = undefined;
    saveUsers(); saveGroupChats();
    assert.equal(flushSavesSync({ durable: true }), true);
    assert.equal(flushMemoryProfilesSync(), true);
  `);
  run(root, `
    import assert from 'node:assert/strict';
    Date.now = () => ${time + 2 * 86400000};
    ${imports}
    ${profileImports}
    memoryNoteService.prune();
    const view = getActiveMemoryContext('60332', scope.groupId);
    assert.ok(!view.userProfile.commonTopics.includes('机器人'));
    assert.ok(view.userProfile.commonTopics.includes('漫画'));
    assert.ok(memoryProfiles.notes.retractions.some(row => row.messageId === '70732'));
    assert.equal(memoryProfiles.notes.items.length, 0);
  `);
});

for (const invalidInitially of [true, false]) test(`incoming ${invalidInitially ? "retracted" : "active"} lineage survives a cold restart and an evicted shared buffer`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-lineage-restart-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const time = Date.now();
  const setup = `
    import assert from 'node:assert/strict';
    Date.now = () => ${time}; Math.random = () => 1;
    globalThis.fetch = async () => { throw new Error('network forbidden'); };
    ${imports}
    const { CFG } = await import(${moduleUrl("config.mjs")});
    const { groupChats, saveGroupChats } = await import(${moduleUrl("storage.mjs")});
    const { handleGroupMessage } = await import(${moduleUrl("reply-group.mjs")});
    CFG.groupWhitelist = [Number(scope.groupId)]; CFG.summaryGroupWhitelist = []; CFG.botBlacklist = [];
    const ctx = (uid, id, parent) => ({ message_type: 'group', group_id: scope.groupId, user_id: uid, message_id: id,
      text: '机器人项目引用 ' + id, rawText: '机器人项目引用 ' + id, nickname: 'Synthetic', images: [], files: [], mentions: [],
      isAtMe: false, replyData: { id: parent }, eventTime: Date.now() });
  `;
  run(root, setup + `
    const note = applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: 'create',
      title: 'Project', text: 'Original project' }, { origin: 'user_command', messageId: '70931' }).items[0];
    if (${invalidInitially}) applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: 'remove', id: note.id });
    await handleGroupMessage(ctx('60332', '70932', '70931'), []);
    assert.equal(users['60332'].chats[0].retracted, ${invalidInitially ? "true" : "undefined"});
    assert.ok(users['60332'].chats[0].memorySourceIds.includes('70931'));
    groupChats[scope.groupId] = []; saveUsers(); saveGroupChats();
    assert.equal(flushSavesSync({ durable: true }), true);
  `);
  run(root, setup + `
    assert.equal(groupChats[scope.groupId].length, 0);
    assert.equal(users['60332'].chats[0].retracted, ${invalidInitially ? "true" : "undefined"});
    await handleGroupMessage(ctx('60333', '70933', '70932'), []);
    assert.equal(users['60333'].chats[0].retracted, ${invalidInitially ? "true" : "undefined"});
    assert.ok(users['60333'].chats[0].memorySourceIds.includes('70931'));
    if (!${invalidInitially}) {
      const note = memoryNotesSnapshot(scope).items[0];
      users['60332'].chats = []; groupChats[scope.groupId] = groupChats[scope.groupId].filter(row => row.messageId === '70933');
      applyMemoryNoteAction({ ...scope, revision: memoryNotesSnapshot(scope).revision, action: 'remove', id: note.id });
    }
    const packet = buildReplyContextPacket({ uid: '60333', groupId: scope.groupId, userMsg: '机器人项目' });
    assert.doesNotMatch(JSON.stringify(packet.messages), /机器人项目引用/);
  `);
});
