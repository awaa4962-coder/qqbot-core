import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setImmediate } from "node:timers";
import test from "node:test";

// Isolate imports as well as fixtures: no developer config, data, model API, or QQ transport.
const artifacts = process.env.QQFRIEND_TEST_ARTIFACTS || (process.platform === "win32"
  ? "F:/CodexArtifacts/qqfriend/20261001/temp" : path.join(os.tmpdir(), "qqfriend-business-drafts"));
fs.mkdirSync(artifacts, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(artifacts, "business-drafts-"));
const { AbortController, AbortSignal } = globalThis;
process.env.NODE_ENV = "test";
process.env.QQBOT_CONFIG_ROOT = sandbox;
process.env.QQBOT_DATA_DIR = sandbox;
process.env.QQBOT_LOG_DIR = path.join(sandbox, "logs");
process.env.QQBOT_MEMORY_PROFILE_FILE = path.join(sandbox, "profiles.json");
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("network_forbidden"); };
const { createBusinessDraftAdapter } = await import("../bridge/chat-tools/business-drafts.mjs");
const { sendGroupSummaryForDate } = await import("../bridge/group-summary/service.mjs");
const { buildDiscussionBundle } = await import("../bridge/group-summary/analysis.mjs");
const { selectSummaryRecords } = await import("../bridge/features/conversation-summary/records.mjs");
const { generateConversationSummary } = await import("../bridge/features/conversation-summary/prompt.mjs");

const NOW = Date.parse("2026-10-01T12:00:00+08:00");
const GROUP = "51001";
const USER = "61001";
const OTHER = "61002";
const BOT = "91001";
const start = Date.parse("2026-10-01T00:00:00+08:00");
const raw = text => ({ ok: true, provider: "synthetic", raw: { choices: [{ finish_reason: "stop", message: { content: text } }] } });

function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(sandbox, "fixture-"));
  const control = new AbortController();
  const calls = [];
  const stages = [];
  let epoch = 0;
  const cfg = { dataRoot: root, chatLogFile: path.join(root, "group_chats.json"), selfUin: BOT, botNames: ["Synthetic"],
    groupWhitelist: [GROUP], agentGroupWhitelist: [GROUP], summaryGroupWhitelist: [GROUP], conversationSummaryGroupWhitelist: [GROUP] };
  const options = { scope: { surface: "group", groupId: GROUP, userId: USER, currentMessageId: "70001" }, cfg,
    userMessage: "Please draft a summary", messageId: "70001", mentionTargets: [OTHER], now: NOW, signal: control.signal,
    assertCurrent: () => {}, onProgress: stage => stages.push(stage),
    summaryPrivacy: () => ({ epoch, users: {} }),
    callModel: async (...args) => { calls.push(args); return raw("A scoped summary."); },
    sendGroupSummaryForDate: async value => {
      value.onProgress("collecting");
      await value.callPrimarySummary("existing prompt", request(value.signal));
      return { ok: true, summary: "Daily draft", provider: "synthetic", sent: false, dryRun: true,
        privacyEpoch: epoch, messages: 3, coverage: { source: "retained-only", captured: 3 } };
    },
    selectSummaryRecords: (groupId, targets, range) => ({ groupId, range, privacyEpoch: epoch,
      targets: targets.map(item => ({ ...item, name: "Member", count: 1 })),
      transcript: [], selected: targets.length, background: 0, sampled: false, truncated: false, partial: true }),
    generateConversationSummary: async (_bundle, value) => {
      value.onProgress("analyzing");
      await value.callProvider("conversation_summary", "primary", request(value.signal), {});
      return { ok: true, text: "Conversation draft", provider: "synthetic", position: "primary" };
    }, ...extra };
  return { options, cfg, root, control, calls, stages, forget: () => epoch++, create: () => createBusinessDraftAdapter(options) };
}

function request(signal) { return { systemPrompt: "Existing business prompt", messages: [{ role: "user", content: "Evidence" }],
  maxTokens: 4096, timeoutMs: 45000, signal, options: { usageContext: { task: "synthetic" } } }; }
function businessResult(kind, text = "Draft") {
  return kind === "daily" ? { ok: true, summary: text, sent: false, dryRun: true, privacyEpoch: 0 }
    : { ok: true, text, provider: "synthetic" };
}
function stubBusiness(f, kind, handler) {
  if (kind === "daily") f.options.sendGroupSummaryForDate = handler;
  else f.options.generateConversationSummary = (_bundle, options) => handler(options);
}
function modelEntry(kind, options) {
  return kind === "daily" ? value => options.callPrimarySummary("prompt", value)
    : value => options.callProvider("conversation_summary", "primary", value, {});
}
function denied(result, reason) { assert.deepEqual(result, { ok: false, reason, sent: false, persisted: false }); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function snapshot(root) {
  const result = {};
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) walk(filename);
      else result[path.relative(root, filename)] = fs.readFileSync(filename).toString("base64");
    }
  }
  walk(root); return result;
}

