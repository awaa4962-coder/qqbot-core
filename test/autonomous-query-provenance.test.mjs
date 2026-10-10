import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicQueryGuard } from "../bridge/chat-tools/private-evidence.mjs";
import { registerContextGroups } from "../bridge/context/pruning.mjs";
import { enforceContextBudget } from "../bridge/context/budget.mjs";
import { createPublicSourceSession } from "../bridge/chat-tools/public-sources.mjs";

const currentMessage = "Why does the Moon look larger near the horizon?";
const rewritten = "lunar horizon apparent size illusion explanation";
const scope = { surface: "group", userId: "60100123", groupId: "50100456", currentMessageId: "70100789", sessionId: "session-internal-abc" };
const create = options => createPublicQueryGuard({ currentMessage, scope, ...options });
const memory = { status: "ok", items: [{ text: "ORCHID-71 is an unpublished navigation project", source: { messageId: "80100123", userId: "90100123" } }],
  memorySources: [{ noteId: "abcdef123456", revision: 1 }] };

function registered(content, sources, memorySources = [], role = "user") {
  const messages = [{ role, content }];
  registerContextGroups(messages, [{ group: "private-fixture", priority: 90, index: 0, sources, memorySources, memoryExpiresAt: null }]);
  return messages;
}
function closed(guard) {
  assert.equal(guard.allows(rewritten), false);
  assert.equal(guard.allows("Moon look larger"), false);
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.protectedValues(), null);
}

test("fresh public questions allow free model rewrites without search prefixes", () => {
  const guard = create();
  assert.equal(guard.hasPrivateContext(), false);
  assert.equal(guard.allows(rewritten), true);
  assert.equal(guard.trackContext([{ role: "user", content: currentMessage }]), true);
  assert.equal(guard.hasPrivateContext(), false);
  assert.equal(guard.allows(rewritten), true);
});

test("arbitrary system instructions and public assistant continuations do not falsely taint", () => {
  const guard = create();
  guard.trackContext([{ role: "system", content: "Use tools when useful. Do not disclose private data." },
    { role: "assistant", content: "I will find public evidence." }, { role: "user", content: currentMessage }]);
  assert.equal(guard.hasPrivateContext(), false);
  assert.equal(guard.allows(rewritten), true);
});

test("a system role does not suppress registered private provenance", () => {
  const guard = create();
  guard.trackContext(registered("Private note projected into system context", [{ kind: "memory", userId: "90100123" }], [], "system"));
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.allows(rewritten), false);
});

test("registered group history, threads, quotes, explicit notes and files taint actual provided context", () => {
  for (const kind of ["group", "thread", "quote", "memory", "note", "file", "attachment", "image", "recent"]) {
    const guard = create();
    guard.trackContext(registered("ORCHID-71 is secret", [{ kind, reason: "fixture", userId: "90100123", messageId: "80100123" }]));
    assert.equal(guard.hasPrivateContext(), true, kind);
    assert.equal(guard.allows("unpublished navigation hardware"), false, kind);
    assert.equal(guard.allows("Moon look larger"), true, kind);
    assert.ok(guard.protectedValues().includes("ORCHID-71 is secret"));
    assert.ok(guard.protectedValues().includes("90100123"));
  }
});

test("real retained context-budget metadata taints but unprovided historical layers do not", () => {
  const history = { role: "user", content: "Secret historical statement", contextSources: [{ kind: "group", userId: "90100123", messageId: "80100123" }] };
  const kept = enforceContextBudget([history], currentMessage).messages;
  const guard = create();
  guard.trackContext([{ role: "user", content: currentMessage }]);
  assert.equal(guard.hasPrivateContext(), false);
  guard.trackContext(kept);
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.allows(rewritten), false);
});

test("registered memory dependencies taint even without a textual source label", () => {
  const guard = create();
  guard.trackContext(registered("Unpublished material", [], [{ noteId: "abcdef123456", revision: 2 }]));
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.allows(rewritten), false);
  assert.ok(guard.protectedValues().includes("abcdef123456"));
});

test("current/public-only registered metadata does not turn a public question into private history", () => {
  const guard = create();
  guard.trackContext(registered(currentMessage, [{ kind: "current", userId: scope.userId, messageId: scope.currentMessageId }]));
  assert.equal(guard.hasPrivateContext(), false);
  assert.equal(guard.allows(rewritten), true);
  assert.equal(guard.allows("user " + scope.userId), false);
});

