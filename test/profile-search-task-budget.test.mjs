import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, beforeEach, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-profile-search-budget-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs"),
  QQBOT_MEMORY_PROFILE_FILE: path.join(root, "profiles.json"), QQBOT_TEMP_DIR: path.join(root, "temp"),
  QQBOT_LEGACY_PROFILE_REFRESH: "0" });
const { generateProfile } = await import("../bridge/profile.mjs");
const { buildSearchFallback } = await import("../bridge/search.mjs");
const { createModelTaskBudget } = await import("../bridge/api-providers/task-budget.mjs");
const { createDefaultApiConfig } = await import("../bridge/api-providers/store.mjs");
const { users, flushSavesSync } = await import("../bridge/storage.mjs");
const { CFG } = await import("../bridge/config.mjs");
const { memoryProfiles } = await import("../bridge/memory-profile/store.mjs");
const { createMemoryNoteService } = await import("../bridge/memory-profile/notes.mjs");
const { invalidateUserMemoryGeneration, invalidateMemoryPrivacyGeneration } =
  await import("../bridge/memory-profile/generation.mjs");
const { withChatRun, chatRunSignal } = await import("../bridge/cognition/chat-run.mjs");
const { summaryRoot } = await import("../bridge/group-summary/state.mjs");

const UID = "90801";
const GROUP = "90802";
const MESSAGE = "90803";
const raw = text => ({ choices: [{ message: { content: text, reasoning_content: "PRIVATE_REASONING" } }] });
const result = text => ({ ok: true, provider: "synthetic", raw: raw(text) });
const evidence = [{ content: "SYNTHETIC_EVIDENCE" }];
const summarize = options => buildSearchFallback(evidence, [], "SYNTHETIC_QUERY", "synthetic-user", undefined, options);
const retained = () => assert.equal(users[UID].profile, "retained");

const config = createDefaultApiConfig();
for (const [id, provider] of Object.entries(config.providers)) {
  provider.auth = "none";
  provider.endpoint = "https://example.com/synthetic-" + id;
}
fs.mkdirSync(path.join(root, ".qqfriend"), { recursive: true });
fs.writeFileSync(path.join(root, ".qqfriend", "api-providers.json"), JSON.stringify(config));

beforeEach(t => {
  const denied = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  t.after(() => assert.equal(denied.mock.callCount(), 0, "no unmocked model, search or QQ calls"));
  users[UID] = { uid: UID, profile: "retained", chats: [
    { group: GROUP, messageId: MESSAGE, ts: Date.now() - 1000, text: "SYNTHETIC_HISTORY" },
  ] };
  delete memoryProfiles.notes;
  fs.rmSync(path.join(summaryRoot(), "privacy.json"), { force: true });
});