for (const kind of ["daily", "conversation"]) {
  test(kind + " returns only a draft with coverage and sanitized metadata", async () => {
    const f = fixture();
    const result = await f.create().generate({ kind });
    assert.equal(result.ok, true); assert.equal(result.kind, kind);
    assert.equal(result.sent, false); assert.equal(result.persisted, false);
    assert.equal(result.coverage.scope, "current_group"); assert.equal(result.coverage.complete, false);
    assert.equal(result.provider, "synthetic");
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].maxTokens, 1536);
    assert.equal(f.calls[0][2].options.allowTools, false);
    assert.ok(f.calls[0][2].signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(result), /outputFile|rawmodel|reasoning|userId|groupId|uid|root|keys/);
  });

  test(kind + " checks its own business whitelist independently", async () => {
    const f = fixture();
    const own = kind === "daily" ? "summaryGroupWhitelist" : "conversationSummaryGroupWhitelist";
    const unrelated = kind === "daily" ? "conversationSummaryGroupWhitelist" : "summaryGroupWhitelist";
    f.cfg[unrelated] = [];
    assert.equal((await f.create().generate({ kind })).ok, true);
    f.cfg[own] = [];
    denied(await f.create().generate({ kind }), "permission_changed");
  });

  test(kind + " revocation during a model call discards late completion", async () => {
    const gate = deferred(); const entered = deferred();
    const f = fixture({ callModel: async () => { entered.resolve(); return await gate.promise; } });
    const run = f.create().generate({ kind });
    await entered.promise;
    f.cfg[kind === "daily" ? "summaryGroupWhitelist" : "conversationSummaryGroupWhitelist"] = [];
    gate.resolve(raw("late secret draft"));
    denied(await run, "permission_changed");
  });

  test(kind + " forgetting during a model call discards late completion", async () => {
    const gate = deferred(); const entered = deferred();
    const f = fixture({ callModel: async () => { entered.resolve(); return await gate.promise; } });
    const run = f.create().generate({ kind }); await entered.promise;
    f.forget(); gate.resolve(raw("forgotten evidence"));
    denied(await run, "privacy_changed");
  });

  test(kind + " abort refuses late results but drains the actual parent call before returning", async () => {
    const gate = deferred(); const entered = deferred();
    const f = fixture({ callModel: async () => { entered.resolve(); return await gate.promise; } });
    let settled = false;
    const run = f.create().generate({ kind }).then(value => { settled = true; return value; }); await entered.promise;
    f.control.abort("private reason must not escape");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    gate.resolve(raw("late result")); denied(await run, "cancelled");
  });

  test(kind + " refuses missing callback even if a local draft would be possible", async () => {
    const f = fixture({ callModel: undefined });
    denied(await f.create().generate({ kind }), "model_callback_required");
  });

  for (const day of ["today", "yesterday", "2026-09-25"]) {
    test(kind + " accepts bounded Shanghai day " + day, async () => {
      const f = fixture(); const result = await f.create().generate({ kind, day });
      assert.equal(result.ok, true);
      assert.ok(result.coverage.from >= start - 6 * 86400000);
      assert.ok(result.coverage.to <= (kind === "daily" ? start + 86400000 - 1 : NOW));
    });
  }

  for (const day of ["2026-09-24", "2026-10-02", "2026-09-31", "2026-02-30"]) {
    test(kind + " rejects out-of-range or impossible day " + day, async () => {
      const f = fixture(); denied(await f.create().generate({ kind, day }), "invalid_date"); assert.equal(f.calls.length, 0);
    });
  }
}

test("strict schemas reject authority, paths, publication, profiles, max, symbols and accessors", async () => {
  const f = fixture(); const adapter = f.create();
  const inputs = [null, [], "daily", {}, { kind: "other" }, { kind: "daily", day: 1 }, { kind: "daily", day: "all" },
    { kind: "conversation", separate: "true" }, { kind: "conversation", targets: [] },
    { kind: "daily", targets: USER }, { kind: "daily", separate: true },
    Object.assign(Object.create({ groupId: "other" }), { kind: "daily" }), { kind: "daily", [Symbol("path")]: "bad" },
    Object.defineProperty({}, "kind", { get() { return assert.fail("accessor must not run"); } }),
    ...["groupId", "path", "root", "send", "profile", "max", "userId", "provider", "prepared", "__proto__"].map(key => ({ kind: "daily", [key]: "bad" }))];
  for (const args of inputs) denied(await adapter.generate(args), "invalid_arguments");
  assert.equal(f.calls.length, 0);
});

test("requester and only backend-bound explicit mentions are authorized", async () => {
  const f = fixture({ members: [{ uid: "61003" }], userMessage: "@61003 is plain text" });
  const adapter = f.create();
  for (const targets of [USER, OTHER, USER + "," + OTHER]) assert.equal((await adapter.generate({ kind: "conversation", targets })).ok, true);
  denied(await adapter.generate({ kind: "conversation", targets: "61003" }), "target_not_allowed");
  denied(await adapter.generate({ kind: "conversation", targets: BOT }), "target_not_allowed");
});