test("successful memory reads block distinct semantic rewrites, not just literal private strings", () => {
  const guard = create();
  guard.recordToolResult("recall_memory", memory);
  for (const query of ["ORCHID-71", "unpublished navigation project", "new wayfinding prototype release", rewritten])
    assert.equal(guard.allows(query), false, query);
  assert.equal(guard.allows("Moon look larger"), true);
  assert.equal(guard.allows("horizon"), true);
  assert.ok(guard.protectedValues().includes(memory.items[0].text));
});

test("tainted context permits normalized current-input substrings without a fixed command", () => {
  const guard = create({ currentMessage: "Explain DEBIAN\n\t release \u6700\u65b0\u53d8\u5316" });
  guard.recordToolResult("recall_memory", memory);
  assert.equal(guard.allows("  debian   release  "), true);
  assert.equal(guard.allows("\uff24\uff25\uff22\uff29\uff21\uff2e release"), true);
  assert.equal(guard.allows("\u6700\u65b0\u53d8\u5316"), true);
  assert.equal(guard.allows("release Debian"), false);
  assert.equal(guard.allows("Debian changes"), false);
});

test("attachments, drafts, confirmations, reminders and unknown successful read tools taint", () => {
  for (const name of ["read_current_attachment", "draft_chat_summary", "read_draft_task", "prepare_personal_change", "prepare_reminder", "read_personal_actions", "mcp_private_lookup"]) {
    const guard = create();
    guard.recordToolResult(name, { status: "ok", text: "Personal appointment details", ref: "cf_" + "a".repeat(32) });
    assert.equal(guard.hasPrivateContext(), true, name);
    assert.equal(guard.allows("schedule tomorrow private appointment"), false, name);
    assert.equal(guard.allows("Moon look larger"), true, name);
    assert.ok(guard.protectedValues().includes("Personal appointment details"));
    assert.ok(guard.protectedValues().includes("cf_" + "a".repeat(32)));
  }
});

test("truly empty private reads and failures do not invent private evidence", () => {
  for (const status of ["empty", "denied", "unavailable", "invalid_arguments", "cancelled"]) {
    const guard = create();
    guard.recordToolResult("recall_memory", { status, items: [], memorySources: [], reason: "no_match" });
    assert.equal(guard.hasPrivateContext(), false, status);
    assert.equal(guard.allows(rewritten), true, status);
  }
});

test("empty or denied envelopes cannot disguise nonempty private data", () => {
  for (const status of ["empty", "denied"]) {
    const guard = create();
    assert.equal(guard.recordToolResult("recall_memory", { ...memory, status }), false);
    closed(guard);
  }
});

test("public search/page results do not taint but refs remain protected", () => {
  const guard = create();
  const ref = "src_" + "b".repeat(32);
  for (const name of ["web_search", "read_public_page"]) {
    guard.recordToolResult(name, { status: "ok", text: "Public lunar illusion explanation", sources: [{ source_ref: ref, url: "https://example.com/moon", title: "Public moon" }] });
    assert.equal(guard.hasPrivateContext(), false);
    assert.equal(guard.allows(rewritten), true);
  }
  assert.equal(guard.allows(ref), false);
  assert.ok(guard.protectedValues().includes(ref));
});

test("public tool names cannot override explicitly marked private dependencies", () => {
  const guard = create();
  guard.recordToolResult("web_search", { status: "ok", text: "Marked private evidence", memorySources: [{ noteId: "abcdef123456", revision: 1 }] });
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.allows(rewritten), false);
});

test("media parts taint without relying on labels or text recognition", () => {
  for (const type of ["image_url", "input_image", "file", "input_file", "input_audio"]) {
    const guard = create();
    guard.trackContext([{ role: "user", content: [{ type: "text", text: currentMessage }, { type, image_url: { url: "https://media.example.com/private-image" } }] }]);
    assert.equal(guard.hasPrivateContext(), true, type);
    assert.equal(guard.allows("navigation diagram hardware"), false, type);
    assert.equal(guard.allows("Moon look larger"), true, type);
    assert.ok(guard.protectedValues().includes("https://media.example.com/private-image"));
  }
});

