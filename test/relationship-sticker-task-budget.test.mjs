import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-relationship-sticker-budget-"));
Object.assign(process.env, {
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
});
const { createModelTaskBudget } = await import("../bridge/api-providers/task-budget.mjs");
const { buildRelationshipCommentRequest, buildStickerSelectionRequest, callTaskProviderResult } = await import("../bridge/model-router.mjs");
const { createDefaultApiConfig } = await import("../bridge/api-providers/store.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { withChatRun } = await import("../bridge/cognition/chat-run.mjs");
const { getRelationshipShortComment, buildLocalRelationshipComment } = await import("../bridge/relationship-comment.mjs");
const { selectSticker } = await import("../bridge/features/stickers/selector.mjs");
const { invalidateUserMemoryGeneration, invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { flushSavesSync } = await import("../bridge/storage.mjs");

const relation = {
  familiarity: 68, groupFamiliarity: 52, recentHeat: "ordinary",
  topics: ["synthetic topic"], replyStyle: "concise", groupInteractionStyle: "technical",
  relationshipTags: ["technical peer"], confidence: 0.64, messageCount: 80, groupMessageCount: 40,
};
const context = { userId: "budget-user", groupId: "budget-group", userMessage: "\u5f00\u5fc3", assistantText: "\u5f00\u5fc3" };
const entries = [{ id: "synthetic-sticker", source: "qq-favorite", enabled: true, indexed: true,
  url: "https://example.com/synthetic-sticker.png", allowedGroups: [],
  tags: ["\u5f00\u5fc3"], description: "synthetic happy sticker", sendCount: 0 }];
const selected = '{"selected":"synthetic-sticker"}';
const noFallback = () => assert.fail("stopped tasks must not start fallback");

beforeEach(t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("synthetic tests must not access APIs or QQ"));
});
after(() => {
  flushSavesSync();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
});

function assertPrepared(request, maxTokens, deadline) {
  assert.equal(request.maxTokens, maxTokens);
  assert.equal(request.maxAttempts, 2);
  assert.ok(request.signal instanceof globalThis.AbortSignal);
  assert.ok(request.timeoutMs > 0 && request.timeoutMs <= deadline);
  assert.ok(Number.isSafeInteger(request.maxResponseBytes) && request.maxResponseBytes > 0);
  assert.equal(typeof request.beforeAttempt, "function");
}

for (const [task, maxTokens, durationMs, build] of [
  ["relationship_comment", 160, 45000, buildRelationshipCommentRequest],
  ["sticker_select", 100, 30000, buildStickerSelectionRequest],
]) {
  test(`${task} bounds both calls, four attempts and completion reservations`, () => {
    let now = 0;
    const budget = createModelTaskBudget(task, { now: () => now });
    const primary = budget.prepare(build("synthetic prompt", "primary"));
    assertPrepared(primary, maxTokens, durationMs);
    assert.equal(primary.beforeAttempt(), "");
    assert.equal(primary.beforeAttempt(), "");
    now = durationMs - 1000;
    const fallback = budget.prepare(build("synthetic prompt", "fallback"));
    assert.equal(fallback.signal, primary.signal);
    assert.equal(fallback.timeoutMs, 1000);
    assert.equal(fallback.beforeAttempt(), "");
    assert.equal(fallback.beforeAttempt(), "");
    assert.equal(primary.beforeAttempt(), "task_budget");
    assert.equal(fallback.beforeAttempt(), "task_budget");
    assert.equal(budget.snapshot().calls, 2);
    assert.equal(budget.snapshot().transportAttempts, 4);
    assert.equal(budget.snapshot().requestedCompletionTokens, maxTokens * 4);
    assert.throws(() => budget.prepare(build("third call")), /task_budget/);
    assert.throws(() => createModelTaskBudget(task, { now: () => 0 }).prepare({ ...build("synthetic"), maxTokens: maxTokens + 1 }), /task_output_budget/);
  });
}

test("relationship slots receive the same budget with shrinking timeout and shared attempt hooks", async () => {
  let now = 0;
  let checks = 0;
  const captured = [];
  const text = await getRelationshipShortComment(relation, {
    budgetClock: () => now, assertCurrent: () => { checks++; },
    callMiMo: async (prompt, request) => {
      assert.equal(request.messages[0].content, prompt);
      assertPrepared(request, 160, 45000);
      captured.push(request);
      assert.equal(request.beforeAttempt(), "");
      assert.equal(request.beforeAttempt(), "");
      now = 41000;
      return "";
    },
    callDeepSeek: async (prompt, request) => {
      assert.equal(request.messages[0].content, prompt);
      assertPrepared(request, 160, 45000);
      captured.push(request);
      assert.equal(request.timeoutMs, 4000);
      assert.equal(request.beforeAttempt(), "");
      assert.equal(request.beforeAttempt(), "");
      assert.equal(captured[0].beforeAttempt(), "task_budget");
      return "SYNTHETIC_CURRENT_COMMENT";
    },
  });
  assert.equal(text, "SYNTHETIC_CURRENT_COMMENT");
  assert.equal(captured.length, 2);
  assert.equal(captured[0].signal, captured[1].signal);
  assert.ok(checks > 4);
});