test("canonical distinct QQ IDs are limited to four", async () => {
  const f = fixture({ mentionTargets: [OTHER, "61003", "61004", "61005"] });
  assert.equal((await f.create().generate({ kind: "conversation", targets: "61001 61002 61003 61004" })).ok, true);
  for (const targets of ["", "all", "@61001", "061001", "1234", "+61001", "61001,61001", "61001 61002 61003 61004 61005", "61001;61002"]) {
    denied(await f.create().generate({ kind: "conversation", targets }), "invalid_arguments");
  }
});

test("structured backend mentions allow uid or qq but not all-members or bot entries", async () => {
  const f = fixture({ mentionTargets: [{ uid: OTHER }, { qq: "61003" }, { qq: "61004", isAll: true }, { uid: "61005", isBot: true }] });
  assert.equal((await f.create().generate({ kind: "conversation", targets: OTHER + " 61003" })).ok, true);
  for (const targets of ["61004", "61005"]) denied(await f.create().generate({ kind: "conversation", targets }), "target_not_allowed");
});

test("default conversation targets requester and recent two hours, with separate forwarded", async () => {
  let selected;
  const f = fixture(); const select = f.options.selectSummaryRecords;
  f.options.selectSummaryRecords = (...args) => { selected = args; return select(...args); };
  f.options.generateConversationSummary = async (_bundle, options) => {
    assert.equal(options.separate, true); assert.equal(options.userId, USER);
    return { ok: true, text: "Ready", provider: "synthetic" };
  };
  assert.equal((await f.create().generate({ kind: "conversation", separate: true })).ok, true);
  assert.deepEqual(selected[1], [{ uid: USER }]);
  assert.deepEqual(selected[2], { from: NOW - 7200000, to: NOW }); assert.equal(selected[3].excludeMessageId, "70001");
});

