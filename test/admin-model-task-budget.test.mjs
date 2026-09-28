import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReplayService } from "../bridge/diagnostics/replay.mjs";
import { testApiProvider } from "../bridge/admin-api/api-provider-manager.mjs";
import { createDefaultApiConfig } from "../bridge/api-providers/store.mjs";

const response = () => ({ ok: true, provider: "deepseek", raw: { choices: [{ message: { content: "OK" } }] } });

test("replay late primary never overwrites an existing candidate or starts fallback", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-budget-replay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 0; let calls = 0; let late = false;
  const service = createReplayService({ filename: path.join(root, "replay.json"), budgetClock: () => now,
    callModel: async (_task, position, request) => {
      calls++; assert.equal(position, "primary"); assert.equal(request.beforeAttempt(), "");
      if (late) now += 90000;
      return response();
    } });
  await service.act({ action: "generate", caseId: "speaker" });
  const previous = service.snapshot().cases.find(item => item.id === "speaker").candidate;
  late = true;
  await assert.rejects(service.act({ action: "generate", caseId: "speaker" }), /task_deadline/);
  assert.equal(calls, 2);
  assert.deepEqual(service.snapshot().cases.find(item => item.id === "speaker").candidate, previous);
  assert.equal(service.snapshot().todayRuns, 2);
});

test("replay runner cancellation rejects late output and releases busy state", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-budget-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new globalThis.AbortController();
  let calls = 0;
  const service = createReplayService({ filename: path.join(root, "replay.json"), callModel: async () => {
    calls++; controller.abort(); return response();
  } });
  await assert.rejects(service.act({ action: "generate", caseId: "speaker" }, { signal: controller.signal }), /task_cancelled/);
  assert.equal(calls, 1);
  assert.equal(service.snapshot().busy, false);
  assert.equal(service.snapshot().cases.find(item => item.id === "speaker").candidate, null);
});

test("connection test uses a small bounded request and rejects late success", async () => {
  let now = 0; let calls = 0;
  const result = await testApiProvider("deepseek", { config: createDefaultApiConfig(), budgetClock: () => now,
    callProvider: async (_provider, request) => {
      calls++; assert.equal(request.maxTokens, 24); assert.equal(request.maxResponseBytes, 65536);
      assert.equal(request.beforeAttempt(), ""); assert.equal(request.beforeAttempt(), "");
      assert.equal(request.beforeAttempt(), "task_budget"); now = 15000; return response();
    } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_deadline");
  assert.equal(result.output, undefined);
});

test("pre-cancelled connection test makes no provider call", async () => {
  const controller = new globalThis.AbortController(); controller.abort();
  const result = await testApiProvider("deepseek", { config: createDefaultApiConfig(), signal: controller.signal,
    callProvider: async () => assert.fail("provider must not run") });
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_cancelled");
});
