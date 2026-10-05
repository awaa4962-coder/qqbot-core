import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, URL } from "node:url";
import vm from "node:vm";
import { classifyOneBotReceipt } from "../bridge/onebot-receipt.mjs";
import { runVmTestFile } from "./vm-test-runner.mjs";

const root = fileURLToPath(new URL("../bridge/", import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));
const context = { groupId: 123, userId: 456, userMessage: "SYNTHETIC_BODY", assistantText: "SYNTHETIC_REPLY" };

async function setup({ realSelector = false } = {}) {
  const state = {
    stopped: "", privacyChanged: false, eligibilityMissing: false,
    live: { ok: true, mode: "steady", scopeKey: "group:123" },
    entry: { id: "PRIVATE_STICKER_ID", enabled: true, indexed: true, source: "qq-favorite",
      description: "PRIVATE_DESCRIPTION", url: "https://fixture.invalid/current.png", allowedGroups: [123] },
    calls: { policy: 0, eligibility: 0, selections: 0, sends: 0, records: [], cooldowns: [], sync: [] },
  };
  const sandbox = vm.createContext({ URL, AbortSignal: globalThis.AbortSignal,
    fetch: () => assert.fail("no network, model or QQ action") });
  const parseFixture = vm.runInContext("value => JSON.parse(value)", sandbox);
  const index = path.join(root, "features/stickers/index.mjs");
  const status = path.join(root, "features/stickers/reply-status.mjs");
  const sender = path.join(root, "features/stickers/sender.mjs");
  const schema = path.join(root, "features/stickers/schema.mjs");
  const outcome = path.join(root, "cognition/outcome.mjs");
  const receipt = path.join(root, "onebot-receipt.mjs");
  const safeUrl = path.join(root, "safe-url.mjs");
  const actual = new Set([index, status, sender, schema, outcome, receipt, safeUrl]);
  if (realSelector) {
    actual.add(path.join(root, "features/stickers/selector.mjs"));
    actual.add(path.join(root, "api-providers/task-budget.mjs"));
  }
  const sources = new Map([...actual].map(file => [file, fs.readFileSync(file, "utf8")]));
  const exports = new Map();
  for (const [file, source] of sources) {
    for (const match of source.matchAll(/(?:import|export)\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
      const target = match[2].startsWith("node:") ? match[2] : path.resolve(path.dirname(file), match[2]);
      if (!exports.has(target)) exports.set(target, new Set());
      for (const name of match[1].split(",").map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) exports.get(target).add(name);
    }
  }
  const policy = path.join(root, "features/stickers/policy.mjs");
  if (!exports.has(policy)) exports.set(policy, new Set());
  ["evaluateStickerPolicy", "recordStickerCooldown", "checkStickerReplyEligibility"].forEach(name => exports.get(policy).add(name));
  const unexpected = () => assert.fail("unexpected synthetic dependency invocation");
  const overrides = {
    log() {}, logE() {},
    traceStage() {},
    monotonicNow: () => 0,
    MODEL_TASKS: { STICKER_SELECT: "sticker_select" },
    buildStickerSelectionRequest: prompt => ({ messages: [{ role: "user", content: prompt }], tools: [], maxTokens: 100 }),
    measurePromptComposition: messages => ({ inputTextChars: JSON.stringify(messages).length, toolSchemaChars: 0 }),
    registeredContextSources: () => [],
    isDeepStrictEqual, isIP,
    isOutboundPayloadSuccessful: value => classifyOneBotReceipt(value) === "sent",
    chatRunStopReason: () => state.stopped,
    chatRunSignal: () => undefined,
    assertChatRunCurrent: () => { if (state.stopped) throw Object.assign(new Error(state.stopped), { code: "CHAT_CANCELLED" }); },
    checkChatSendDestination: () => ({ reason: "", checked: true }),
    createStickerPrivacyGuard: () => {
      const generation = state.privacyChanged;
      return () => {
        if (generation !== state.privacyChanged) throw Object.assign(new Error("privacy_changed"), { code: "STICKER_PRIVACY_CHANGED" });
      };
    },
    evaluateStickerPolicy: (_context, options = {}) => {
      state.calls.policy++;
      if (state.cooldownActive) return { ok: false, mode: state.live.mode, reasonCode: "cooldown" };
      const roll = (options.random || (() => 0))();
      return state.initialPolicy || { ok: roll < 0.5, mode: "steady", scopeKey: "group:123",
        reasonCode: roll < 0.5 ? "chance_selected" : "chance_missed" };
    },
    checkStickerReplyEligibility: (_context, options) => {
      assert.equal(options, undefined, "production live recheck must not pass snapshot settings or random");
      state.calls.eligibility++;
      if (state.cooldownActive) return { ok: false, mode: state.live.mode, reasonCode: "cooldown" };
      return state.live;
    },
    recordStickerCooldown: key => { state.calls.cooldowns.push(key); state.cooldownActive = true; },
    getStickerEntry: id => id === state.entry?.id ? parseFixture(JSON.stringify(state.entry)) : null,
    listSelectableStickers: () => state.entry ? parseFixture(JSON.stringify([state.entry])) : [],
    recordStickerSend: (id, ok) => state.calls.records.push({ id, ok }),
    syncStickerFavorites: async options => { state.calls.sync.push(options); return { ok: true }; },
    buildStickerCatalogSnapshot: () => ({ settings: { mode: state.live.mode }, counts: { pending: 0 }, stats: { sent: 7 } }),
    getStickerSyncStatus: () => ({ supported: true }),
    getStickerCaptureStatus: () => ({ classificationReused: 9 }),
    selectSticker: async () => { state.calls.selections++; return state.decision; },
    sendMsg: unexpected, sendPrivateMsg: unexpected,
  };
  state.decision = { action: "send", stickerId: state.entry.id, sticker: { ...state.entry, url: "https://fixture.invalid/old.png" },
    reasonCode: "selected", candidates: [{ id: "PRIVATE_CANDIDATE_ID", description: "PRIVATE_CANDIDATE_BODY" }] };
  const modules = new Map();
  const load = file => {
    if (!modules.has(file)) {
      if (actual.has(file)) modules.set(file, new vm.SourceTextModule(sources.get(file), { context: sandbox, identifier: file }));
      else {
        const names = [...(exports.get(file) || [])];
        modules.set(file, new vm.SyntheticModule(names, function () {
          for (const name of names) this.setExport(name, name === "checkStickerReplyEligibility" && state.eligibilityMissing
            ? undefined : overrides[name] || (() => assert.fail("unexpected synthetic dependency: " + path.relative(root, file) + ":" + name)));
        }, { context: sandbox, identifier: file }));
      }
    }
    return modules.get(file);
  };
  const entry = load(index);
  await entry.link((specifier, parent) => load(specifier.startsWith("node:") ? specifier : path.resolve(path.dirname(parent.identifier), specifier)));
  await entry.evaluate();
  const api = entry.namespace;
  state.run = async options => api.maybeSendStickerAfterReply(context, { send: async () => {
    state.calls.sends++;
    return { ok: true, reasonCode: "sent", result: { status: "ok", retcode: 0 } };
  }, ...options });
  return { state, api, status: load(status).namespace, sender: load(sender).namespace, read: () => plain(api.getStickerReplyStatus()) };
}

if (!vm.SourceTextModule) {
  test("isolated sticker reply status VM tests", () => runVmTestFile(import.meta.url, { minTests: 20 }));
} else {
test("status is process-only, fixed-size, detached and resettable", async () => {
  const { api, read } = await setup();
  const initial = api.getStickerReplyStatus();
  assert.equal(initial.scope, "process");
  assert.equal(initial.last, null);
  assert.equal(Object.keys(initial.counts).length, 8);
  initial.counts.sent = 99;
  assert.equal(read().counts.sent, 0);
  api.resetStickerReplyStatusForTest();
  assert.equal(read().last, null);
});

test("pure counter saturates and never stores arbitrary stages, reasons or bodies", async () => {
  const { status, read, api } = await setup();
  const opaque = { toString() { assert.fail("opaque reason must not be coerced"); } };
  status.recordStickerReplyStage("__proto__", opaque, opaque);
  assert.deepEqual(read().last, { stage: "unknown", reasonCode: "unknown_reason", physicalReceipt: "unknown" });
  for (let i = 0; i <= status.STICKER_REPLY_COUNTER_LIMIT; i++) status.recordStickerReplyStage("skipped", "chance_missed");
  assert.equal(read().counts.skipped, status.STICKER_REPLY_COUNTER_LIMIT);
  assert.equal(Object.keys(read().counts).length, 8);
  api.resetStickerReplyStatusForTest();
  assert.ok(Object.values(read().counts).every(value => value === 0));
});

test("legacy fixed policy reasons map without selection or sending", async () => {
  const { state, read } = await setup();
  state.initialPolicy = { ok: false, reason: "\u6982\u7387\u672a\u547d\u4e2d" };
  const result = await state.run();
  assert.equal(result.stage, "policy");
  assert.equal(read().last.reasonCode, "chance_miss");
  assert.equal(read().counts.skipped, 1);
  assert.equal(state.calls.selections + state.calls.sends, 0);
});

test("no-match is skipped and simulation cannot impersonate a reply send", async () => {
  const { state, api, read } = await setup();
  state.decision = { action: "no_match", reasonCode: "model_no_match" };
  await state.run();
  const before = read();
  await api.simulateStickerSelection(context);
  assert.deepEqual(read(), before);
  assert.equal(before.counts.skipped, 1);
  assert.equal(before.counts.selected, 0);
  assert.equal(state.calls.sends, 0);
});

test("selection reason codes keep normal no-match distinct from invalid or failed output", async () => {
  for (const [reasonCode, stage] of [["selection_none", "skipped"], ["selection_invalid", "knownfailed"], ["selection_failed", "knownfailed"]]) {
    const { state, read } = await setup();
    state.decision = { action: "no_match", reasonCode };
    await state.run();
    assert.equal(read().last.reasonCode, reasonCode);
    assert.equal(read().counts[stage], 1);
    assert.equal(state.calls.sends, 0);
  }
  const { state, read } = await setup();
  state.decision.reasonCode = "selection_selected";
  await state.run({ send: async () => {
    assert.equal(read().last.reasonCode, "selection_selected");
    return { ok: true };
  } });
});

test("live eligibility before select cannot trust stale enabled policyOptions", async () => {
  const { state, read } = await setup();
  state.live = { ok: false, mode: "off", reasonCode: "sticker_off" };
  await state.run({ policyOptions: { settings: { mode: "steady", chance: 1 }, random: () => 0 } });
  assert.equal(state.calls.policy, 1);
  assert.equal(state.calls.selections + state.calls.sends, 0);
  assert.equal(read().last.reasonCode, "sticker_off");
});

test("caller ensureAllowed false or nonempty reason blocks the NapCat request", async () => {
  for (const allowed of [false, "group_disabled", "PRIVATE_BLOCK_REASON"]) {
    const { state, read } = await setup();
    let requests = 0;
    await state.run({ senderOptions: { ensureAllowed: () => allowed }, send: async (_decision, _context, options) => {
      options.ensureAllowed();
      requests++;
      return { ok: true };
    } });
    assert.equal(requests, 0);
    assert.equal(read().counts.cancelled, 1);
    assert.doesNotMatch(JSON.stringify(read()), /PRIVATE_BLOCK_REASON/);
  }
});

test("selection and shadow are distinct from physical sends", async () => {
  const { state, read } = await setup();
  state.live.mode = "shadow";
  const result = await state.run();
  assert.equal(result.stage, "shadow", JSON.stringify(result));
  assert.equal(result.sent, false);
  assert.equal(read().counts.selected, 1);
  assert.equal(read().counts.shadow, 1);
  assert.equal(read().counts.sent, 0);
  assert.equal(state.calls.sends, 0);
});

test("sent uses the latest catalog entry and rolls chance exactly once", async () => {
  const { state, read } = await setup();
  let rolls = 0;
  const result = await state.run({ policyOptions: { random: () => { rolls++; return 0.3; } },
    send: async (decision, _context, options) => {
      state.calls.sends++;
      assert.equal(decision.sticker.url, state.entry.url);
      options.ensureAllowed();
      options.assertCurrent();
      assert.equal(options.stopReason(), "");
      return { ok: true, result: { status: "ok", retcode: 0 }, reasonCode: "sent" };
    } });
  assert.equal(result.sent, true);
  assert.equal(rolls, 1);
  assert.equal(state.calls.policy, 1);
  assert.equal(state.calls.sends, 1);
  assert.equal(read().counts.sent, 1);
  assert.equal(state.calls.records.length, 1);
  assert.equal(state.calls.cooldowns.length, 1);
});

for (const [name, change, code] of [
  ["off", state => { state.live = { ok: false, mode: "off", reasonCode: "sticker_off" }; }, "sticker_off"],
  ["group revoked", state => { state.live = { ok: false, mode: "steady", reasonCode: "group_disabled" }; }, "group_disabled"],
  ["private revoked", state => { state.live = { ok: false, mode: "steady", reasonCode: "private_disabled" }; }, "private_disabled"],
]) {
  test("live " + name + " after selection blocks sending without a probability reroll", async () => {
    const { state, read } = await setup();
    await state.run({ select: async () => { change(state); return state.decision; } });
    assert.equal(state.calls.policy, 1);
    assert.equal(state.calls.sends, 0);
    assert.equal(read().counts.skipped, 1);
    assert.equal(read().last.reasonCode, code);
  });
}

for (const [name, change] of [
  ["removed", state => { state.entry = null; }],
  ["disabled", state => { state.entry.enabled = false; }],
  ["unindexed", state => { state.entry.indexed = false; }],
  ["invalid materials", state => { state.entry.url = "file:///private.png"; }],
  ["capture candidate", state => { state.entry.source = "group-capture"; state.entry.captureState = "candidate"; }],
  ["entry group revoked", state => { state.entry.allowedGroups = [999]; }],
]) {
  test("latest " + name + " entry cannot reuse the old selection snapshot", async () => {
    const { state, read } = await setup();
    await state.run({ select: async () => { const decision = state.decision; change(state); return decision; } });
    assert.equal(state.calls.sends, 0);
    assert.equal(read().counts.sent, 0);
    assert.equal(read().counts.skipped, 1);
  });
}

test("private selection cannot send an entry changed from global to group-only during await", async () => {
  const { state, api, read } = await setup();
  state.entry.allowedGroups = [];
  state.decision.sticker.allowedGroups = [];
  state.live.scopeKey = "private:456";
  let sends = 0;
  await api.maybeSendStickerAfterReply({ ...context, private: true }, {
    select: async () => {
      state.entry.allowedGroups = [123];
      return state.decision;
    },
    send: async () => { sends++; return { ok: true }; },
  });
  assert.equal(sends, 0);
  assert.equal(read().counts.selected, 1);
  assert.equal(read().counts.skipped, 1);
  assert.equal(read().last.reasonCode, "entry_group_only");
});

test("meaning or source identity changed during selection cannot reinterpret the old model choice", async () => {
  for (const patch of [{ description: "Changed meaning" }, { tags: ["changed"] },
    { source: "group-capture", captureState: "active" }, { md5: "1".repeat(32) }]) {
    const { state, read } = await setup();
    await state.run({ select: async () => { Object.assign(state.entry, patch); return state.decision; } });
    assert.equal(state.calls.sends, 0);
    assert.equal(read().last.reasonCode, "sticker_changed");
    assert.equal(read().counts.skipped, 1);
  }
});

test("per-request callback merges caller guards and rejects changed live material", async () => {
  const { state, read } = await setup();
  let callerGuards = 0, requests = 0;
  await state.run({ senderOptions: { ensureAllowed: () => { callerGuards++; }, assertCurrent: () => { callerGuards++; } },
    send: async (_decision, _context, options) => {
      options.ensureAllowed();
      state.entry.url = "https://fixture.invalid/changed.png";
      assert.equal(options.stopReason(), "sticker_changed");
      options.ensureAllowed();
      requests++;
      return { ok: true };
    } });
  assert.ok(callerGuards >= 2);
  assert.equal(requests, 0);
  assert.equal(read().last.reasonCode, "sticker_changed");
});

test("known rejection keeps the existing analyze-false sync exactly once", async () => {
  const { state, read } = await setup();
  await state.run({ send: async () => { state.calls.sends++; return {
    ok: false, reasonCode: "send_failed", error: "PRIVATE_TRANSPORT_BODY",
    result: { status: "failed", retcode: 1404 } }; } });
  assert.equal(read().counts.knownfailed, 1);
  assert.equal(read().counts.unknown, 0);
  assert.equal(state.calls.sends, 1);
  assert.deepEqual(plain(state.calls.sync), [{ analyze: false }]);
  assert.equal(state.calls.records[0].ok, false);
});

test("unknown receipt cannot be rewritten as rejection, no-send, sync or replay", async () => {
  const { state, read } = await setup();
  const result = await state.run({ send: async () => { state.calls.sends++; return {
    ok: false, reasonCode: "send_unknown", result: { status: "unknown", delivery: "unconfirmed" } }; } });
  assert.equal(result.sent, null);
  assert.equal(result.physicalReceipt, "unknown");
  assert.equal(read().counts.unknown, 1);
  assert.equal(read().counts.knownfailed, 0);
  assert.equal(state.calls.sends, 1);
  assert.equal(state.calls.sync.length + state.calls.records.length, 0);
  assert.equal(state.calls.cooldowns.length, 0);
});

test("partial receipt remains physical even though the overall outcome is not ok", async () => {
  const { state, read } = await setup();
  const result = await state.run({ send: async () => ({ ok: false, reasonCode: "send_partial",
    result: [{ status: "ok", retcode: 0 }, { status: "failed", retcode: 1404 }] }) });
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.equal(result.physicalReceipt, "partial");
  assert.equal(read().counts.partial, 1);
  assert.equal(state.calls.sync.length + state.calls.records.length, 0);
});

for (const receipt of ["sent", "partial", "unknown"]) {
  test("privacy change after " + receipt + " commits physical evidence before cancellation", async () => {
    const { state, read } = await setup();
    const raw = receipt === "sent" ? { status: "ok", retcode: 0 }
      : receipt === "partial" ? [{ status: "ok", retcode: 0 }, { status: "failed", retcode: 1404 }]
        : { status: "unknown", delivery: "unconfirmed" };
    const result = await state.run({ send: async () => {
      state.privacyChanged = true;
      return { ok: receipt === "sent", result: raw, reasonCode: receipt === "sent" ? "sent" : "send_" + receipt };
    } });
    assert.equal(read().counts[receipt], 1);
    assert.equal(read().counts.cancelled, 1);
    assert.equal(read().last.physicalReceipt, receipt);
    assert.equal(read().last.reasonCode, "privacy_changed");
    assert.equal(result.sent, receipt === "unknown" ? null : true);
    assert.equal(result.decision, undefined);
    assert.equal(state.calls.records.length + state.calls.sync.length, 0);
    assert.equal(state.calls.cooldowns.length, receipt === "unknown" ? 0 : 1);
  });
}

test("partial and late-privacy sent receipts cool down the next reply without self-blocking postflight", async () => {
  for (const kind of ["partial", "late-privacy-sent"]) {
    const { state, read } = await setup();
    const first = await state.run({ send: async () => {
      state.calls.sends++;
      if (kind === "late-privacy-sent") state.privacyChanged = true;
      return kind === "partial" ? { ok: false, reasonCode: "send_partial",
        result: [{ status: "ok", retcode: 0 }, { status: "failed", retcode: 1404 }] }
        : { ok: true, reasonCode: "sent", result: { status: "ok", retcode: 0 } };
    } });
    assert.equal(first.sent, true);
    assert.equal(first.physicalReceipt, kind === "partial" ? "partial" : "sent");
    assert.equal(read().last.reasonCode, kind === "partial" ? "send_partial" : "privacy_changed");
    assert.deepEqual(state.calls.cooldowns, ["group:123"]);
    const before = state.calls.selections;
    const second = await state.run();
    assert.equal(second.reasonCode, "cooldown");
    assert.equal(state.calls.selections, before);
    assert.equal(state.calls.sends, 1);
    assert.equal(state.calls.cooldowns.length, 1);
  }
});

test("confirmed receipt survives live off and sender guardStopped", async () => {
  const { state, read } = await setup();
  const result = await state.run({ send: async () => {
    state.live = { ok: false, mode: "off", reasonCode: "sticker_off" };
    return { ok: true, result: { status: "ok", retcode: 0 }, reasonCode: "sent", guardStopped: true };
  } });
  assert.equal(result.sent, true);
  assert.equal(read().counts.sent, 1);
  assert.equal(read().counts.cancelled, 1);
  assert.equal(read().last.reasonCode, "sticker_off");
});

test("thrown selection and transport are distinct and neither leaks raw errors", async () => {
  const { state, read, api } = await setup();
  await state.run({ select: async () => { throw new Error("PRIVATE_SELECTION_BODY"); } });
  assert.equal(read().counts.knownfailed, 1);
  assert.equal(read().last.reasonCode, "selection_failed");
  api.resetStickerReplyStatusForTest();
  await state.run({ send: async () => { throw new Error("PRIVATE_TRANSPORT_BODY"); } });
  assert.equal(read().counts.unknown, 1);
  assert.equal(read().last.reasonCode, "send_unknown");
  assert.equal(state.calls.sync.length, 0);
});

test("cancellation before selection is not a selection, failure or send", async () => {
  const { state, read } = await setup();
  state.stopped = "permission_changed";
  await state.run();
  assert.equal(read().counts.cancelled, 1);
  assert.equal(state.calls.policy + state.calls.selections + state.calls.sends, 0);
});

test("runtime status exposes replyStatus without altering capture reuse or retaining identities", async () => {
  const { state, api, read } = await setup();
  await state.run();
  const runtime = plain(api.getStickerRuntimeStatus());
  assert.deepEqual(runtime.replyStatus, read());
  assert.equal(runtime.capture.classificationReused, 9);
  assert.equal(runtime.stats.sent, 7);
  assert.doesNotMatch(JSON.stringify(runtime.replyStatus), /PRIVATE_|fixture|SYNTHETIC|123|456|https/);
});

test("real selector preserves legal raw double-space meaning while prompt projection is clipped", async () => {
  const { state, api, read } = await setup({ realSelector: true });
  state.entry.description = "fixture  context";
  state.entry.tags = ["\u5f00\u5fc3"];
  const positions = [];
  let rolls = 0;
  const result = await api.maybeSendStickerAfterReply({ ...context, userMessage: "fixture context" }, {
    policyOptions: { random: () => { rolls++; return 0.3; } },
    selectorOptions: { model: async (prompt, position, request) => {
      positions.push(position);
      assert.ok(prompt.includes("fixture context"));
      assert.ok(!prompt.includes("fixture  context"));
      assert.equal(request.beforeAttempt(), "");
      return JSON.stringify({ selected: state.entry.id });
    } },
    send: async decision => {
      state.calls.sends++;
      assert.equal(decision.sticker.description, "fixture  context");
      return { ok: true, result: { status: "ok", retcode: 0 }, reasonCode: "sent" };
    },
  });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.deepEqual(positions, ["primary"]);
  assert.equal(rolls, 1);
  assert.equal(state.calls.sends, 1);
  assert.equal(read().counts.sent, 1);
});

for (const [name, reasonCode, isPrivate] of [["off", "sticker_off", false],
  ["private scope revoked", "private_disabled", true], ["catalog invalid", "catalog_unavailable", false]]) {
  for (const output of [null, "invalid model output"]) {
    test("real selector primary then " + name + " blocks fallback for " + (output === null ? "null" : "invalid") + " output", async () => {
      const { state, api, read } = await setup({ realSelector: true });
      state.entry.description = "fixture context";
      state.entry.tags = ["\u5f00\u5fc3"];
      if (isPrivate) state.entry.allowedGroups = [];
      const positions = [];
      let oldGuards = 0, rolls = 0, sends = 0;
      const result = await api.maybeSendStickerAfterReply({ ...context, private: isPrivate, userMessage: "fixture context" }, {
        policyOptions: { random: () => { rolls++; return 0.3; } },
        selectorOptions: { assertCurrent: () => { oldGuards++; }, model: async (_prompt, position, request) => {
          positions.push(position);
          request.validatePrepared(request);
          assert.equal(request.beforeAttempt(), "");
          state.live = { ok: false, mode: name === "off" ? "off" : "steady", reasonCode };
          assert.equal(request.beforeAttempt(), "task_cancelled", "retry hook must share the live guard");
          assert.throws(() => request.validatePrepared(request), error => error.reasonCode === reasonCode);
          return output;
        } },
        send: async () => { sends++; return { ok: true }; },
      });
      assert.deepEqual(positions, ["primary"]);
      assert.ok(oldGuards > 0);
      assert.equal(rolls, 1);
      assert.equal(sends, 0);
      assert.equal(result.reasonCode, reasonCode);
      assert.equal(read().counts.selected, 0);
      assert.equal(state.calls.sync.length + state.calls.cooldowns.length, 0);
    });
  }
}

test("real selector caller assertion cannot revoke live access and still reach the model", async () => {
  const { state, api } = await setup({ realSelector: true });
  state.entry.description = "fixture context";
  state.entry.tags = ["\u5f00\u5fc3"];
  let models = 0;
  const result = await api.maybeSendStickerAfterReply(context, { selectorOptions: {
    assertCurrent: () => { state.live = { ok: false, mode: "off", reasonCode: "sticker_off" }; },
    model: async () => { models++; return null; },
  } });
  assert.equal(models, 0);
  assert.equal(result.reasonCode, "sticker_off");
});

test("actual sender preserves receipt across its in-flight privacy guard and cannot fallback", async () => {
  const { state, api, read } = await setup();
  let requests = 0;
  const result = await api.maybeSendStickerAfterReply(context, { senderOptions: { sendGroup: async () => {
    requests++;
    state.privacyChanged = true;
    return { status: "ok", retcode: 0 };
  } } });
  assert.equal(requests, 1);
  assert.equal(result.sent, true);
  assert.equal(read().counts.sent, 1);
  assert.equal(read().counts.cancelled, 1);
});

test("actual sender fallback request is blocked after scope revocation", async () => {
  const { state, api, read } = await setup();
  Object.assign(state.entry, { emojiId: "synthetic-emoji", packageId: "synthetic-package", key: "PRIVATE_KEY" });
  state.decision.sticker = { ...state.entry };
  let requests = 0;
  await api.maybeSendStickerAfterReply(context, { senderOptions: { sendGroup: async () => {
    requests++;
    state.live = { ok: false, mode: "off", reasonCode: "sticker_off" };
    return { status: "failed", retcode: 1404 };
  } } });
  assert.equal(requests, 1);
  assert.equal(read().counts.knownfailed, 1);
  assert.equal(read().counts.cancelled, 1);
  assert.equal(state.calls.sync.length, 0);
});
}