test("private, interjection, unmentioned, empty and non-agent scopes are disabled", async () => {
  for (const extra of [{ scope: { surface: "private", userId: USER } }, { task: "interjection" },
    { mentioned: false }, { userMessage: "" }, { messageId: undefined }, { scope: { surface: "group", userId: "061001", groupId: GROUP } }]) {
    const f = fixture(extra); denied(await f.create().generate({ kind: "daily" }), "not_allowed"); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.cfg.agentGroupWhitelist = [];
  denied(await f.create().generate({ kind: "daily" }), "not_allowed");
});

test("parent guard is mandatory and a privacy or stale failure cannot leak its message", async () => {
  const f = fixture({ assertCurrent: undefined }); denied(await f.create().generate({ kind: "daily" }), "guard_unavailable");
  const g = fixture({ assertCurrent: () => { throw new Error("private /path key=secret"); } });
  denied(await g.create().generate({ kind: "daily" }), "stale_request");
  const p = fixture({ assertCurrent: () => { throw new Error("privacy_changed"); } });
  denied(await p.create().generate({ kind: "daily" }), "privacy_changed");
});

test("identity, message, read-root and mention changes are checked after model awaits", async () => {
  const changes = [f => { f.options.scope.groupId = "51002"; }, f => { f.options.scope.userId = OTHER; },
    f => { f.options.messageId = "70002"; }, f => { f.options.userMessage = "different request"; },
    f => { f.cfg.dataRoot = "forbidden"; }, f => { f.options.mentionTargets = []; }];
  for (const [index, change] of changes.entries()) {
    const f = fixture(); f.options.callModel = async () => { change(f); return raw("old draft"); };
    denied(await f.create().generate({ kind: "conversation", targets: OTHER }), index === changes.length - 1 ? "target_not_allowed" : "stale_request");
  }
});

test("revocation at collecting prevents any selection or transport", async () => {
  const f = fixture();
  f.options.onProgress = () => { f.cfg.conversationSummaryGroupWhitelist = []; };
  f.options.selectSummaryRecords = () => assert.fail("must not collect after revocation");
  denied(await f.create().generate({ kind: "conversation" }), "permission_changed"); assert.equal(f.calls.length, 0);
});

test("daily cannot persist prepared revisions or advertise sent results", async () => {
  for (const extra of [{ revisionId: "saved" }, { revisionId: "" }, { outputFile: "private/path" },
    { sent: true }, { persisted: true }, { dryRun: false }, { groupId: "51002" }, { dateText: "2026-09-30" }]) {
    const f = fixture({ sendGroupSummaryForDate: async () => ({ ok: true, summary: "bad", sent: false, dryRun: true, privacyEpoch: 0, ...extra }) });
    denied(await f.create().generate({ kind: "daily" }), "unsafe_service_result");
  }
});

test("malformed conversation text and side-effect flags never become successful drafts", async () => {
  for (const extra of [{ text: undefined }, { text: {} }, { text: "" }, { sent: true }, { persisted: true }]) {
    const f = fixture({ generateConversationSummary: async () => ({ ok: true, text: "Draft", ...extra }) });
    denied(await f.create().generate({ kind: "conversation" }), "unsafe_service_result");
  }
});

test("cross-group, private, changed range and substituted targets fail closed", async () => {
  for (const change of [b => { b.groupId = "51002"; }, b => { b.range = { from: 0, to: NOW }; },
    b => { b.targets[0].uid = OTHER; }, b => { b.transcript = [{ surface: "private" }]; },
    b => { b.transcript = [{ groupId: "51002" }]; }]) {
    const f = fixture(); const select = f.options.selectSummaryRecords;
    f.options.selectSummaryRecords = (...args) => { const b = select(...args); change(b); return b; };
    denied(await f.create().generate({ kind: "conversation" }), "unsafe_service_result"); assert.equal(f.calls.length, 0);
  }
});

test("missing records never invoke a model, and missing members are covered without UIDs", async () => {
  const f = fixture(); const select = f.options.selectSummaryRecords;
  f.options.selectSummaryRecords = (...args) => ({ ...select(...args), selected: 0 });
  denied(await f.create().generate({ kind: "conversation" }), "no_records"); assert.equal(f.calls.length, 0);
  f.options.selectSummaryRecords = (...args) => {
    const b = select(...args); b.targets[1].count = 0; b.sampled = true; b.truncated = true; return b;
  };
  const result = await f.create().generate({ kind: "conversation", targets: USER + " " + OTHER });
  assert.equal(result.coverage.missingTargets, 1); assert.equal(result.coverage.sampled, true);
  assert.equal(result.coverage.truncated, true); assert.match(result.text, /范围|记录可能不完整/);
});

test("long task text remains available but coverage projection never spreads raw metadata", async () => {
  const f = fixture({ sendGroupSummaryForDate: async () => ({ ok: true, summary: "word ".repeat(700), sent: false, dryRun: true,
    privacyEpoch: 0, provider: "private/path/key", outputFile: undefined,
    coverage: { source: "private/path", uid: USER, keys: "secret", captured: 3 } }) });
  const result = await f.create().generate({ kind: "daily" });
  assert.ok(result.text.length > 2000); assert.equal(result.provider, "unknown");
  assert.doesNotMatch(JSON.stringify(result.coverage), /private|uid|keys|secret/);
});

test("real existing dryRun service performs no report, privacy, delivery, or profile writes", async () => {
  let sends = 0; let collected;
  const f = fixture();
  const capture = { privacyEpoch: 0, coverage: { source: "provided", captured: 1, complete: false },
    messages: [{ uid: USER, nickname: "Member", text: "The cable is still broken.", messageId: "one", ts: NOW - 1000 }] };
  f.options.sendGroupSummaryForDate = async options => {
    collected = options;
    return await sendGroupSummaryForDate({ ...options, capture,
      sendGroupMessage: () => { sends++; assert.fail("sending forbidden"); },
      beforeSave: () => assert.fail("revision save forbidden") });
  };
  const before = snapshot(f.root);
  const result = await f.create().generate({ kind: "daily", day: "today" });
  assert.equal(result.ok, true); assert.equal(collected.dryRun, true); assert.equal(collected.groupId, GROUP);
  assert.deepEqual(collected.groupWhitelist, [GROUP]); assert.equal(collected.requireWhitelisted, true);
  assert.equal(sends, 0); assert.deepEqual(snapshot(f.root), before); assert.equal(f.calls.length, 0);
});

test("draft-only evidence budget reaches real daily dryRun and reports sampling and clipping", async () => {
  const f = fixture({ evidenceBudgetChars: 60000 });
  const messages = Array.from({ length: 40 }, (_item, i) => ({ uid: USER, nickname: "Member", messageId: "evidence-" + i,
    text: "Discussion " + i + ": " + "The screen still goes black after replacing the cable. ".repeat(30), ts: start + i * 60000 }));
  let generated;
  f.options.sendGroupSummaryForDate = async options => {
    assert.equal(options.dryRun, true); assert.equal(options.evidenceBudgetChars, 8192);
    assert.equal(options.targetBudget, 6500); assert.equal(options.backgroundBudget, 1500);
    generated = await sendGroupSummaryForDate({ ...options,
      capture: { messages, privacyEpoch: 0, coverage: { source: "provided", captured: messages.length, truncated: 0 } },
      beforeSave: () => assert.fail("draft revision save forbidden"), sendGroupMessage: () => assert.fail("draft send forbidden") });
    return generated;
  };
  f.options.callModel = async (...args) => {
    f.calls.push(args); const requestValue = args[2];
    const prompt = requestValue.messages[0].content;
    const match = prompt.match(/^(D\d+)\n(E\d+) /m);
    assert.ok(match); assert.ok(prompt.length + requestValue.systemPrompt.length < 24000);
    return raw(JSON.stringify({ headline: "", topics: [{ id: match[1], evidenceIds: [match[2]],
      title: "Cable discussion", body: "Members discussed the screen going black after replacing the cable.", status: "chat" }] }));
  };
  const before = snapshot(f.root);
  const result = await f.create().generate({ kind: "daily", day: "today" });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  const selection = generated.bundle.selection;
  assert.equal(selection.budget, 8192); assert.ok(selection.chars <= 8192);
  assert.equal(selection.sampled, true); assert.ok(selection.truncated > 0);
  assert.equal(result.coverage.sampled, true); assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.evidenceTruncated, selection.truncated); assert.equal(result.coverage.capturedTruncated, 0);
  assert.equal(result.coverage.evidenceSelected, selection.included); assert.equal(result.coverage.evidenceAvailable, selection.total);
  assert.deepEqual(snapshot(f.root), before);
  const unchangedDefault = buildDiscussionBundle(messages);
  assert.equal(unchangedDefault.selection.budget, 36000); assert.ok(unchangedDefault.selection.included > selection.included);
});

