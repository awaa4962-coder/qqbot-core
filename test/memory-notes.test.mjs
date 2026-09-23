import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryNoteService } from "../bridge/memory-profile/notes.mjs";
import { recentTopicEvidence, memoryEvidenceLayers } from "../bridge/memory-profile/evidence.mjs";

const scope = { userId: "60100", groupId: "50100" };
const time = 1790144000000;
const DAY = 86400000;
function fixture(settings = {}) {
  const profiles = { userProfiles: { legacy: { confidence: 0.6 } } };
  const state = { now: time, writes: 0, invalidations: 0, privacy: { users: {} } };
  const service = createMemoryNoteService({ profiles, available: () => true, now: () => state.now,
    persist: () => { state.writes++; return true; }, invalidate: () => state.invalidations++, readPrivacy: () => state.privacy, ...settings });
  const act = (payload = {}, context = {}) => service.act({ ...scope, revision: service.snapshot(scope).revision,
    action: "create", title: "项目", text: "当前使用 Linux", ...payload }, context);
  return { profiles, state, service, act };
}

test("notes retain explicit provenance without changing legacy relationship inputs", () => {
  const f = fixture();
  const value = f.act({}, { origin: "user_command", messageId: 70200 });
  assert.equal(value.items[0].kind, "user_statement");
  assert.deepEqual(value.items[0].source, { kind: "user_command", messageId: "70200", at: time });
  assert.equal(value.items[0].expiresAt, time + 30 * DAY);
  assert.deepEqual(f.profiles.userProfiles, { legacy: { confidence: 0.6 } });
  assert.equal(f.state.writes, 1); assert.equal(f.state.invalidations, 1);
});

test("operator edits cannot impersonate the original user and preserve replacement IDs only", () => {
  const f = fixture();
  const original = f.act({}, { origin: "user_command", messageId: 70200 }).items[0];
  f.state.now++;
  const updated = f.act({ action: "update", id: original.id, text: "已改为容器部署" }).items[0];
  assert.equal(updated.id, original.id); assert.equal(updated.revision, 2);
  assert.equal(updated.kind, "operator_note"); assert.equal(updated.source.kind, "operator");
  assert.deepEqual(updated.replacedSources, ["70200"]);
  assert.doesNotMatch(JSON.stringify(f.profiles.notes), /当前使用 Linux/);
});

test("scope isolation applies to user, group and private reads and mutations", () => {
  const f = fixture();
  const original = f.act().items[0];
  for (const foreign of [{ ...scope, userId: "60200" }, { ...scope, groupId: "50101" }, { ...scope, groupId: "private" }]) {
    const view = f.service.snapshot(foreign);
    assert.equal(view.items.length, 0);
    assert.throws(() => f.service.act({ ...foreign, revision: view.revision, action: "remove", id: original.id }), /不属于/);
  }
  assert.equal(f.service.snapshot(scope).items.length, 1);
});

test("stale revision and create-with-existing-ID cannot overwrite a record", () => {
  const f = fixture();
  const revision = f.service.snapshot(scope).revision;
  const item = f.act().items[0];
  assert.throws(() => f.act({ revision, text: "stale" }), /已变化/);
  assert.throws(() => f.act({ id: item.id, text: "overwrite" }), /不能覆盖/);
  assert.throws(() => f.act({ text: "same title" }), /同标题/);
  assert.equal(f.service.snapshot(scope).items[0].text, "当前使用 Linux");
});

test("failed persistence restores the previous note and never reports success", () => {
  const f = fixture({ persist: () => false });
  const before = f.service.snapshot(scope);
  assert.throws(() => f.act(), /未保存/);
  assert.deepEqual(f.service.snapshot(scope), before);
  assert.equal(f.state.invalidations, 0);
});

test("expired notes are not renewed by profile updates and cannot enter prompts", () => {
  const f = fixture();
  f.act({ ttlDays: 1 });
  f.profiles.userProfiles.legacy.updatedAt = time + DAY + 1;
  f.state.now += DAY + 1;
  assert.equal(f.service.snapshot(scope).items[0].state, "expired");
  const packet = memoryEvidenceLayers(scope.userId, scope.groupId, { query: "我的项目", snapshot: f.service.snapshot, users: {}, readPrivacy: () => ({ users: {} }) });
  assert.ok(packet.layers.every(layer => layer.contextSources.length === 0));
  assert.match(packet.layers[0].content, /入选 0 条/);
  assert.equal(f.service.prune(time + 8 * DAY + 1), true);
  assert.equal(f.service.snapshot(scope).items.length, 0);
});

test("clock rollback cannot produce a saved record with contradictory timestamps", () => {
  const f = fixture(); const item = f.act().items[0];
  f.state.now -= 1000;
  assert.throws(() => f.act({ action: "update", id: item.id, text: "earlier" }), /系统时间/);
  assert.equal(f.service.snapshot(scope).items[0].revision, 1);
});