test("sticker slots receive the same budget with shrinking timeout and shared attempt hooks", async () => {
  let now = 0;
  let checks = 0;
  const captured = [];
  const result = await selectSticker(context, {
    entries, budgetClock: () => now, assertCurrent: () => { checks++; },
    model: async (prompt, position, request) => {
      assert.equal(request.messages[0].content, prompt);
      assertPrepared(request, 100, 30000);
      captured.push(request);
      assert.equal(request.beforeAttempt(), "");
      assert.equal(request.beforeAttempt(), "");
      if (position === "primary") { now = 27000; return ""; }
      assert.equal(position, "fallback");
      assert.equal(request.timeoutMs, 3000);
      assert.equal(captured[0].beforeAttempt(), "task_budget");
      return selected;
    },
  });
  assert.equal(result.action, "send");
  assert.equal(result.stickerId, entries[0].id);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].signal, captured[1].signal);
  assert.ok(checks > 4);
});

for (const output of ["", "SYNTHETIC_LATE_COMMENT", "throw"]) {
  test(`late relationship primary (${output || "empty"}) cannot start fallback or cache local/model text`, async () => {
    let now = 0;
    let calls = 0;
    const user = {};
    const result = await getRelationshipShortComment(relation, {
      user, budgetClock: () => now,
      callMiMo: async () => {
        calls++;
        now = 45000;
        if (output === "throw") throw new Error("synthetic provider failure");
        return output;
      },
      callDeepSeek: noFallback,
    });
    assert.equal(result, "");
    assert.equal(calls, 1);
    assert.deepEqual(user, {});
  });
}

for (const output of ["", selected]) {
  test(`late sticker primary (${output ? "selected" : "empty"}) cannot start fallback or return candidates`, async () => {
    let now = 0;
    let calls = 0;
    await assert.rejects(selectSticker(context, {
      entries, budgetClock: () => now,
      model: async (_prompt, position) => {
        assert.equal(position, "primary");
        calls++;
        now = 30000;
        return output;
      },
    }), { code: "MODEL_TASK_BUDGET", message: "task_deadline" });
    assert.equal(calls, 1);
  });
}

test("a late relationship fallback cannot write model text or a local template to cache", async () => {
  let now = 0;
  const user = {};
  const result = await getRelationshipShortComment(relation, {
    user, budgetClock: () => now, callMiMo: async () => "",
    callDeepSeek: async () => { now = 45000; return "SYNTHETIC_LATE_FALLBACK"; },
  });
  assert.equal(result, "");
  assert.deepEqual(user, {});
});

test("a late sticker fallback cannot return a selected result", async () => {
  let now = 0;
  await assert.rejects(selectSticker(context, {
    entries, budgetClock: () => now,
    model: async (_prompt, position) => {
      if (position === "primary") return "";
      now = 30000;
      return selected;
    },
  }), { code: "MODEL_TASK_BUDGET", message: "task_deadline" });
});

for (const positionToCancel of ["primary", "fallback"]) {
  test(`relationship cancellation during ${positionToCancel} suppresses cache writes and further calls`, async () => {
    const controller = new globalThis.AbortController();
    const user = {};
    let calls = 0;
    const cancel = async (_prompt, request) => {
      calls++;
      controller.abort();
      assert.equal(request.signal.aborted, true);
      assert.equal(request.beforeAttempt(), "task_cancelled");
      return "SYNTHETIC_CANCELLED_COMMENT";
    };
    const result = await getRelationshipShortComment(relation, {
      user, signal: controller.signal,
      callMiMo: positionToCancel === "primary" ? cancel : async () => { calls++; return ""; },
      callDeepSeek: positionToCancel === "fallback" ? cancel : noFallback,
    });
    assert.equal(result, "");
    assert.equal(calls, positionToCancel === "primary" ? 1 : 2);
    assert.deepEqual(user, {});
  });

  test(`sticker cancellation during ${positionToCancel} suppresses selected results and further calls`, async () => {
    const controller = new globalThis.AbortController();
    let calls = 0;
    await assert.rejects(selectSticker(context, {
      entries, signal: controller.signal,
      model: async (_prompt, position, request) => {
        calls++;
        if (position !== positionToCancel) return "";
        controller.abort();
        assert.equal(request.signal.aborted, true);
        assert.equal(request.beforeAttempt(), "task_cancelled");
        return selected;
      },
    }), { code: "MODEL_TASK_BUDGET", message: "task_cancelled" });
    assert.equal(calls, positionToCancel === "primary" ? 1 : 2);
  });
}