test("draft-only target and background budgets reach real group selection and existing pure generation", async () => {
  const f = fixture({ targetBudget: 60000, backgroundBudget: 60000, generateConversationSummary });
  const records = Array.from({ length: 24 }, (_item, i) => [
    { uid: USER, nickname: "Target", messageId: "target-" + i, ts: start + i * 2000,
      text: "Target evidence " + i + ": " + "screen cable ".repeat(70) },
    { uid: OTHER, nickname: "Background", messageId: "context-" + i, replyToMessageId: "target-" + i, ts: start + i * 2000 + 500,
      text: "Background evidence " + i + ": " + "context ".repeat(60) },
  ]).flat();
  fs.writeFileSync(f.cfg.chatLogFile, JSON.stringify({ [GROUP]: records }));
  let selected;
  f.options.selectSummaryRecords = (group, targets, range, options) => {
    assert.equal(options.evidenceBudgetChars, 8192); assert.equal(options.targetBudget, 6500); assert.equal(options.backgroundBudget, 1500);
    selected = selectSummaryRecords(group, targets, range, options); return selected;
  };
  const before = snapshot(f.root);
  const result = await f.create().generate({ kind: "conversation", day: "today" });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  const cost = item => JSON.stringify(item.text).length + 200;
  assert.ok(selected.selected > 0); assert.ok(selected.background > 0);
  assert.ok(selected.transcript.filter(item => item.target).reduce((sum, item) => sum + cost(item), 0) <= 6500);
  assert.ok(selected.transcript.filter(item => !item.target).reduce((sum, item) => sum + cost(item), 0) <= 1500);
  assert.equal(selected.sampled, true); assert.equal(selected.truncated, true);
  assert.equal(result.coverage.sampled, true); assert.equal(result.coverage.truncated, true); assert.equal(result.coverage.partial, true);
  assert.ok(f.calls[0][2].systemPrompt.length + f.calls[0][2].messages[0].content.length < 24000);
  assert.deepEqual(snapshot(f.root), before);
  const unchangedDefault = selectSummaryRecords(GROUP, [{ uid: USER }], selected.range, {
    root: path.join(f.root, ".qqfriend", "summaries"), chatLogFile: f.cfg.chatLogFile, selfUin: BOT,
  });
  assert.ok(unchangedDefault.selected > selected.selected); assert.ok(unchangedDefault.background > selected.background);
});

test("real selector uses this group, excludes request, stale, foreign and forgotten records", async () => {
  const f = fixture();
  const root = path.join(f.root, ".qqfriend", "summaries"); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "privacy.json"), JSON.stringify({ epoch: 0, users: { [OTHER]: NOW } }));
  const record = (text, messageId, extra = {}) => ({ uid: USER, nickname: "Member", ts: NOW - 1000, text, messageId, ...extra });
  const records = [record("keep scoped evidence", "keep", { groupId: GROUP }), record("wrong group", "wrong", { groupId: "51002" }),
    record("exclude current request", "70001"), record("stale", "old", { ts: start - 8 * 86400000 }), record("forgotten", "forgot", { uid: OTHER })];
  let bundle;
  f.options.selectSummaryRecords = (group, targets, range, options) => {
    bundle = selectSummaryRecords(group, targets, range, { ...options, records }); return bundle;
  };
  f.options.generateConversationSummary = generateConversationSummary;
  const before = snapshot(f.root);
  const result = await f.create().generate({ kind: "conversation", day: "today" });
  assert.equal(result.ok, true); assert.deepEqual(bundle.transcript.map(item => item.text), ["keep scoped evidence"]);
  assert.equal(f.calls[0][0], "conversation_summary"); assert.deepEqual(snapshot(f.root), before);
});