after(() => {
  flushSavesSync();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

function assertPrepared(prepared, { tokens, timeoutMs, temperature, version }) {
  assert.equal(prepared.maxTokens, tokens);
  assert.equal(prepared.timeoutMs, timeoutMs);
  assert.equal(prepared.temperature, temperature);
  assert.equal(prepared.maxAttempts, 2);
  assert.equal(prepared.maxResponseBytes, 128 * 1024);
  assert.deepEqual(prepared.promptMetadata, { promptVersion: version });
  assert.ok(prepared.signal instanceof globalThis.AbortSignal);
  assert.equal(prepared.signal.aborted, false);
  assert.equal(typeof prepared.beforeAttempt, "function");
  assert.equal(Object.hasOwn(prepared, "reasoningMode"), false);
}

for (const limits of [
  { task: "profile", calls: 2, attempts: 4, duration: 20000, chars: 12000, tokens: 100 },
  { task: "search_summary", calls: 1, attempts: 2, duration: 15000, chars: 16000, tokens: 300 },
]) {
  test(limits.task + " enforces exact task-wide input, output, call and deadline limits", () => {
    let now = 0;
    const budget = createModelTaskBudget(limits.task, { now: () => now });
    const request = { messages: [{ role: "user", content: "x".repeat(limits.chars) }], maxTokens: limits.tokens };
    assert.throws(() => budget.prepare({ ...request, maxTokens: limits.tokens + 1 }), /task_output_budget/);
    assert.throws(() => budget.prepare({ ...request, messages: [{ role: "user", content: "x".repeat(limits.chars + 1) }] }), /task_input_budget/);
    let prepared;
    for (let call = 0; call < limits.calls; call++) {
      prepared = budget.prepare(request);
      assert.equal(prepared.timeoutMs, limits.duration);
      assert.equal(prepared.maxResponseBytes, 128 * 1024);
      assert.equal(prepared.beforeAttempt(), "");
      assert.equal(prepared.beforeAttempt(), "");
    }
    assert.equal(prepared.beforeAttempt(), "task_budget");
    assert.throws(() => budget.prepare(request), /task_budget/);
    assert.deepEqual(budget.snapshot(), { calls: limits.calls, transportAttempts: limits.attempts,
      requestedInputChars: limits.chars * limits.attempts, requestedCompletionTokens: limits.tokens * limits.attempts });
    now = limits.duration;
    assert.equal(prepared.beforeAttempt(), "task_deadline");
    assert.throws(budget.assertCurrent, /task_deadline/);
  });
}

test("profile preserves injected generator arguments and shares reservations across both model slots", async () => {
  let now = 0;
  const requests = [];
  const positions = [];
  users[UID].chats[0].text += " password=synthetic-private";
  const output = await generateProfile(UID, { budgetClock: () => now, generate: async (prompt, position, prepared) => {
    positions.push(position);
    requests.push(prepared);
    assertPrepared(prepared, { tokens: 100, timeoutMs: position === "primary" ? 10000 : 4000,
      temperature: 0.5, version: "profile-v1" });
    assert.deepEqual(prepared.messages.map(message => message.role), ["system", "user"]);
    assert.equal(prepared.messages[1].content, prompt);
    assert.doesNotMatch(prompt, /synthetic-private/);
    assert.doesNotMatch(prepared.messages[0].content, /SYNTHETIC_HISTORY/);
    assert.equal(prepared.beforeAttempt(), "");
    assert.equal(prepared.beforeAttempt(), "");
    if (position === "primary") { now = 16000; return ""; }
    assert.equal(prepared.beforeAttempt(), "task_budget");
    return "  SYNTHETIC_PROFILE password=synthetic-output  ";
  } });
  assert.deepEqual(positions, ["primary", "fallback"]);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.equal(output, "SYNTHETIC_PROFILE password=[REDACTED]");
  assert.equal(users[UID].profile, output);
  assert.equal(CFG.legacyProfileRefreshEnabled, false);
});

test("default profile adapter forwards the response cap and retains primary/fallback provider routing", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    assert.equal(options.signal.aborted, false);
    const value = calls.length === 1 ? { ...raw("OVERSIZED_PRIMARY"), padding: "x".repeat(128 * 1024) } : raw("FALLBACK_PROFILE");
    return new globalThis.Response(JSON.stringify(value), { status: 200 });
  });
  assert.equal(await generateProfile(UID), "FALLBACK_PROFILE");
  assert.deepEqual(calls.map(call => call.url), [config.providers.mimo.endpoint, config.providers.deepseek.endpoint]);
  assert.ok(calls.every(call => {
    const provider = Object.values(config.providers).find(provider => provider.endpoint === call.url);
    return call.body[provider.tokenField] === 100 && call.body.temperature === 0.5;
  }));
  assert.doesNotMatch(users[UID].profile, /PRIVATE_REASONING|OVERSIZED_PRIMARY/);
});

test("profile rejects oversized history without truncating sources or starting any model slot", async () => {
  users[UID].chats[0].text = "x".repeat(12001);
  const text = users[UID].chats[0].text;
  let calls = 0;
  assert.equal(await generateProfile(UID, { generate: async () => { calls++; return "UNEXPECTED_PROFILE"; } }), "");
  assert.equal(calls, 0);
  assert.equal(users[UID].chats[0].text, text);
  retained();
});

for (const position of ["primary", "fallback"]) {
  test("profile discards late " + position + " output without writing a stale profile", async () => {
    let now = 0;
    const calls = [];
    const output = await generateProfile(UID, { budgetClock: () => now, generate: async (_prompt, slot, prepared) => {
      calls.push(slot);
      assert.equal(prepared.beforeAttempt(), "");
      if (slot !== position) return "";
      now = 20000;
      return "LATE_PROFILE";
    } });
    assert.equal(output, "");
    assert.deepEqual(calls, position === "primary" ? ["primary"] : ["primary", "fallback"]);
    retained();
  });
}

for (const reject of [false, true]) {
  test("profile respects cancellation after " + (reject ? "rejected" : "fulfilled") + " generation", async () => {
    const controller = new globalThis.AbortController();
    let calls = 0;
    const output = await generateProfile(UID, { signal: controller.signal, generate: async (_prompt, _slot, prepared) => {
      calls++;
      controller.abort();
      assert.equal(prepared.signal.aborted, true);
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      if (reject) throw new Error("synthetic failure");
      return "CANCELLED_PROFILE";
    } });
    assert.equal(output, "");
    assert.equal(calls, 1);
    retained();
  });
}