test("cancelled and expired tasks cannot return an otherwise valid relationship cache", async () => {
  const user = {};
  const options = { user, groupId: "budget-cache", now: 1000, callMiMo: async () => "SYNTHETIC_CACHED_COMMENT", callDeepSeek: noFallback };
  assert.equal(await getRelationshipShortComment(relation, options), "SYNTHETIC_CACHED_COMMENT");
  const before = JSON.stringify(user);
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.equal(await getRelationshipShortComment(relation, { ...options, signal: controller.signal, callMiMo: noFallback }), "");
  let reads = 0;
  assert.equal(await getRelationshipShortComment(relation, {
    ...options, callMiMo: noFallback, budgetClock: () => ++reads <= 2 ? 0 : 45000,
  }), "");
  assert.equal(JSON.stringify(user), before);
});

test("relationship fingerprints still cache score-only movement and refresh changed semantics", async () => {
  const user = {};
  let calls = 0;
  const options = { user, groupId: "budget-fingerprint", now: 1000, callMiMo: async () => "SYNTHETIC_COMMENT_" + (++calls), callDeepSeek: noFallback };
  const initial = await getRelationshipShortComment(relation, options);
  assert.equal(await getRelationshipShortComment({ ...relation, familiarity: 69, confidence: 0.65 }, options), initial);
  assert.equal(calls, 1);
  assert.notEqual(await getRelationshipShortComment({ ...relation, topics: ["different topic"] }, options), initial);
  assert.equal(calls, 2);
});

test("current relationship provider failures and unsafe output retain local fallback", async () => {
  const text = await getRelationshipShortComment(relation, {
    callMiMo: async () => { throw new Error("synthetic unavailable"); },
    callDeepSeek: async () => "\u6211\u559c\u6b22\u4f60",
  });
  assert.equal(text, buildLocalRelationshipComment(relation));
});

test("relationship generation and source guards reject late text without fallback or cache", async () => {
  for (const stop of ["generation", "source"]) {
    const user = { uid: "budget-guard-user" };
    let stale = false;
    const result = await getRelationshipShortComment(relation, {
      user, memoryGuard: { stopReason: () => stale ? "memory_expired" : "" },
      callMiMo: async (_prompt, request) => {
        if (stop === "generation") invalidateUserMemoryGeneration(user.uid);
        else stale = true;
        assert.equal(request.beforeAttempt(), "task_cancelled");
        return "SYNTHETIC_STALE_COMMENT";
      },
      callDeepSeek: noFallback,
    });
    assert.equal(result, "");
    assert.equal(user.relationshipComments, undefined);
  }
});

test("sticker privacy guard retains its error and suppresses fallback", async () => {
  let calls = 0;
  await assert.rejects(selectSticker(context, {
    entries,
    model: async (_prompt, position, request) => {
      assert.equal(position, "primary");
      calls++;
      invalidateMemoryPrivacyGeneration();
      assert.equal(request.beforeAttempt(), "task_cancelled");
      return "";
    },
  }), { code: "STICKER_PRIVACY_CHANGED" });
  assert.equal(calls, 1);
});

test("supplied current guards apply to attempt hooks and cannot be swallowed as provider errors", async () => {
  let current = true;
  const check = () => { if (!current) throw new Error("synthetic permission revoked"); };
  const user = {};
  await assert.rejects(getRelationshipShortComment(relation, {
    user, assertCurrent: check,
    callMiMo: async (_prompt, request) => {
      current = false;
      assert.equal(request.beforeAttempt(), "task_cancelled");
      return "SYNTHETIC_STALE_COMMENT";
    },
    callDeepSeek: noFallback,
  }), /synthetic permission revoked/);
  assert.deepEqual(user, {});
  current = true;
  await assert.rejects(selectSticker(context, {
    entries, assertCurrent: check,
    model: async (_prompt, position, request) => {
      assert.equal(position, "primary");
      current = false;
      assert.equal(request.beforeAttempt(), "task_cancelled");
      return selected;
    },
  }), /synthetic permission revoked/);
});