test("default material reading cannot mix another group or private bucket into group records", async () => {
  const f = fixture({ selectSummaryRecords: undefined, generateConversationSummary });
  const row = text => ({ uid: USER, nickname: "Member", ts: NOW - 1000, messageId: text, text });
  fs.writeFileSync(f.cfg.chatLogFile, JSON.stringify({
    [GROUP]: [row("Current group has a concrete discussion about the broken cable.")],
    "51002": [row("FOREIGN_GROUP_SECRET")], private: [row("PRIVATE_BUCKET_SECRET")],
  }));
  const before = snapshot(f.root);
  const result = await f.create().generate({ kind: "conversation", day: "today" });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  const prompt = JSON.stringify(f.calls[0][2].messages);
  assert.match(prompt, /Current group/); assert.doesNotMatch(prompt, /FOREIGN_GROUP_SECRET|PRIVATE_BUCKET_SECRET/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a blacklisted requester is denied before collection and revocation is rechecked", async () => {
  const f = fixture(); f.cfg.botBlacklist = [USER];
  denied(await f.create().generate({ kind: "daily" }), "not_allowed"); assert.equal(f.calls.length, 0);
  f.cfg.botBlacklist = [];
  f.options.callModel = async () => { f.cfg.botBlacklist.push(USER); return raw("must discard"); };
  denied(await f.create().generate({ kind: "daily" }), "permission_changed");
});

test("real conversation primary and fallback keep existing prompts, reasoning and tighter budget hooks", async () => {
  const f = fixture({ generateConversationSummary });
  let hooks = 0;
  f.options.callModel = async (task, position, value, providerOptions) => {
    f.calls.push([task, position, value, providerOptions]);
    assert.equal(value.beforeAttempt(), ""); hooks++;
    value.validatePrepared(value);
    return position === "primary" ? { ok: false, error: "unavailable" } : raw("Fallback draft");
  };
  const result = await f.create().generate({ kind: "conversation" });
  assert.equal(result.ok, true); assert.equal(result.position, "fallback"); assert.equal(hooks, 2);
  assert.deepEqual(f.calls.map(call => call[1]), ["primary", "fallback"]);
  assert.deepEqual(f.calls.map(call => call[3]), [{}, { reasoningMode: "economy" }]);
  assert.equal(f.calls[0][2].promptMetadata.promptVersion, "conversation-summary-v1");
  assert.match(f.calls[0][2].systemPrompt, /只输出总结正文/);
});

test("real daily primary and fallback route through the same injected parent callback", async () => {
  const f = fixture();
  const message = (evidenceId, text, offset) => ({ uid: USER, nickname: "Member", evidenceId, text, ts: start + offset });
  const messages = [message("E0390", "Meet at the cafeteria?", 0), message("E0406", "I will head down.", 60000)];
  const bundle = { discussions: [{ id: "D196", messages, messageCount: 2 }],
    stats: { effectiveMessageCount: 9, messageCount: 9, speakerCount: 2 } };
  f.options.sendGroupSummaryForDate = options => sendGroupSummaryForDate({ ...options, messages, bundle, lowMessageLimit: 0 });
  f.options.callModel = async (...args) => {
    f.calls.push(args); const [, position, value] = args;
    assert.equal(value.maxTokens, 1536); assert.equal(value.beforeAttempt(), ""); value.validatePrepared(value);
    return position === "primary" ? { ok: false, error: "unavailable" } : raw(JSON.stringify({ headline: "", topics: [
      { id: "D196", title: "Cafeteria plan", body: "Members planned to meet at the cafeteria.", status: "chat", evidenceIds: ["E0390", "E0406"] },
    ] }));
  };
  const before = snapshot(f.root); const result = await f.create().generate({ kind: "daily" });
  assert.equal(result.ok, true); assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [["group_summary", "primary"], ["group_summary", "fallback"]]);
  assert.deepEqual(f.calls.map(call => call[3]), [{ reasoningMode: undefined }, { reasoningMode: "economy" }]);
  assert.equal(f.calls[0][2].promptMetadata.promptVersion, "group-summary-structured-v2");
  assert.deepEqual(snapshot(f.root), before);
});

test("business swallowing errors cannot reset shared parent model or HTTP budgets", async () => {
  let rounds = 2; let attempts = 6;
  const parent = async (_task, _position, value) => {
    if (rounds >= 4 || attempts >= 8) throw new Error("tool_budget");
    rounds++; attempts += 2; assert.equal(value.maxTokens, 1536);
    return { ok: false, error: "unavailable" };
  };
  const f = fixture({ callModel: parent, generateConversationSummary });
  denied(await f.create().generate({ kind: "conversation" }), "budget_exceeded");
  assert.equal(rounds, 3); assert.equal(attempts, 8);
  const g = fixture({ callModel: parent });
  denied(await g.create().generate({ kind: "daily" }), "budget_exceeded");
  assert.equal(rounds, 3); assert.equal(attempts, 8);
});

test("the fourth shared model round is final even when business requests a fallback", async () => {
  let rounds = 3;
  const f = fixture({ generateConversationSummary, callModel: async () => {
    if (rounds >= 4) throw new Error("tool_budget");
    rounds++; return { ok: false, error: "unavailable" };
  } });
  denied(await f.create().generate({ kind: "conversation" }), "budget_exceeded"); assert.equal(rounds, 4);
});

test("a parent deadline or privacy denial is latched across existing fallback handling", async () => {
  for (const [code, reason] of [["tool_deadline", "budget_exceeded"], ["privacy_changed", "privacy_changed"],
    ["reply_superseded", "stale_request"], ["task_cancelled", "cancelled"]]) {
    const f = fixture({ generateConversationSummary, callModel: () => { throw new Error(code); } });
    denied(await f.create().generate({ kind: "conversation" }), reason);
  }
});