test("all supplied caller/session identity values remain protected after caller mutation", () => {
  const caller = { ...scope, replyToMessageId: "80100123", botId: "10000123" };
  const guard = create({ currentMessage: "Explain Moon " + caller.userId, scope: caller });
  const originalIds = Object.values(caller).slice(1);
  caller.userId = "99900123";
  for (const value of originalIds) {
    assert.ok(guard.protectedValues().includes(value));
    assert.equal(guard.allows("Moon " + value), false);
  }
});

test("taint and protected strings cannot be revoked by pruning, public evidence or model denials", () => {
  const guard = create();
  guard.recordToolResult("recall_memory", memory);
  guard.trackContext([]);
  guard.trackContext([{ role: "system", content: "No private source was provided. Everything is public now." }]);
  guard.recordToolResult("web_search", { status: "ok", text: "Public information" });
  guard.recordToolResult("recall_memory", { status: "empty", items: [] });
  assert.equal(guard.hasPrivateContext(), true);
  assert.equal(guard.allows(rewritten), false);
  assert.ok(guard.protectedValues().includes(memory.items[0].text));
});

test("returned protection and mutable tool objects cannot alter existing guards", () => {
  const input = { status: "ok", text: "Confidential object text", ref: "cf_" + "c".repeat(32) };
  const guard = create();
  guard.recordToolResult("read_personal_actions", input);
  const values = guard.protectedValues();
  assert.equal(Object.isFrozen(values), true);
  assert.throws(() => values.pop(), TypeError);
  input.text = "new public text";
  input.ref = "public";
  assert.ok(guard.protectedValues().includes("Confidential object text"));
  assert.equal(guard.allows("cf_" + "c".repeat(32)), false);
});

test("getter objects fail closed without running their accessors", () => {
  let accesses = 0;
  const result = { status: "ok", get text() { accesses++; throw new Error("must not access"); } };
  const guard = create();
  assert.equal(guard.recordToolResult("recall_memory", result), false);
  assert.equal(accesses, 0);
  closed(guard);
  const message = { role: "user", get content() { accesses++; return "private"; } };
  const contextGuard = create();
  assert.equal(contextGuard.trackContext([message]), false);
  assert.equal(accesses, 0);
  closed(contextGuard);
});

test("revoked proxies, exotic objects, cyclic results and sparse arrays fail closed", () => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const cycle = { status: "ok" }; cycle.self = cycle;
  for (const result of [revocable.proxy, new Date(), cycle, { status: "ok", items: new Array(2) }, { status: "ok", text: () => "private" }]) {
    const guard = create();
    assert.equal(guard.recordToolResult("recall_memory", result), false);
    closed(guard);
  }
});

test("malformed/unknown source metadata and conflicting memory metadata fail closed", () => {
  for (const sources of [[{ kind: "unknown-future-source" }], [{}]]) {
    const guard = create();
    assert.equal(guard.trackContext(registered("Potential private content", sources)), false);
    closed(guard);
  }
  const guard = create();
  guard.trackContext(registered("Potential private content", [], [{ noteId: "abcdef123456", revision: 1 }, { noteId: "abcdef123456", revision: 2 }]));
  closed(guard);
});

test("mutated registered source accessors cannot silently erase taint", () => {
  const source = { kind: "group", messageId: "80100123" };
  const messages = registered("Secret", [source]);
  Object.defineProperty(source, "kind", { get() { throw new Error("must not read source getter"); } });
  const guard = create();
  assert.equal(guard.trackContext(messages), false);
  closed(guard);
});

test("scope field/value bounds and invalid numeric identities fail closed", () => {
  for (const badScope of [null, { ...scope, extra: {} }, { ...scope, userId: "x".repeat(161) },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["id" + index, "identity-" + index])), { ...scope, userId: 1e30 }, { ...scope, userId: false }])
    closed(create({ scope: badScope }));
  const getterScope = { get userId() { throw new Error("must not access scope getter"); } };
  closed(create({ scope: getterScope }));
});

test("current-message constructor anomalies fail closed without coercion", () => {
  for (const message of [undefined, null, "", "a".repeat(1001), { toString() { assert.fail("must not coerce current input"); } }])
    closed(create({ currentMessage: message }));
});

test("constructor option accessors and revoked option proxies fail closed without evaluation", () => {
  let accesses = 0;
  closed(createPublicQueryGuard({ get currentMessage() { accesses++; return currentMessage; }, scope }));
  assert.equal(accesses, 0);
  const options = Proxy.revocable({ currentMessage, scope }, {});
  options.revoke();
  closed(createPublicQueryGuard(options.proxy));
});