test("real chat and command run replacement aborts relationship/sticker HTTP and blocks cached/local results", async t => {
  const cfg = { ...CFG, groupWhitelist: [501], friendWhitelist: [601], botBlacklist: [] };
  const config = createDefaultApiConfig();
  for (const provider of ["mimo", "deepseek"]) {
    config.providers[provider].auth = "none";
    config.providers[provider].endpoint = "https://example.com/with-chat-budget";
  }
  const cachedUser = {};
  const cacheOptions = { user: cachedUser, groupId: 501, callMiMo: async () => "SYNTHETIC_CACHED_COMMENT", callDeepSeek: noFallback };
  await getRelationshipShortComment(relation, cacheOptions);

  for (const lane of ["chat", "command"]) {
    for (const task of ["relationship_comment", "sticker_select"]) {
      const scope = { surface: "group", groupId: 501, userId: 601, lane };
      const controller = new globalThis.AbortController();
      const user = {};
      let prepared;
      let httpSignal;
      let modelCalls = 0;
      let httpCalls = 0;
      let cacheReads = 0;
      let operationOutcome;
      let cacheOutcome;
      let ready;
      const started = new Promise(resolve => { ready = resolve; });
      const cacheReader = { get relationshipComments() { cacheReads++; return cachedUser.relationshipComments; } };
      const fetchMock = t.mock.method(globalThis, "fetch", (url, request) => {
        assert.match(String(url), /^https:\/\/example\.com\/with-chat-budget/);
        httpCalls++;
        httpSignal = request.signal;
        assert.equal(httpSignal.aborted, false);
        ready();
        return new Promise((_resolve, reject) => {
          httpSignal.addEventListener("abort", () => reject(Object.assign(new Error("synthetic HTTP aborted"), { name: "AbortError" })), { once: true });
        });
      });
      const call = async (position, request) => {
        modelCalls++;
        assert.equal(position, "primary");
        prepared = request;
        await callTaskProviderResult(task, position, request, { config });
        return task === "sticker_select" ? selected : "";
      };
      const pending = withChatRun(scope, async () => {
        const operation = task === "relationship_comment"
          ? getRelationshipShortComment(relation, { user, signal: controller.signal, callMiMo: (_prompt, request) => call("primary", request), callDeepSeek: noFallback })
          : selectSticker({ ...context, userId: 601, groupId: 501 }, { entries, signal: controller.signal, model: (_prompt, position, request) => call(position, request) });
        operationOutcome = await operation.then(value => ({ value }), error => ({ error }));
        cacheOutcome = await getRelationshipShortComment(relation, { ...cacheOptions, user: cacheReader })
          .then(value => ({ value }), error => ({ error }));
      }, { cfg });
      await started;
      assert.equal(prepared.signal.aborted, false);
      assert.equal(await withChatRun(scope, () => "replacement", { cfg }), "replacement");
      assert.equal(prepared.signal.aborted, true);
      assert.equal(httpSignal.aborted, true);
      assert.equal(controller.signal.aborted, false);
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      const result = await pending;
      assert.equal(result.kind, "cancelled");
      assert.equal(result.reason, "reply_superseded");
      assert.equal(result.text, null);
      assert.equal(operationOutcome.error?.code, "CHAT_CANCELLED");
      assert.equal(operationOutcome.error?.message, "reply_superseded");
      assert.equal(cacheOutcome.error?.code, "CHAT_CANCELLED");
      assert.equal(cacheOutcome.error?.message, "reply_superseded");
      assert.equal(modelCalls, 1);
      assert.equal(httpCalls, 1);
      assert.equal(cacheReads, 0);
      assert.deepEqual(user, {});
      fetchMock.mock.restore();
    }
  }
});

test("sticker no-match is respected and invalid candidates use only bounded fallback without any sends", async () => {
  const positions = [];
  const noCue = await selectSticker({ ...context, userMessage: "neutral", assistantText: "neutral" }, {
    entries, model: async (_prompt, position) => { positions.push(position); return '{"selected":null}'; },
  });
  assert.equal(noCue.action, "no_match");
  assert.equal(noCue.reasonCode, "selection_none");
  assert.equal(noCue.candidates.length, 1);
  assert.equal(noCue.candidates[0].id, entries[0].id);
  assert.deepEqual(positions, ["primary"]);
  for (const output of ['{"selected":null}', '{"selected":"outside-candidates"}', "malformed"]) {
    let calls = 0;
    const result = await selectSticker(context, {
      entries, model: async (_prompt, position) => {
        calls++;
        assert.equal(position, calls === 1 ? "primary" : "fallback");
        return output;
      },
    });
    assert.equal(result.action, "no_match");
    assert.equal(result.sticker, null);
    assert.equal(result.stickerId, "");
    assert.equal(calls, output === '{"selected":null}' ? 1 : 2);
  }
});