test("latched denial prevents a swallowed primary error from running fallback or returning a local result", async () => {
  const f = fixture({ callModel: () => { throw new Error("tool_budget"); } });
  let fallback = 0;
  f.options.sendGroupSummaryForDate = async options => {
    try { await options.callPrimarySummary("prompt", request(options.signal)); } catch { /* Simulate legacy swallowing. */ }
    try { await options.callFallbackSummary("prompt", request(options.signal)); fallback++; } catch { /* Must remain stopped. */ }
    return { ok: true, summary: "unsafe local fallback", sent: false, dryRun: true, privacyEpoch: 0 };
  };
  denied(await f.create().generate({ kind: "daily" }), "budget_exceeded"); assert.equal(fallback, 0);
});

test("every HTTP reservation and prepared-request validation rechecks independent business access", async () => {
  const f = fixture(); let prior = 0;
  f.options.sendGroupSummaryForDate = async options => {
    await options.callPrimarySummary("prompt", { ...request(options.signal), beforeAttempt: () => { prior++; return ""; } });
  };
  f.options.callModel = async (_task, _position, value) => {
    assert.equal(value.beforeAttempt(), "");
    f.cfg.summaryGroupWhitelist = [];
    assert.throws(() => value.beforeAttempt(), /permission_changed/);
    assert.throws(() => value.validatePrepared(value), /permission_changed/);
    return raw("rejected late result");
  };
  denied(await f.create().generate({ kind: "daily" }), "permission_changed"); assert.equal(prior, 1);
});

test("text projection hides canonical five-digit and long IDs, paths, URLs and secrets", async () => {
  const f = fixture({ sendGroupSummaryForDate: async () => ({ ok: true,
    summary: "61001 12345678901234567890 C:\\private\\file /private/state/file https://private.example sk-abcdefghijklmnop",
    sent: false, dryRun: true, privacyEpoch: 0 }) });
  const result = await f.create().generate({ kind: "daily" });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, /61001|12345678901234567890|private|sk-abcdefghijklmnop/);
});

test("provider metadata cannot smuggle numeric identity or a credential", async () => {
  for (const provider of [USER, "sk-abcdefghijklmnop"]) {
    const f = fixture({ sendGroupSummaryForDate: async () => ({ ok: true, summary: "Draft", provider,
      sent: false, dryRun: true, privacyEpoch: 0 }) });
    assert.equal((await f.create().generate({ kind: "daily" })).provider, "unknown");
  }
});

