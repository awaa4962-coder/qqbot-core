import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReplayService, buildReplayPacket, runReplayChecks } from "../bridge/diagnostics/replay.mjs";
import { REPLAY_CASES } from "../bridge/diagnostics/replay-cases.mjs";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "replay.json");
  return { filename, service: createReplayService({ filename, ...options }) };
}

function reply(text = "答案是 42。") {
  return { ok: true, provider: "test-model", durationMs: 12, raw: { choices: [{ message: { content: text, reasoning_content: "private model reasoning" } }] } };
}

test("replay preflight is deterministic and uses bounded synthetic input", () => {
  assert.equal(runReplayChecks().ok, true);
  for (const example of REPLAY_CASES) {
    const first = buildReplayPacket(example);
    assert.deepEqual(buildReplayPacket(example), first);
    assert.ok(first.budget.chars <= first.budget.maxChars);
    assert.equal(first.messages[0].role, "system");
  }
  const image = buildReplayPacket(REPLAY_CASES.find(item => item.id === "vision-missing"));
  assert.match(JSON.stringify(image), /视觉识别失败/);
});

test("reading and checking replay never call models or write a file", async t => {
  let calls = 0;
  const { service, filename } = harness(t, { callModel: async () => { calls++; return reply(); } });
  assert.equal(service.snapshot().cases.length, REPLAY_CASES.length);
  await service.act({ action: "check" });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(filename), false);
});

test("generation uses only the selected synthetic case and retains final text only", async t => {
  const { service, filename } = harness(t, { callModel: async (task, position, request, options) => {
    assert.equal(task, "group_chat"); assert.equal(position, "primary");
    assert.equal(options.reasoningMode, "economy"); assert.deepEqual(request.tools, []);
    assert.match(request.messages.at(-1).content, /17 加 25/);
    assert.doesNotMatch(JSON.stringify(request), /injected real conversation/);
    return reply();
  } });
  const result = await service.act({ action: "generate", caseId: "topic-switch", text: "injected real conversation" });
  assert.equal(result.cases.find(item => item.id === "topic-switch").candidate.text, "答案是 42。");
  assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /private model reasoning/);
});

test("replay preserves baseline across generation and saves review across restarts", async t => {
  let count = 0;
  const { service, filename } = harness(t, { callModel: async () => reply(++count === 1 ? "第一版。" : "第二版。") });
  const caseId = "continuation";
  await service.act({ action: "generate", caseId });
  await service.act({ action: "baseline", caseId });
  await service.act({ action: "generate", caseId });
  await service.act({ action: "review", caseId, review: "better" });
  const item = createReplayService({ filename }).snapshot().cases.find(example => example.id === caseId);
  assert.equal(item.baseline.text, "第一版。");
  assert.equal(item.candidate.text, "第二版。");
  assert.equal(item.review, "better");
});

test("empty reasoning-only primary reply uses fallback and never saves reasoning", async t => {
  const positions = [];
  const { service } = harness(t, { callModel: async (_task, position) => {
    positions.push(position);
    return position === "primary" ? { ok: true, raw: { content: "", reasoning_content: "private" } } : reply();
  } });
  const result = await service.act({ action: "generate", caseId: "speaker" });
  assert.deepEqual(positions, ["primary", "fallback"]);
  assert.equal(result.cases.find(item => item.id === "speaker").candidate.position, "fallback");
});

test("failed generation retains the previous candidate and consumes the daily attempt", async t => {
  let fail = false;
  const { service } = harness(t, { callModel: async () => fail ? { ok: false } : reply() });
  await service.act({ action: "generate", caseId: "speaker" });
  fail = true;
  await assert.rejects(service.act({ action: "generate", caseId: "speaker" }), /已有对照保留/);
  const result = service.snapshot();
  assert.equal(result.todayRuns, 2);
  assert.equal(result.cases.find(item => item.id === "speaker").candidate.text, "答案是 42。");
});

test("replay rejects concurrent generation and enforces a persisted daily limit", async t => {
  let complete;
  const { service, filename } = harness(t, { callModel: () => new Promise(resolve => { complete = resolve; }) });
  const pending = service.act({ action: "generate", caseId: "speaker" });
  await assert.rejects(service.act({ action: "generate", caseId: "speaker" }), /已有回放/);
  complete(reply());
  await pending;
  const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
  saved.runs = 20;
  fs.writeFileSync(filename, JSON.stringify(saved));
  const restarted = createReplayService({ filename, callModel: () => assert.fail("must not call model") });
  await assert.rejects(restarted.act({ action: "generate", caseId: "speaker" }), /20 次/);
});

test("replay rejects unknown case IDs and invalid review values", async t => {
  const { service } = harness(t, { callModel: async () => reply() });
  await assert.rejects(service.act({ action: "generate", caseId: "../../secrets" }), /合成样例/);
  await service.act({ action: "generate", caseId: "speaker" });
  await assert.rejects(service.act({ action: "review", caseId: "speaker", review: "private arbitrary note" }), /不支持/);
});