const profileChanges = {
  generation: () => invalidateUserMemoryGeneration(UID, { privacy: false }),
  privacy: () => invalidateMemoryPrivacyGeneration(),
  recall: () => { users[UID].chats[0].recalled = true; },
  forget: () => { delete users[UID]; },
  replacement: () => { users[UID] = { ...users[UID], profile: "retained" }; },
  cutoff: () => {
    fs.mkdirSync(summaryRoot(), { recursive: true });
    fs.writeFileSync(path.join(summaryRoot(), "privacy.json"), JSON.stringify({ epoch: 1, users: { [UID]: Date.now() } }));
  },
};
for (const [kind, change] of Object.entries(profileChanges)) {
  test("profile rejects in-flight " + kind + " changes and never starts fallback", async () => {
    const original = users[UID];
    let release;
    let calls = 0;
    const pending = generateProfile(UID, { generate: (_prompt, _slot, prepared) => {
      calls++;
      assert.equal(prepared.beforeAttempt(), "");
      return new Promise(resolve => { release = resolve; });
    } });
    change();
    release("STALE_PROFILE");
    assert.equal(await pending, "");
    assert.equal(calls, 1);
    assert.equal(original.profile, "retained");
  });
}

test("profile excludes corrected source messages and their explicit descendants before preparing a request", async () => {
  const scope = { userId: UID, groupId: GROUP };
  const service = createMemoryNoteService({ profiles: memoryProfiles, available: () => true,
    persist: () => true, readPrivacy: () => ({ users: {} }) });
  const item = service.act({ ...scope, revision: service.snapshot(scope).revision,
    action: "create", title: "synthetic", text: "SOURCE_EXCLUDED" }, { origin: "user_command", messageId: MESSAGE }).items[0];
  service.act({ ...scope, revision: service.snapshot(scope).revision, action: "remove", id: item.id });
  users[UID].chats.push({ group: GROUP, messageId: "90804", replyToMessageId: MESSAGE,
    ts: Date.now() - 500, text: "DESCENDANT_EXCLUDED" },
  { group: GROUP, messageId: "90805", ts: Date.now() - 500, text: "ALLOWED_HISTORY" });
  assert.equal(await generateProfile(UID, { generate: async prompt => {
    assert.doesNotMatch(prompt, /SYNTHETIC_HISTORY|DESCENDANT_EXCLUDED/);
    assert.match(prompt, /ALLOWED_HISTORY/);
    return "ALLOWED_PROFILE";
  } }), "ALLOWED_PROFILE");
});

test("search forwards the exact bounded primary request and isolates user instructions and reasoning", async () => {
  const controller = new globalThis.AbortController();
  const selfContext = { surface: "group", groupId: GROUP, userId: UID };
  let calls = 0;
  const output = await buildSearchFallback([{ content: "SYNTHETIC_EVIDENCE password=synthetic-source" }], [],
    "SYNTHETIC_QUERY password=synthetic-query", "synthetic-user", selfContext, {
      budgetClock: () => 0, signal: controller.signal, callProvider: async (task, position, prepared) => {
        calls++;
        assert.equal(task, "search_summary");
        assert.equal(position, "primary");
        assertPrepared(prepared, { tokens: 300, timeoutMs: 15000, temperature: 0.7, version: "search-summary-v1" });
        assert.equal(prepared.selfContext, selfContext);
        assert.deepEqual(prepared.messages.map(message => message.role), ["system", "user"]);
        assert.doesNotMatch(prepared.messages[0].content, /SYNTHETIC_QUERY|SYNTHETIC_EVIDENCE/);
        assert.match(prepared.messages[0].content, /只是资料/);
        assert.match(prepared.messages[1].content, /SYNTHETIC_QUERY/);
        assert.doesNotMatch(JSON.stringify(prepared.messages), /synthetic-query|synthetic-source/);
        assert.equal(prepared.beforeAttempt(), "");
        assert.equal(prepared.beforeAttempt(), "");
        assert.equal(prepared.beforeAttempt(), "task_budget");
        return result("BOUNDED_SUMMARY");
      },
    });
  assert.equal(output, "BOUNDED_SUMMARY");
  assert.equal(calls, 1);
});