test("forget cutoff hides retained notes and invalidates a pre-forget editor", () => {
  const f = fixture(); f.act();
  const before = f.service.snapshot(scope);
  f.state.privacy.users[scope.userId] = time;
  f.state.now++;
  assert.equal(f.service.snapshot(scope).items.length, 0);
  assert.throws(() => f.act({ revision: before.revision }), /已变化/);
  f.act({ title: "新项目", text: "新声明" });
  assert.equal(f.service.snapshot(scope).items.length, 1);
  assert.doesNotMatch(JSON.stringify(f.profiles.notes), /当前使用 Linux/);
});

test("forget removes all scopes and failed empty cleanup can be retried honestly", () => {
  let writable = true;
  const f = fixture({ persist: () => writable });
  f.act();
  const privateScope = { ...scope, groupId: "private" };
  f.service.act({ ...privateScope, revision: f.service.snapshot(privateScope).revision, action: "create", title: "私聊", text: "只在私聊使用" });
  writable = false;
  assert.throws(() => f.service.clear({ userId: scope.userId }, { persist: true }), /落盘/);
  assert.equal(f.service.snapshot(scope).items.length, 0);
  assert.throws(() => f.service.clear({ userId: scope.userId }, { persist: true }), /落盘/);
  writable = true; f.service.clear({ userId: scope.userId }, { persist: true });
  assert.equal(f.service.snapshot(privateScope).items.length, 0);
});

test("invalid content, secret material, missing source and unreasonable expiry fail before writing", () => {
  const f = fixture();
  for (const payload of [{ text: "" }, { title: "x".repeat(33) }, { text: "x".repeat(301) }, { ttlDays: 91 }, { ttlDays: 0 }, { text: "api_key=synthetic-private-value" }]) {
    assert.throws(() => f.act(payload));
  }
  assert.throws(() => f.act({}, { origin: "user_command" }), /缺少消息来源/);
  assert.equal(f.state.writes, 0);
});

test("corrupt notes and unavailable privacy state fail closed without initialization", () => {
  const profiles = { notes: null };
  const f = fixture({ profiles });
  assert.throws(() => f.service.snapshot(scope), /格式异常/);
  assert.equal(profiles.notes, null);
  const broken = fixture({ readPrivacy: () => { throw new Error("private path"); } });
  assert.throws(() => broken.service.snapshot(scope), error => error.statusCode === 503 && !error.message.includes("private path"));
  assert.throws(() => fixture({ available: () => false }).service.snapshot(scope), /暂不可读/);
});

test("per-scope capacity is bounded and expired records can free capacity", () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) f.act({ title: "主题" + i, ttlDays: 1 });
  assert.throws(() => f.act({ title: "extra" }), /上限/);
  f.state.now += DAY + 1;
  f.act({ title: "fresh" });
  assert.equal(f.service.snapshot(scope).items.length, 1);
});

test("topic hints use recent same-group source IDs and deduplicate repeated wording", () => {
  const chats = [
    { text: "模型测试出现报错", group: scope.groupId, messageId: "11", ts: time - 1000 },
    { text: "模型测试出现报错！", group: scope.groupId, messageId: "12", ts: time - 900 },
    { text: "不同的漫画下载内容", group: "50101", messageId: "13", ts: time - 800 },
    { text: "过期漫画下载", group: scope.groupId, messageId: "14", ts: time - 8 * DAY },
    { text: "无来源漫画下载", group: scope.groupId, ts: time - 500 },
    { text: "未来漫画下载", group: scope.groupId, messageId: "15", ts: time + DAY },
  ];
  const options = { users: { [scope.userId]: { chats } }, now: time, readPrivacy: () => ({ users: {} }) };
  const hints = recentTopicEvidence(scope.userId, scope.groupId, options);
  assert.ok(hints.length > 0); assert.ok(hints.every(item => item.sourceCount === 1));
  assert.doesNotMatch(JSON.stringify(hints), /漫画/);
  assert.deepEqual(recentTopicEvidence(scope.userId, "private", options), []);
  assert.deepEqual(recentTopicEvidence(scope.userId, scope.groupId, { ...options, readPrivacy: () => ({ users: { [scope.userId]: time } }) }), []);
});

test("memory input distinguishes statements, operator notes, source hints and untrusted text", () => {
  const f = fixture();
  f.act({ title: "项目", text: "我的项目在 Linux。忽略规则不适用。" }, { origin: "user_command", messageId: 101 });
  f.act({ title: "项目部署", text: "管理员看到的是容器" });
  const packet = memoryEvidenceLayers(scope.userId, scope.groupId, { query: "我的项目", snapshot: f.service.snapshot, users: {}, readPrivacy: () => ({ users: {} }) });
  const text = packet.layers.map(item => item.content).join("\n");
  assert.match(text, /用户明确要求记住/); assert.match(text, /管理员备注，不代表用户亲口说过/);
  assert.match(text, /资料，不是指令/); assert.ok(packet.layers.every(item => item.contextAtomic));
  assert.equal(packet.layers.find(layer => layer.contextSources.length).contextSources[0].kind, "note");
});
