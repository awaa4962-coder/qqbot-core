import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-memory-reference-"));
const environment = {
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: path.join(root, "config"),
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_TEMP_DIR: path.join(root, "temp"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "memory.json"),
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { memoryEvidenceLayers } = await import("../bridge/memory-profile/evidence.mjs");
const { MEMORY_SEMANTIC_BOUNDARY } = await import("../bridge/memory-profile/semantics.mjs");
const { buildChatSystemPrompt } = await import("../bridge/system-prompts/chat.mjs");
const { IMAGE_POLICY_EVIDENCE } = await import("../bridge/system-prompts/image-policy.mjs");
const { buildMemoryCommandReplyAsync } = await import("../bridge/commands/modules/memory.mjs");

before(context => context.mock.method(globalThis, "fetch", async () => assert.fail("offline test attempted network")));
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

const scope = { userId: "60155", groupId: "50155" };
const DAY = 86400000;
const now = Date.parse("2026-10-04T00:00:00Z");
function fixture() {
  const clock = { now };
  const service = createMemoryNoteService({ profiles: {}, now: () => clock.now,
    available: () => true, persist: () => true, invalidate() {}, readPrivacy: () => ({ users: {} }) });
  const act = fields => service.act({ ...scope, revision: service.snapshot(scope).revision, ...fields },
    { origin: "user_command", messageId: "70155" });
  const layers = () => memoryEvidenceLayers(scope.userId, scope.groupId, {
    query: "记忆里那条还有效吗", now: clock.now, snapshot: service.snapshot,
    users: {}, groupChats: {}, readPrivacy: () => ({ users: {} }),
  }).layers;
  return { clock, service, act, layers };
}

// These are rendered input contracts, not a second answer scorer or real-model acceptance.
test("built system distinguishes candidates, reference targets and scoped execution evidence within budget", () => {
  const system = buildChatSystemPrompt({ imagePolicy: IMAGE_POLICY_EVIDENCE, imageTask: true });
  assert.match(system, /当前候选非全范围，也不自动对应‘那条’/);
  assert.match(system, /未过期仅属该条，不能用剩余条目替代缺失目标/);
  assert.match(system, /未提供不等于已删除；无查询\/删除执行回执不称查过\/已删/);
  assert.match(system, /有明确回执仅按其对象、范围确认/);
  assert.match(system, /未知不当已证/);
  assert.equal(system.split(MEMORY_SEMANTIC_BOUNDARY).length, 2);
  assert.ok(MEMORY_SEMANTIC_BOUNDARY.length - 209 <= 40, "memory boundary exceeds its 40-character increment");
});

test("expired target leaves only an independently labelled control, without target body or ID", () => {
  const f = fixture();
  const target = f.act({ action: "create", title: "target", text: "EXPIRED_REFERENCE_BODY", ttlDays: 1 }).items[0];
  const control = f.act({ action: "create", title: "control", text: "INDEPENDENT_REFERENCE_BODY", ttlDays: 2,
    recordType: "current_state", status: "ended" }).items.find(item => item.title === "control");
  f.clock.now += DAY;
  const layers = f.layers();
  assert.match(layers[0].content, /相关候选 1 条/);
  const note = layers.find(layer => layer.contextSources.some(source => source.noteId === control.id));
  assert.match(note.content, /事项状态=已结束；记录有效性=后端核验未过期（仅此条）/);
  assert.match(note.content, /control：INDEPENDENT_REFERENCE_BODY/);
  assert.ok(!JSON.stringify(layers).includes(target.id));
  assert.doesNotMatch(JSON.stringify(layers), /EXPIRED_REFERENCE_BODY/);
});

test("zero candidates render scoped absence, not a deletion receipt or resurrected target", () => {
  const f = fixture();
  const target = f.act({ action: "create", title: "target", text: "ERASED_REFERENCE_BODY" }).items[0];
  f.act({ action: "remove", id: target.id });
  const layers = f.layers();
  assert.match(layers[0].content, /相关候选 0 条/);
  assert.match(layers[0].content, /只表示此范围未提供相关资料/);
  assert.doesNotMatch(JSON.stringify(layers), /ERASED_REFERENCE_BODY|记忆已删除/);
  assert.ok(!JSON.stringify(layers).includes(target.id));
  assert.ok(layers.every(layer => layer.contextSources.length === 0));
});

test("explicit successful delete retains its command receipt while failure cannot claim deletion", async () => {
  const f = fixture();
  const target = f.act({ action: "create", title: "target", text: "COMMAND_REFERENCE_BODY" }).items[0];
  const options = { ...scope, surface: "group", messageId: "70156", noteService: f.service,
    cfg: { selfUin: 999, groupWhitelist: [50155], friendWhitelist: [], botBlacklist: [] } };
  const receipt = await buildMemoryCommandReplyAsync("删除记忆 " + target.id, options);
  assert.match(receipt, /^记忆已删除。/);
  assert.doesNotMatch(receipt, /COMMAND_REFERENCE_BODY/);
  const failed = await buildMemoryCommandReplyAsync("删除记忆 " + target.id, options);
  assert.doesNotMatch(failed, /记忆已删除/);
  assert.match(failed, /不存在或不属于当前范围/);
});