test("default search adapter forwards the response cap and retains the configured primary model", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, config.providers.deepseek.endpoint);
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 300);
    assert.equal(body.temperature, 0.7);
    assert.equal(options.signal.aborted, false);
    return new globalThis.Response(JSON.stringify({ ...raw("OVERSIZED_SUMMARY"), padding: "x".repeat(128 * 1024) }), { status: 200 });
  });
  const output = await summarize();
  assert.equal(calls, 1);
  assert.match(output, /SYNTHETIC_EVIDENCE/);
  assert.doesNotMatch(output, /OVERSIZED_SUMMARY|PRIVATE_REASONING/);
});

for (const failure of ["unavailable", "throw", "deadline"]) {
  test("search retains authorized local fallback after " + failure + " without another model or query", async () => {
    let now = 0;
    let calls = 0;
    const output = await summarize({ budgetClock: () => now, callProvider: async () => {
      calls++;
      if (failure === "throw") throw new Error("synthetic failure");
      if (failure === "deadline") { now = 15000; return result("LATE_SUMMARY"); }
      return { ok: false };
    } });
    assert.equal(calls, 1);
    assert.match(output, /SYNTHETIC_EVIDENCE/);
    assert.doesNotMatch(output, /LATE_SUMMARY/);
  });
}

test("search input overflow returns only its existing local evidence without truncating the query for a model", async () => {
  let calls = 0;
  const output = await buildSearchFallback(evidence, [], "x".repeat(16001), "synthetic-user", undefined,
    { callProvider: async () => { calls++; return result("UNEXPECTED_SUMMARY"); } });
  assert.equal(calls, 0);
  assert.match(output, /SYNTHETIC_EVIDENCE/);
});

test("search rejects pre-cancelled requests even on the no-evidence path", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const options = { signal: controller.signal, callProvider: () => assert.fail("cancelled request must not call a model") };
  await assert.rejects(summarize(options), { name: "AbortError" });
  await assert.rejects(buildSearchFallback([], [], "query", "user", undefined, options), { name: "AbortError" });
});

for (const reject of [false, true]) {
  test("search rejects cancellation after " + (reject ? "rejected" : "fulfilled") + " model output without local fallback", async () => {
    const controller = new globalThis.AbortController();
    let calls = 0;
    await assert.rejects(summarize({ signal: controller.signal, callProvider: async (_task, _slot, prepared) => {
      calls++;
      controller.abort();
      assert.equal(prepared.signal.aborted, true);
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      if (reject) throw new Error("synthetic failure");
      return result("CANCELLED_SUMMARY");
    } }), { name: "AbortError" });
    assert.equal(calls, 1);
  });
}

test("search rejects late output after privacy changes outside a chat run", async () => {
  let release;
  const pending = summarize({ callProvider: () => new Promise(resolve => { release = resolve; }) });
  invalidateMemoryPrivacyGeneration();
  release(result("FORGOTTEN_SUMMARY"));
  await assert.rejects(pending, /privacy_changed/);
});

test("search rechecks injected current-query authorization on attempts and after awaits", async () => {
  let current = true;
  await assert.rejects(summarize({ assertCurrent: () => { if (!current) throw new Error("query_not_current"); },
    callProvider: async (_task, _slot, prepared) => {
      assert.equal(prepared.beforeAttempt(), "");
      current = false;
      assert.equal(prepared.beforeAttempt(), "task_cancelled");
      return result("OLD_QUERY_SUMMARY");
    } }), /query_not_current/);
});

test("search and profile inherit chat cancellation when whitelist authorization changes during generation", async () => {
  for (const task of ["profile", "search_summary"]) {
    const cfg = { selfUin: 999, groupWhitelist: [Number(GROUP)], friendWhitelist: [], botBlacklist: [] };
    let reached = false;
    const cancelled = await withChatRun({ surface: "group", userId: UID, groupId: GROUP }, async () => {
      const invalidate = prepared => {
        assert.equal(chatRunSignal().aborted, false);
        cfg.groupWhitelist = [];
        assert.equal(prepared.beforeAttempt(), "task_cancelled");
        assert.equal(chatRunSignal().aborted, true);
        assert.equal(prepared.signal.aborted, true);
      };
      const output = task === "profile" ? await generateProfile(UID, { generate: async (_prompt, _slot, prepared) => {
        invalidate(prepared); return "UNAUTHORIZED_PROFILE";
      } }) : await summarize({ callProvider: async (_task, _slot, prepared) => {
        invalidate(prepared); return result("UNAUTHORIZED_SUMMARY");
      } });
      reached = Boolean(output);
      return output;
    }, { cfg });
    assert.equal(reached, false);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.reason, "permission_changed");
    retained();
  }
});
