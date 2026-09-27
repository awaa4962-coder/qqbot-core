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
