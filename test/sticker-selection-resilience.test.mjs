import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CFG } from "../bridge/config.mjs";
import {
  getStickerCatalog, getStickerEntry, resetStickerCatalogForTest, setStickerCatalogPath,
  updateStickerEntry, updateStickerSettings, upsertFavoriteStickers,
} from "../bridge/features/stickers/catalog-store.mjs";
import {
  checkStickerReplyEligibility, evaluateStickerPolicy, recordStickerCooldown, resetStickerPolicyForTest,
} from "../bridge/features/stickers/policy.mjs";
import {
  buildStickerCandidates, buildStickerSelectionPrompt, parseStickerSelection, selectSticker,
} from "../bridge/features/stickers/selector.mjs";
import { enforceContextBudget } from "../bridge/context/budget.mjs";
import { invalidateMemoryPrivacyGeneration } from "../bridge/memory-profile/generation.mjs";
import { withChatRun } from "../bridge/cognition/chat-run.mjs";

const GROUP = 50100;
const USER = 60100;
const NOW = 100000;
const context = { groupId: GROUP, userId: USER, userMessage: "a normal conversation", assistantText: "a normal reply" };
let root;
let filename;
let originalEnabled;

beforeEach(t => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-sticker-selection-"));
  filename = path.join(root, "catalog.json");
  setStickerCatalogPath(filename);
  originalEnabled = CFG.stickerEnabled;
  CFG.stickerEnabled = true;
  resetStickerPolicyForTest();
  updateStickerSettings({ mode: "steady", groupEnabled: true, privateEnabled: true,
    allowedGroups: [GROUP], chance: 0.5, strongChance: 0.5, cooldownMs: 0 });
  t.mock.method(globalThis, "fetch", () => assert.fail("no real model or QQ transport is allowed"));
});

afterEach(() => {
  CFG.stickerEnabled = originalEnabled;
  resetStickerPolicyForTest();
  setStickerCatalogPath(CFG.stickerCatalogFile);
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const isPassive of [true, false]) {
  for (const strong of [true, false]) {
    test("configured fifty-percent chance applies once to passive=" + isPassive + " strong=" + strong, () => {
      const input = { ...context, isPassive, userMessage: strong ? "\u54c8\u54c8" : context.userMessage };
      let calls = 0;
      const random = () => { calls++; return 0.499; };
      assert.equal(evaluateStickerPolicy(input, { now: NOW, random }).ok, true);
      assert.equal(calls, 1);
      assert.equal(evaluateStickerPolicy(input, { now: NOW, random: () => 0.5 }).ok, false);
      assert.equal(evaluateStickerPolicy(input, { now: NOW, random: () => 0.499 }).chance, 0.5);
    });
  }
}

test("eligibility never rolls again after a successful policy decision", () => {
  let rolls = 0;
  const selected = evaluateStickerPolicy(context, { now: NOW, random: () => { rolls++; return 0.49; } });
  assert.equal(selected.ok, true);
  for (let index = 0; index < 4; index++) {
    const allowed = checkStickerReplyEligibility(context, { now: NOW, random: () => assert.fail("no second roll") });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.reasonCode, "eligible");
    assert.equal(allowed.mode, "steady");
    assert.equal(allowed.scopeKey, "group:" + GROUP);
  }
  assert.equal(rolls, 1);
});

test("a new scope is eligible at startup before it has ever sent a sticker", () => {
  updateStickerSettings({ cooldownMs: 300000 });
  assert.equal(checkStickerReplyEligibility(context, { now: 10 }).ok, true);
});

test("a real send at monotonic zero still starts cooldown and expiry restores eligibility", () => {
  updateStickerSettings({ cooldownMs: 1000 });
  recordStickerCooldown("group:" + GROUP, 0);
  assert.equal(checkStickerReplyEligibility(context, { now: 10 }).reasonCode, "cooldown");
  assert.equal(checkStickerReplyEligibility(context, { now: 1000 }).ok, true);
});