for (const kind of ["daily", "conversation"]) {
  test(kind + " permanently redacts standalone Basic credentials after NFKC and Cf normalization", async () => {
    const f = fixture();
    const credential = "c3ludGhldGljOnNlY3JldA==";
    const basic = "Basic " + credential;
    const fullwidth = basic.replace(/[!-~]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
    const payload = ["Readable draft.", basic, "bAsIc " + credential,
      "Ba\u200bsic c3lu\u2060dGhldGljOnNlY3JldA==", fullwidth, "Basic YTpi", "Finished."].join("\n");
    stubBusiness(f, kind, () => businessResult(kind, payload));
    const result = await f.create().generate({ kind });
    assert.equal(result.ok, true); assert.match(result.text, /Readable draft/); assert.match(result.text, /Finished/);
    assert.doesNotMatch(JSON.stringify(result), /c3ludGhldGljOnNlY3JldA|YTpi|\p{Cf}/u);
    assert.equal((result.text.match(/Basic \[credentials hidden\]/g) || []).length, 5);
  });

  test(kind + " normalizes NFKC and format controls before complete credential redaction", async () => {
    const f = fixture();
    const text = ["Readable draft.", "api_\u200bkey=SYNTHETIC_ZERO_SECRET", "ａｐｉ＿ｋｅｙ=SYNTHETIC_FULLWIDTH_SECRET",
      "a\u2060pi_key='SYNTHETIC_QUOTED_SECRET tail-credential'",
      "authorization=Basic SYNTHETIC_BASIC_SECRET tail-credential",
      "Authorization: Bearer SYNTHETIC_BEARER_SECRET tail-credential",
      "\"Authorization\": \"Digest SYNTHETIC_DIGEST_SECRET tail-credential\"",
      "ａｕｔｈｏｒｉｚａｔｉｏｎ=Ｂａｓｉｃ SYNTHETIC_FULLWIDTH_AUTH tail-credential",
      "Proxy-Authorization=Basic SYNTHETIC_PROXY_SECRET tail-credential", "Ｆｉｎｉｓｈｅｄ."].join("\n");
    stubBusiness(f, kind, () => businessResult(kind, text));
    const result = await f.create().generate({ kind });
    assert.equal(result.ok, true); assert.match(result.text, /Readable draft/); assert.match(result.text, /Finished/);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|tail-credential|\p{Cf}/u);
  });

  for (const hook of ["beforeAttempt", "validatePrepared"]) {
    test(kind + " latches " + hook + " budget exceptions even when parent converts them to unavailable", async () => {
      const f = fixture(); let caught = 0;
      f.options.callModel = async (...args) => {
        f.calls.push(args);
        try { args[2][hook](args[2]); }
        catch { caught++; return { ok: false, error: "unavailable" }; }
        return raw("Should never reach a fallback model");
      };
      stubBusiness(f, kind, async options => {
        const value = { ...request(options.signal), [hook]: () => { throw new Error("task_input_budget"); } };
        try { await modelEntry(kind, options)(value); } catch { /* Legacy service swallows the primary failure. */ }
        try {
          if (kind === "daily") await options.callFallbackSummary("prompt", request(options.signal));
          else await options.callProvider("conversation_summary", "fallback", request(options.signal), { reasoningMode: "economy" });
        } catch { /* A local fallback must not bypass the latched error either. */ }
        return businessResult(kind, "Unsafe successful local fallback");
      });
      denied(await f.create().generate({ kind }), "budget_exceeded");
      assert.equal(caught, 1); assert.equal(f.calls.length, 1);
    });
  }

  test(kind + " real business validation rejection cannot be downgraded into fallback success", async () => {
    const f = fixture({ generateConversationSummary });
    if (kind === "daily") f.options.sendGroupSummaryForDate = options => sendGroupSummaryForDate({ ...options, lowMessageLimit: 0,
      messages: [{ uid: USER, nickname: "Member", messageId: "evidence", text: "The cable still leaves the screen black.", ts: NOW - 1000 }] });
    f.options.callModel = async (...args) => {
      f.calls.push(args); const [, position, value] = args;
      if (position === "fallback") return raw(kind === "daily" ? JSON.stringify({ headline: "", topics: [{ id: "D001", evidenceIds: ["E0001"],
        title: "Cable", body: "The screen still goes black.", status: "open" }] }) : "A fallback success");
      try { value.validatePrepared({ ...value, messages: [{ role: "user", content: "x".repeat(200000) }] }); }
      catch { return { ok: false, error: "unavailable" }; }
      return raw("Should not validate");
    };
    denied(await f.create().generate({ kind }), "budget_exceeded"); assert.equal(f.calls.length, 1);
  });

  for (const successful of [true, false]) {
    test(kind + " closes a retained model callback after " + (successful ? "success" : "failure"), async () => {
      const f = fixture(); let retained;
      stubBusiness(f, kind, options => {
        retained = modelEntry(kind, options);
        return successful ? businessResult(kind) : { ok: false, error: "generation_failed", reason: "model_unavailable" };
      });
      const result = await f.create().generate({ kind });
      assert.equal(result.ok, successful);
      assert.equal(f.calls.length, 0);
      await assert.rejects(retained(request(f.control.signal)), /stale_request/);
      assert.equal(f.calls.length, 0);
    });

    test(kind + " closes admission but drains a real in-flight parent call after business " + (successful ? "success" : "failure"), async () => {
      const gate = deferred(); const entered = deferred(); const f = fixture(); let retained; let settled = false;
      f.options.callModel = async (...args) => { f.calls.push(args); entered.resolve(); return await gate.promise; };
      stubBusiness(f, kind, async options => {
        retained = modelEntry(kind, options);
        retained(request(options.signal)).catch(() => {});
        await entered.promise;
        if (!successful) throw new Error("synthetic business failure");
        return businessResult(kind);
      });
      const run = f.create().generate({ kind }).then(value => { settled = true; return value; });
      await entered.promise; await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.equal(f.calls.length, 1);
      await assert.rejects(retained(request(f.control.signal)), /stale_request/);
      assert.equal(f.calls.length, 1);
      gate.resolve(raw("late actual parent completion"));
      const result = await run;
      assert.equal(result.ok, successful);
      if (!successful) denied(result, "business_unavailable");
      await assert.rejects(retained(request(f.control.signal)), /stale_request/);
      assert.equal(f.calls.length, 1);
    });
  }
}

test("factory mention authorization is an immutable upper bound while removals remain effective", async () => {
  const changes = [f => f.options.mentionTargets.push("61003"), f => f.options.mentionTargets.push({ uid: "61003" }),
    f => { f.options.mentionTargets = [OTHER, "61003"]; }];
  for (const change of changes) {
    const f = fixture(); const adapter = f.create(); change(f);
    denied(await adapter.generate({ kind: "conversation", targets: "61003" }), "target_not_allowed");
    assert.equal(f.calls.length, 0);
    assert.equal((await adapter.generate({ kind: "conversation", targets: OTHER })).ok, true);
  }
  const f = fixture({ mentionTargets: [{ uid: OTHER }] }); const adapter = f.create();
  f.options.mentionTargets[0].uid = "61003";
  denied(await adapter.generate({ kind: "conversation", targets: "61003" }), "target_not_allowed");
  denied(await adapter.generate({ kind: "conversation", targets: OTHER }), "target_not_allowed");
  assert.equal(f.calls.length, 0);
});

test("all tests remained offline", () => { assert.equal(networkCalls, 0); });
