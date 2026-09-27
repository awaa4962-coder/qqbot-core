import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadUrl = pathToFileURL(path.join(project, "bridge", "cognition", "thread-manager.mjs")).href;
const storageUrl = pathToFileURL(path.join(project, "bridge", "storage.mjs")).href;
const preferencesUrl = pathToFileURL(path.join(project, "bridge", "user-preferences.mjs")).href;
const contextUrl = pathToFileURL(path.join(project, "bridge", "context", "assemble.mjs")).href;

test("group topic branches survive a fresh process and full forget removes them durably", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-topic-restart-"));
  try {
    for (const name of ["config", "data", "logs", "tmp"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "config", ".env_mimo"), "test-only-mimo-key\n");
    fs.writeFileSync(path.join(root, "config", ".env_ds"), "test-only-deepseek-key\n");
    const env = { ...process.env, NODE_ENV: "test", QQBOT_CONFIG_ROOT: path.join(root, "config"),
      QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
      QQBOT_TEMP_DIR: path.join(root, "tmp"), THREAD_URL: threadUrl, STORAGE_URL: storageUrl,
      PREFERENCES_URL: preferencesUrl, CONTEXT_URL: contextUrl };

    const writer = runChild(`
      const { recordConversationTurn } = await import(process.env.THREAD_URL);
      const { flushSavesSync, users } = await import(process.env.STORAGE_URL);
      const base = { uid: "60341", groupId: "50341", memorySources: [], memoryExpiresAt: null };
      recordConversationTurn({ ...base, threadId: null, messageId: "70341", assistantMessageIds: ["80341"],
        userText: "JM 压缩包解压失败", assistantText: "检查 FS 密码。" }, { userStore: users });
      recordConversationTurn({ ...base, threadId: null, messageId: "70342", assistantMessageIds: ["80342"],
        userText: "日报没生成", assistantText: "检查定时任务。" }, { userStore: users });
      if (!flushSavesSync({ durable: true })) throw new Error("users flush failed");
      console.log("RESULT:" + JSON.stringify({ branches: users["60341"].cognition.threads["50341"].branches.length }));
    `, env);
    assert.equal(writer.branches, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "data", "user_memory.json"), "utf8"));
    assert.equal(stored["60341"].cognition.threads["50341"].branches[0].turns[0].messageId, "70341");

    const reader = runChild(`
      const { getConversationThread } = await import(process.env.THREAD_URL);
      const { users } = await import(process.env.STORAGE_URL);
      const selected = getConversationThread("60341", "50341", { forMessage: {
        uid: "60341", userMsg: "这个还是不行", replyToMessageId: "80341", replyUserId: "1000000001", selfUin: "1000000001" } });
      console.log("RESULT:" + JSON.stringify({ id: selected?.id, messages: selected?.turns.map(turn => turn.messageId),
        active: users["60341"]?.cognition?.threads?.["50341"]?.turns.map(turn => turn.messageId) }));
    `, env);
    assert.deepEqual(reader.messages, ["70341"]);
    assert.deepEqual(reader.active, ["70342"]);

    const memoryFile = path.join(root, "data", "user_memory.json");
    const cleanBytes = fs.readFileSync(memoryFile);
    const corrupt = JSON.parse(cleanBytes.toString("utf8"));
    corrupt["60341"].cognition.threads["50341"].branches[0].scope = "private";
    corrupt["60341"].cognition.threads["50341"].branches[0].turns[0].assistantSummary = "PRIVATE_BRANCH_MARKER";
    fs.writeFileSync(memoryFile, JSON.stringify(corrupt));
    const corruptedBytes = fs.readFileSync(memoryFile);
    const rejected = runChild(`
      const { getConversationThread, getCognitionStatus } = await import(process.env.THREAD_URL);
      const { buildReplyContextPacket } = await import(process.env.CONTEXT_URL);
      const thread = getConversationThread("60341", "50341", { forMessage: {
        uid: "60341", userMsg: "JM 压缩包继续", replyToMessageId: "80341", replyUserId: "1000000001", selfUin: "1000000001" } });
      const packet = buildReplyContextPacket({ uid: "60341", groupId: "50341", userName: "合成用户",
        userMsg: "JM 压缩包继续", currentMessageId: "70343" });
      console.log("RESULT:" + JSON.stringify({ thread, leaked: JSON.stringify(packet.messages).includes("PRIVATE_BRANCH_MARKER"),
        invalidThreads: getCognitionStatus().invalidThreads }));
    `, env);
    assert.equal(rejected.thread, null);
    assert.equal(rejected.leaked, false);
    assert.equal(rejected.invalidThreads, 1);
    assert.deepEqual(fs.readFileSync(memoryFile), corruptedBytes);

    const forgotten = runChild(`
      const { forgetUserData } = await import(process.env.PREFERENCES_URL);
      const { users } = await import(process.env.STORAGE_URL);
      const result = forgetUserData("60341");
      console.log("RESULT:" + JSON.stringify({ ok: result.ok, cognition: users["60341"]?.cognition ?? null }));
    `, env);
    assert.equal(forgotten.ok, true);
    assert.equal(forgotten.cognition, null);
    const after = runChild(`
      const { getConversationThread } = await import(process.env.THREAD_URL);
      const { users } = await import(process.env.STORAGE_URL);
      console.log("RESULT:" + JSON.stringify({ thread: getConversationThread("60341", "50341"),
        cognition: users["60341"]?.cognition ?? null }));
    `, env);
    assert.equal(after.thread, null);
    assert.equal(after.cognition, null);
  } finally {
    const resolved = fs.realpathSync(root);
    const allowed = fs.realpathSync(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(allowed), "test cleanup must stay inside the temporary root");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function runChild(code, env) {
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: project, env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message || run.stdout);
  const line = run.stdout.split(/\r?\n/).findLast(item => item.startsWith("RESULT:"));
  assert.ok(line, "child process did not report a result");
  return JSON.parse(line.slice("RESULT:".length));
}