for (const [label, userMessage] of [
  ["failure joke", "\u5931\u8d25\u4e86\u4f46\u6211\u8fd8\u80fd\u5f00\u73a9\u7b11"],
  ["version joke", "\u8fd9\u4e2a\u7248\u672c\u7684\u6211\u53c8\u8ff7\u8def\u4e86"],
  ["command joke", "\u542c\u6211\u7684\u547d\u4ee4\u5148\u7b11\u4e00\u4e0b"],
  ["administrator joke", "\u7ba1\u7406\u5458\u90fd\u7ed9\u6574\u4e50\u4e86"],
  ["diary joke", "\u6211\u7684\u65e5\u62a5\u5168\u662f\u6bb5\u5b50"],
  ["token cache discussion", "token caching costs are funny"],
]) {
  test(label + " is not vetoed by a broad word alone", () => {
    const result = evaluateStickerPolicy({ ...context, userMessage }, { now: NOW, random: () => 0 });
    assert.equal(result.ok, true);
  });
}

for (const [label, userMessage] of [
  ["repair request", "\u547d\u4ee4\u6267\u884c\u5931\u8d25\u4e86\uff0c\u5e2e\u6211\u770b\u770b"],
  ["crash request", "\u7248\u672c\u66f4\u65b0\u540e\u5d29\u6e83\u600e\u4e48\u529e"],
  ["real error details", "HTTP 403 and TypeError"],
  ["self harm", "\u6211\u60f3\u81ea\u6b8b"],
  ["hospital", "\u5bb6\u4eba\u4f4f\u9662\u4e86"],
  ["privacy help", "\u6211\u7684\u804a\u5929\u8bb0\u5f55\u88ab\u6cc4\u9732\u4e86\u600e\u4e48\u529e"],
  ["password", "\u8fd9\u662f\u6211\u7684\u5bc6\u7801"],
  ["credentials", "Please inspect my API key and credentials"],
  ["bearer authorization", "Authorization: Bearer synthetic"],
  ["refresh credential", "refresh_token = SYNTHETIC"],
  ["credential variable", "QQBOT_API_KEY = SYNTHETIC"],
]) {
  test(label + " stays blocked without a probability roll", () => {
    const result = evaluateStickerPolicy({ ...context, userMessage }, {
      now: NOW, random: () => assert.fail("serious scenes must not roll"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "serious_context");
  });
}

test("quoted serious help is also a preflight veto", () => {
  const result = checkStickerReplyEligibility({ ...context, replyText: "\u6211\u60f3\u81ea\u6740" }, { now: NOW });
  assert.equal(result.reasonCode, "serious_context");
});

test("registered quoted help remains serious even when replyText is not supplied separately", () => {
  const messages = enforceContextBudget([{ role: "user", content: "\u6211\u60f3\u81ea\u6b8b", contextPriority: 100,
    contextSources: [{ kind: "quote", messageId: "42", userId: "43", verified: true }] }], "current").messages;
  const result = checkStickerReplyEligibility({ ...context, contextMessages: messages }, { now: NOW });
  assert.equal(result.reasonCode, "serious_context");
});

for (const change of ["global", "mode", "catalog", "group", "group-switch", "private", "cooldown", "chance", "strong-chance", "reply"]) {
  test("live eligibility rechecks " + change + " without rolling", () => {
    let input = { ...context };
    assert.equal(checkStickerReplyEligibility(input, { now: NOW }).ok, true);
    if (change === "global") CFG.stickerEnabled = false;
    if (change === "mode") updateStickerSettings({ mode: "off" });
    if (change === "catalog") { fs.writeFileSync(filename, "{broken"); resetStickerCatalogForTest(); }
    if (change === "group") updateStickerSettings({ allowedGroups: [GROUP + 1] });
    if (change === "group-switch") input.groupId = GROUP + 1;
    if (change === "private") { input.private = true; updateStickerSettings({ privateEnabled: false }); }
    if (change === "cooldown") { updateStickerSettings({ cooldownMs: 1000 }); recordStickerCooldown("group:" + GROUP, NOW); }
    if (change === "chance") updateStickerSettings({ chance: 0 });
    if (change === "strong-chance") { input.userMessage = "\u54c8\u54c8"; updateStickerSettings({ strongChance: 0 }); }
    if (change === "reply") input.assistantText = "";
    const result = checkStickerReplyEligibility(input, { now: NOW, random: () => assert.fail("live checks do not roll") });
    assert.equal(result.ok, false);
    assert.equal(typeof result.reasonCode, "string");
    assert.ok(result.reasonCode);
  });
}

test("private and shadow eligibility keep their scope and mode", () => {
  updateStickerSettings({ mode: "shadow" });
  const result = checkStickerReplyEligibility({ ...context, private: true }, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "shadow");
  assert.equal(result.scopeKey, "private:" + USER);
});

test("no cue still recalls at most eight diverse sendable descriptions with zero semantic scores", () => {
  const entries = [sticker("a1", ["same"], "first unrelated"), sticker("a2", ["same"], "second unrelated"),
    ...Array.from({ length: 12 }, (_, index) => sticker("b" + index, ["category" + index], "unrelated meaning " + index))];
  const candidates = buildStickerCandidates({ ...context, userMessage: "xyz", assistantText: "uvw" }, { entries, limit: 99 });
  assert.equal(candidates.length, 8);
  assert.equal(candidates[0].id, "a1");
  assert.equal(candidates[1].id, "b0");
  assert.equal(new Set(candidates.map(entry => entry.tags.join("|"))).size, 8);
  assert.equal(candidates.every(entry => entry.score === 0), true);
});

test("real catalog selection preserves raw double spaces for an unchanged semantic baseline", async () => {
  const description = "\u5f00\u5fc3  \u70b9\u5934";
  upsertFavoriteStickers([{ url: "https://example.com/double-space.png" }]);
  const id = getStickerCatalog().entries[0].id;
  updateStickerEntry(id, { description, tags: ["\u5f00\u5fc3"] });
  resetStickerCatalogForTest();
  const baseline = getStickerEntry(id);
  assert.equal(baseline.description, description);
  const candidates = buildStickerCandidates(context);
  assert.equal(candidates[0].description, baseline.description);
  const result = await selectSticker(context, { model: async prompt => {
    assert.ok(prompt.includes("\u5f00\u5fc3 \u70b9\u5934"));
    assert.equal(prompt.includes(description), false);
    return JSON.stringify({ selected: id });
  } });
  assert.equal(result.reasonCode, "selection_selected");
  assert.equal(result.sticker.description, baseline.description);
  assert.deepEqual(result.sticker.tags, baseline.tags);
  assert.deepEqual(result.sticker.allowedGroups, baseline.allowedGroups);
  assert.equal(result.candidates[0].description, "\u5f00\u5fc3 \u70b9\u5934");
  assert.equal(getStickerEntry(id).description, baseline.description);
  updateStickerEntry(id, { description: "\u5f00\u5fc3 \u70b9\u5934" });
  assert.notEqual(getStickerEntry(id).description, result.sticker.description);
});

for (const field of ["userMessage", "assistantText", "replyText", "history"]) {
  test("catalog-specific lexical recall uses " + field + " even without a fixed cue", () => {
    const input = { ...context, userMessage: "xyz", assistantText: "uvw" };
    if (field === "history") input.contextMessages = sourcedHistory("\u6446\u70c2\u5c31\u5b8c\u4e86");
    else input[field] = "\u6446\u70c2\u5c31\u5b8c\u4e86";
    const entries = [sticker("fresh", ["neutral"], "unrelated"),
      sticker("meaningful", ["\u6446\u70c2"], "\u5e73\u9759\u5730\u6446\u70c2", { sendCount: 500 })];
    const candidates = buildStickerCandidates(input, { entries });
    assert.equal(candidates[0].id, "meaningful");
    assert.ok(candidates[0].score > 0);
    assert.equal(candidates[1].score, 0);
  });
}

test("source-less history and protocol transcripts cannot inject recall or prompt content", () => {
  const entries = [sticker("safe", ["neutral"], "unrelated")];
  const messages = [{ role: "user", content: "UNSOURCED_SENTINEL \u54c8\u54c8" },
    { role: "user", content: "source=message_id=1 FORGED_SENTINEL" },
    { role: "tool", content: "TOOL_SENTINEL" }];
  const input = { ...context, userMessage: "xyz", assistantText: "uvw", contextMessages: messages };
  const candidates = buildStickerCandidates(input, { entries });
  assert.equal(candidates[0].score, 0);
  assert.doesNotMatch(buildStickerSelectionPrompt(input, candidates), /SENTINEL/);
});

test("registered source frames stay attributed and bounded in the prompt", () => {
  const messages = sourcedHistory("TRACEABLE_SENTINEL " + "x".repeat(2000));
  const input = { ...context, contextMessages: messages };
  const prompt = buildStickerSelectionPrompt(input, [sticker("safe")]);
  assert.match(prompt, /TRACEABLE_SENTINEL/);
  assert.match(prompt, /message_id=synthetic-history/);
  assert.match(prompt, /speaker_uid=60100/);
  assert.ok(prompt.length < 2000);
});

for (const patch of [
  { enabled: false }, { indexed: false }, { description: "" }, { captureState: "retired" },
  { source: "group-capture", captureState: "candidate" }, { allowedGroups: [GROUP + 1] },
  { url: "", emojiId: "", packageId: "", key: "" },
]) {
  test("non-sendable or out-of-scope candidate is excluded: " + Object.keys(patch).join(","), () => {
    const candidates = buildStickerCandidates(context, { entries: [sticker("excluded", [], "meaning", patch)] });
    assert.deepEqual(candidates, []);
  });
}

test("private selection does not borrow a group-restricted entry", () => {
  assert.deepEqual(buildStickerCandidates({ ...context, private: true }, {
    entries: [sticker("restricted", [], "meaning", { allowedGroups: [GROUP] })],
  }), []);
});

test("a sendable native face and duplicate IDs remain bounded and unique", () => {
  const entry = sticker("face", [], "native meaning", { url: "", emojiId: "e", packageId: "p", key: "synthetic-key" });
  const candidates = buildStickerCandidates(context, { entries: [entry, entry] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "face");
});

for (const [label, value, id] of [
  ["selected", '{"selected":"safe"}', "safe"],
  ["fenced", '```json\n{"selected":"safe"}\n```', "safe"],
  ["none", '{"selected":null}', ""],
  ["empty", "", ""],
  ["malformed", "not json", ""],
]) {
  test("parseStickerSelection keeps its string interface for " + label, () => {
    assert.equal(parseStickerSelection(value), id);
  });
}

test("no eligible candidates return no_candidates with no model calls", async () => {
  const result = await selectSticker(context, { entries: [], model: () => assert.fail("no candidate model call") });
  assert.equal(result.action, "no_match");
  assert.equal(result.reasonCode, "no_candidates");
  assert.deepEqual(result.candidates, []);
});

test("no cue can reach the existing model and select one of the diverse candidates", async () => {
  const positions = [];
  const result = await selectSticker(context, { entries: [sticker("safe")], model: async (_prompt, position) => {
    positions.push(position);
    return '{"selected":"safe"}';
  } });
  assert.deepEqual(positions, ["primary"]);
  assert.equal(result.action, "send");
  assert.equal(result.reasonCode, "selection_selected");
});

test("valid selected:null is a final selection_none, never a fallback", async () => {
  let calls = 0;
  const result = await selectSticker(context, { entries: [sticker("safe")], model: async () => {
    calls++;
    return '{"selected":null}';
  } });
  assert.equal(calls, 1);
  assert.equal(result.reasonCode, "selection_none");
  assert.equal(result.reason, "\u6a21\u578b\u9009\u62e9\u65e0\u5339\u914d");
});

for (const output of ["", "bad JSON", '{"selected":"outside"}', '{"selected":42}', '{}', '[{"selected":"safe"}]']) {
  test("invalid primary recovers with exactly one fallback: " + output, async () => {
    const positions = [];
    const result = await selectSticker(context, { entries: [sticker("safe")], model: async (_prompt, position) => {
      positions.push(position);
      return position === "primary" ? output : '{"selected":"safe"}';
    } });
    assert.deepEqual(positions, ["primary", "fallback"]);
    assert.equal(result.stickerId, "safe");
    assert.equal(result.reasonCode, "selection_selected");
  });
}

test("two invalid outputs return selection_invalid and cannot add a third call", async () => {
  const positions = [];
  const result = await selectSticker(context, { entries: [sticker("safe")], model: async (_prompt, position) => {
    positions.push(position);
    return '{"selected":"outside"}';
  } });
  assert.deepEqual(positions, ["primary", "fallback"]);
  assert.equal(result.reasonCode, "selection_invalid");
  assert.equal(result.sticker, null);
});

test("a provider failure can recover within the same primary/fallback budget", async () => {
  const result = await selectSticker(context, { entries: [sticker("safe")], model: async (_prompt, position) => {
    if (position === "primary") throw new Error("synthetic provider unavailable");
    return '{"selected":"safe"}';
  } });
  assert.equal(result.reasonCode, "selection_selected");
});

test("provider failure on both slots returns a stable selection_failed without exposing errors", async () => {
  let calls = 0;
  const result = await selectSticker(context, { entries: [sticker("safe")], model: async () => {
    calls++;
    throw new Error("SYNTHETIC_PRIVATE_ERROR");
  } });
  assert.equal(calls, 2);
  assert.equal(result.reasonCode, "selection_failed");
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_ERROR"), false);
});

test("invalid output fallback shares four attempts and a shrinking thirty-second deadline", async () => {
  let now = 0;
  const requests = [];
  const result = await selectSticker(context, { entries: [sticker("safe")], budgetClock: () => now,
    model: async (_prompt, position, request) => {
      requests.push(request);
      assert.equal(request.maxTokens, 100);
      assert.equal(request.maxAttempts, 2);
      assert.equal(request.beforeAttempt(), "");
      assert.equal(request.beforeAttempt(), "");
      if (position === "primary") { now = 27000; return "bad JSON"; }
      assert.equal(request.timeoutMs, 3000);
      assert.equal(request.signal, requests[0].signal);
      assert.equal(request.beforeAttempt(), "task_budget");
      return '{"selected":"safe"}';
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.reasonCode, "selection_selected");
});

for (const stop of ["signal", "privacy", "permission", "deadline"]) {
  for (const positionToStop of ["primary", "fallback"]) {
    test(stop + " during " + positionToStop + " never becomes invalid output or another fallback", async () => {
      const controller = new globalThis.AbortController();
      let permitted = true;
      let now = 0;
      let calls = 0;
      const options = { entries: [sticker("safe")], signal: controller.signal, budgetClock: () => now,
        assertCurrent: () => { if (!permitted) throw new Error("synthetic permission revoked"); },
        model: async (_prompt, position) => {
          calls++;
          if (position !== positionToStop) return "bad JSON";
          if (stop === "signal") controller.abort();
          if (stop === "privacy") invalidateMemoryPrivacyGeneration();
          if (stop === "permission") permitted = false;
          if (stop === "deadline") now = 30000;
          return '{"selected":"safe"}';
        },
      };
      await assert.rejects(selectSticker(context, options));
      assert.equal(calls, positionToStop === "primary" ? 1 : 2);
    });
  }
}

test("an explicit AbortError is not treated as an ordinary provider failure", async () => {
  let calls = 0;
  await assert.rejects(selectSticker(context, { entries: [sticker("safe")], model: async () => {
    calls++;
    throw Object.assign(new Error("synthetic cancellation"), { name: "AbortError" });
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("real chat-run replacement aborts selection and prevents the fallback slot", async () => {
  let ready;
  let release;
  let calls = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const pendingModel = new Promise(resolve => { release = resolve; });
  const scope = { surface: "group", groupId: GROUP, userId: USER };
  const cfg = { ...CFG, groupWhitelist: [GROUP], friendWhitelist: [USER], botBlacklist: [] };
  const pending = withChatRun(scope, () => selectSticker(context, { entries: [sticker("safe")],
    model: async (_prompt, _position, request) => {
      calls++;
      ready();
      await pendingModel;
      assert.equal(request.signal.aborted, true);
      return '{"selected":"safe"}';
    },
  }), { cfg });
  await started;
  await withChatRun(scope, () => "replacement", { cfg });
  release();
  const result = await pending;
  assert.equal(result.kind, "cancelled");
  assert.equal(calls, 1);
});

function sticker(id, tags = ["neutral"], description = "a neutral reaction", patch = {}) {
  return { id, tags, description, url: "https://example.com/" + id + ".png", source: "qq-favorite",
    enabled: true, indexed: true, allowedGroups: [], sendCount: 0, ...patch };
}

function sourcedHistory(text) {
  return enforceContextBudget([{ role: "user", content: text.slice(0, 400), contextPriority: 70,
    contextSources: [{ kind: "group", messageId: "synthetic-history", userId: USER }] }], "current", {
    mode: "group-at", maxChars: 2000,
  }).messages;
}