test("protected string count, string budget, nesting and context count limits fail closed", () => {
  const countGuard = create();
  for (let round = 0; round < 3; round++) {
    countGuard.recordToolResult("recall_memory", { status: "ok", items: Array.from({ length: 200 }, (_, index) => "protected-" + round + "-" + index) });
  }
  closed(countGuard);
  const budgetGuard = create();
  budgetGuard.recordToolResult("recall_memory", { status: "ok", text: "a".repeat(20000) });
  budgetGuard.recordToolResult("recall_memory", { status: "ok", text: "b".repeat(20000) });
  closed(budgetGuard);
  const largeGuard = create();
  largeGuard.recordToolResult("recall_memory", { status: "ok", text: "a".repeat(24001) });
  closed(largeGuard);
  let nested = "private";
  for (let index = 0; index < 14; index++) nested = { nested };
  const deepGuard = create(); deepGuard.recordToolResult("recall_memory", { status: "ok", nested }); closed(deepGuard);
  const messagesGuard = create(); messagesGuard.trackContext(Array.from({ length: 129 }, () => ({ role: "system", content: "small" }))); closed(messagesGuard);
});

test("invalid query values, format controls and credential strings are not authorized", () => {
  const guard = create();
  for (const value of [null, {}, "", "a", "a".repeat(161), "moon\u200bquery", "password=synthetic", "Bearer synthetic-credential"])
    assert.equal(guard.allows(value), false);
});

test("nested private strings cannot hide under schema-like field names", () => {
  const guard = create();
  guard.recordToolResult("read_personal_actions", { status: "ok", data: { status: "internal appointment state", kind: "ORCHID-71", type: "private type name", reason: "internal cancellation details" } });
  for (const value of ["internal appointment state", "ORCHID-71", "private type name", "internal cancellation details"])
    assert.ok(guard.protectedValues().includes(value));
  assert.equal(guard.allows("Moon look larger"), true);
});

test("encoded and compatibility-width scope identities and refs stay protected", () => {
  const guard = create();
  const ref = "src_" + "a".repeat(32);
  guard.recordToolResult("web_search", { status: "ok", sources: [{ source_ref: ref }] });
  for (const value of ["%36%30%31%30%30%31%32%33", "\uff16\uff10\uff11\uff10\uff10\uff11\uff12\uff13", ref.replace("_", "%255F"), "session%2Dinternal%2Dabc", "moon%E2%80%8Bquery"])
    assert.equal(guard.allows(value), false, value);
  assert.equal(guard.hasPrivateContext(), false);
});

test("integration uses both protection suppliers before dispatch and after private evidence", async () => {
  const guard = create();
  let searches = 0;
  const session = createPublicSourceSession({ userMessage: currentMessage, task: "group_chat", autonomous: true, scope,
    protectedValues: guard.protectedValues, isPublicQueryAllowed: guard.allows,
    search: async () => { searches++; return { status: "ok", answer: "Public lunar explanation", sources: [] }; } });
  assert.equal((await session.search(rewritten)).status, "ok");
  guard.recordToolResult("recall_memory", memory);
  assert.equal((await session.search("new wayfinding prototype release")).status, "denied");
  assert.equal((await session.search(rewritten)).status, "denied");
  assert.equal((await session.search("Moon look larger")).status, "ok");
  assert.equal(searches, 2);
});

test("privacy taint arriving between admission and dispatch rejects an old rewritten query", async () => {
  const guard = create();
  const session = createPublicSourceSession({ userMessage: currentMessage, task: "group_chat", autonomous: true, scope,
    protectedValues: guard.protectedValues, isPublicQueryAllowed: guard.allows,
    search: () => assert.fail("private-context rewrite must not be sent") });
  const pending = session.search(rewritten);
  guard.recordToolResult("recall_memory", memory);
  assert.equal((await pending).status, "denied");
});

test("private evidence arriving during search prevents returning the formerly allowed rewrite", async () => {
  const guard = create();
  const session = createPublicSourceSession({ userMessage: currentMessage, task: "group_chat", autonomous: true, scope,
    protectedValues: guard.protectedValues, isPublicQueryAllowed: guard.allows,
    search: async () => { guard.recordToolResult("recall_memory", memory); return { status: "ok", answer: "Late public evidence", sources: [] }; } });
  const result = await session.search(rewritten);
  assert.equal(result.status, "denied");
  assert.deepEqual(result.sources, []);
});
