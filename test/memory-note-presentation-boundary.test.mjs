import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, mock, test } from "node:test";

const parent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, "qqfriend-note-presentation-"));
const environment = {
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: path.join(root, "config"),
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_TEMP_DIR: path.join(root, "temp"), QQBOT_MEMORY_PROFILE_FILE: path.join(root, "memory.json"),
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const network = mock.method(globalThis, "fetch", () => assert.fail("offline presentation test attempted network"));
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { memoryEvidenceLayers, readMemoryEvidence } = await import("../bridge/memory-profile/evidence.mjs");
const { MEMORY_SEMANTIC_BOUNDARY, noteSemanticText } = await import("../bridge/memory-profile/semantics.mjs");
const { buildChatSystemPrompt } = await import("../bridge/system-prompts/chat.mjs");
const { IMAGE_POLICY_EVIDENCE } = await import("../bridge/system-prompts/image-policy.mjs");
const { cleanupLogger } = await import("../bridge/logger.mjs");

after(() => {
  cleanupLogger();
  assert.equal(network.mock.callCount(), 0);
  network.mock.restore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(path.dirname(fs.realpathSync(root)), parent);
  fs.rmSync(root, { recursive: true, force: true });
});

const scope = { userId: "64180", groupId: "54180" };
const DAY = 86400000;
const now = Date.parse("2026-10-04T00:00:00Z");

function fixture() {
  const clock = { now };
  const service = createMemoryNoteService({ profiles: {}, now: () => clock.now,
    available: () => true, persist: () => true, invalidate() {}, readPrivacy: () => ({ users: {} }) });
  let messageId = 74180;
  const act = (fields, context = {}) => service.act({ ...scope, revision: service.snapshot(scope).revision, ...fields },
    { origin: "user_command", messageId: String(messageId++), ...context });
  const options = query => ({ query, now: clock.now, snapshot: service.snapshot,
    users: {}, groupChats: {}, readPrivacy: () => ({ users: {} }) });
  const render = (query = "记忆里那条还有效吗") => memoryEvidenceLayers(scope.userId, scope.groupId, options(query));
  return { clock, service, act, options, render };
}

function noteLayer(packet, id) {
  const layer = packet.layers.find(item => item.contextSources.some(source => source.noteId === id));
  assert.ok(layer, "selected note is missing from rendered input");
  return layer;
}

function sections(layer) {
  const lines = layer.content.split("\n");
  const body = lines.find(line => line.startsWith("可读的正文摘录（标题：正文）="));
  const status = lines.find(line => line.startsWith("这条候选的期限/状态："));
  const metadata = lines.find(line => line.startsWith("owner_uid="));
  const relation = lines.find(line => line.startsWith("对象关系="));
  assert.ok(body && status && metadata && relation);
  assert.ok(lines.indexOf(body) < lines.indexOf(status));
  assert.match(relation, /本条仅为候选.*另据本轮原话或已核验引用.*不能凭唯一候选或未过期认定/);
  return { body, status, metadata, relation };
}

// Rendered input contracts only, not model answers or semantic acceptance.
test("short shared boundary recognizes supplied body without growing system budgets", () => {
  assert.ok(MEMORY_SEMANTIC_BOUNDARY.length <= 225);
  assert.match(MEMORY_SEMANTIC_BOUNDARY, /可读正文摘录不是元信息/);
  assert.doesNotMatch(MEMORY_SEMANTIC_BOUNDARY, /正文摘录已提供/);
  const baselines = { chat: 3018, interjection: 2999, technical: 2951, summary: 2951, admin: 2951 };
  for (const [replyMode, before] of Object.entries(baselines)) {
    const normal = buildChatSystemPrompt({ imagePolicy: IMAGE_POLICY_EVIDENCE, replyMode });
    const focused = buildChatSystemPrompt({ imagePolicy: IMAGE_POLICY_EVIDENCE, replyMode, imageTask: true });
    assert.equal(normal.split(MEMORY_SEMANTIC_BOUNDARY).length, 2);
    assert.equal(focused.split(MEMORY_SEMANTIC_BOUNDARY).length, 2);
    assert.ok(normal.length <= before + 82);
    assert.ok(focused.length <= 2360);
    assert.ok(focused.length <= normal.length * 0.8);
  }
});

test("corrected body is visibly supplied apart from status and metadata, with revision and API shape unchanged", () => {
  const f = fixture();
  const original = f.act({ action: "create", title: "排期", text: "SUPERSEDED_PRESENTATION_TEXT" }).items[0];
  f.act({ action: "create", title: "另项记录", text: "INDEPENDENT_PRESENTATION_TEXT" });
  f.clock.now++;
  const corrected = f.act({ action: "update", id: original.id, text: "CURRENT_PRESENTATION_TEXT" }).items.find(item => item.id === original.id);
  const before = f.service.snapshot(scope);
  const packet = f.render("我的记忆是什么");
  const { body, status, metadata } = sections(noteLayer(packet, corrected.id));
  assert.match(body, /排期：CURRENT_PRESENTATION_TEXT$/);
  assert.doesNotMatch(body, /owner_uid=|revision=|expires=|记录有效性=/);
  assert.equal(status, "这条候选的期限/状态：" + noteSemanticText(corrected));
  assert.match(metadata, /source=用户明确要求记住 revision=2 /);
  assert.ok(metadata.endsWith("expires=" + new Date(corrected.expiresAt).toISOString()));
  assert.doesNotMatch(JSON.stringify(packet.layers), /SUPERSEDED_PRESENTATION_TEXT/);
  assert.match(JSON.stringify(packet.layers), /INDEPENDENT_PRESENTATION_TEXT/);
  assert.deepEqual(Object.keys(packet).sort(), ["corrections", "layers", "supersededMessageIds"]);
  assert.deepEqual(noteLayer(packet, corrected.id).contextSources, [{ kind: "note", reason: "explicit_note",
    userId: scope.userId, messageId: corrected.source.messageId, at: corrected.updatedAt,
    noteId: corrected.id, revision: 2, score: 1 }]);
  const evidence = readMemoryEvidence(scope.userId, scope.groupId, f.options("我的记忆是什么"));
  assert.deepEqual(Object.keys(evidence).sort(), ["available", "corrections", "inferences", "notes", "supersededMessageIds"]);
  assert.deepEqual(evidence.notes.find(item => item.id === corrected.id), corrected);
  assert.deepEqual(f.service.snapshot(scope), before);
});

test("one visible candidate remains a candidate even when its own validity is known", () => {
  const f = fixture();
  const item = f.act({ action: "create", title: "预约", text: "SINGLE_PRESENTATION_TEXT" }).items[0];
  const packet = f.render();
  assert.match(packet.layers[0].content, /相关候选 1 条/);
  const { body, status, relation } = sections(noteLayer(packet, item.id));
  assert.match(body, /SINGLE_PRESENTATION_TEXT/);
  assert.match(status, /后端核验未过期（仅此条）/);
  assert.doesNotMatch(relation, /已匹配|目标已过期|目标未过期/);
  assert.equal(packet.layers.filter(layer => layer.contextSources.length).length, 1);
});

test("several candidates each keep their own body, lifecycle and unresolved reference boundary", () => {
  const f = fixture();
  const pending = f.act({ action: "create", title: "安排", text: "PENDING_PRESENTATION_TEXT", recordType: "todo" }).items[0];
  const ended = f.act({ action: "create", title: "旧安排", text: "ENDED_PRESENTATION_TEXT",
    recordType: "current_state", status: "ended" }).items.find(item => item.title === "旧安排");
  const packet = f.render("我的记忆里那条现在什么状态");
  assert.match(packet.layers[0].content, /相关候选 2 条/);
  assert.match(sections(noteLayer(packet, pending.id)).status, /事项状态=待办/);
  assert.match(sections(noteLayer(packet, ended.id)).status, /事项状态=已结束；记录有效性=后端核验未过期（仅此条）/);
  assert.doesNotMatch(sections(noteLayer(packet, pending.id)).body, /ENDED_PRESENTATION_TEXT/);
  assert.doesNotMatch(sections(noteLayer(packet, ended.id)).body, /PENDING_PRESENTATION_TEXT/);
});

test("an expired target leaves independent valid evidence, not target body, ID or fabricated expiry conclusion", () => {
  const f = fixture();
  const target = f.act({ action: "create", title: "原安排", text: "EXPIRED_PRESENTATION_TEXT", ttlDays: 1 }).items[0];
  const control = f.act({ action: "create", title: "独立安排", text: "CONTROL_PRESENTATION_TEXT", ttlDays: 2 }).items.find(item => item.title === "独立安排");
  f.clock.now += DAY;
  assert.equal(f.service.snapshot(scope).items.find(item => item.id === target.id).state, "expired");
  const packet = f.render();
  assert.match(packet.layers[0].content, /相关候选 1 条/);
  const { body, status, relation } = sections(noteLayer(packet, control.id));
  assert.match(body, /CONTROL_PRESENTATION_TEXT/);
  assert.match(status, /后端核验未过期（仅此条）/);
  assert.doesNotMatch(relation, /已匹配|目标已过期|目标未过期/);
  assert.doesNotMatch(JSON.stringify(packet.layers), /EXPIRED_PRESENTATION_TEXT|原安排/);
  assert.ok(!JSON.stringify(packet.layers).includes(target.id));
  f.clock.now += DAY;
  const empty = f.render();
  assert.match(empty.layers[0].content, /相关候选 0 条/);
  assert.doesNotMatch(JSON.stringify(empty.layers), /EXPIRED_PRESENTATION_TEXT|CONTROL_PRESENTATION_TEXT/);
});

test("erased content stays absent without turning another candidate into a deletion receipt", () => {
  const f = fixture();
  const erased = f.act({ action: "create", title: "待清项", text: "ERASED_PRESENTATION_TEXT" }).items[0];
  const control = f.act({ action: "create", title: "保留项", text: "RETAINED_PRESENTATION_TEXT" }).items.find(item => item.title === "保留项");
  f.act({ action: "remove", id: erased.id });
  const packet = f.render();
  sections(noteLayer(packet, control.id));
  assert.doesNotMatch(JSON.stringify(packet.layers), /ERASED_PRESENTATION_TEXT|待清项|已删除|永久删除/);
  assert.ok(!JSON.stringify(packet.layers).includes(erased.id));
  f.act({ action: "remove", id: control.id });
  const empty = f.render();
  assert.match(empty.layers[0].content, /相关候选 0 条.*只表示此范围未提供相关资料/);
  assert.ok(empty.layers.every(layer => layer.contextSources.length === 0));
  assert.doesNotMatch(JSON.stringify(empty.layers), /ERASED_PRESENTATION_TEXT|RETAINED_PRESENTATION_TEXT|已删除/);
});

test("operator provenance and scope isolation remain independent of readable body", () => {
  const f = fixture();
  const item = f.act({ action: "create", title: "备注", text: "OPERATOR_PRESENTATION_TEXT" }, { origin: "operator" }).items[0];
  const packet = f.render("我的记忆");
  const layer = noteLayer(packet, item.id);
  assert.match(sections(layer).metadata, /source=管理员备注，不代表用户亲口说过/);
  assert.equal(layer.contextSources[0].reason, "operator_note");
  assert.equal(layer.contextSources[0].messageId, "");
  assert.equal(layer.contextPriority, 84);
  assert.equal(layer.contextAtomic, true);
  for (const foreign of [{ ...scope, userId: "64181" }, { ...scope, groupId: "54181" }, { ...scope, groupId: "private" }]) {
    const foreignPacket = memoryEvidenceLayers(foreign.userId, foreign.groupId, f.options("我的记忆"));
    assert.doesNotMatch(JSON.stringify(foreignPacket.layers), /OPERATOR_PRESENTATION_TEXT/);
  }
});

test("unavailable data cannot provide body or claim the target is absent or expired", () => {
  const f = fixture();
  const packet = memoryEvidenceLayers(scope.userId, scope.groupId, { ...f.options("我的记忆"),
    snapshot: () => { throw new Error("unavailable"); } });
  assert.equal(packet.layers.length, 1);
  assert.match(packet.layers[0].content, /记忆库暂不可用/);
  assert.doesNotMatch(packet.layers[0].content, /相关候选 0 条|可读的正文摘录|目标已过期|已删除/);
  assert.equal(packet.corrections, null);
});
