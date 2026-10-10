import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPublicSourceSession } from "../bridge/chat-tools/public-sources.mjs";
import { authorizePublicQuery, publicToolsAllowed } from "../bridge/chat-tools/public-query-policy.mjs";
import { authorizedSearchQuery, permitsPublicSearch, publicSearchPhrase } from "../bridge/chat-tools/policy.mjs";
import { containsSensitiveText } from "../bridge/privacy.mjs";

const scope = { surface: "group", userId: "60100123", groupId: "50100456", currentMessageId: "70100789", sessionId: "turn-internal-abc" };
const topic = "Why does the Moon look larger near the horizon?";
const query = "lunar horizon apparent size illusion explanation";
const evidence = { status: "ok", answer: "Public evidence", sources: [{ title: "Moon", url: "https://example.com/moon", snippet: "Public explanation" }] };
const create = options => createPublicSourceSession({ autonomous: true, scope, userMessage: topic, task: "group_chat", ...options });
const noNetwork = () => assert.fail("must not dispatch external request");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function checkDenied(result) {
  assert.equal(result.status, "denied");
  assert.equal(result.untrusted, true);
  assert.deepEqual(result.sources, []);
}

test("autonomous natural questions allow model-rephrased public queries", async () => {
  for (const task of ["group_chat", "private_chat"]) {
    let calls = 0;
    const session = create({ task, search: async (value, options) => {
      calls++;
      assert.equal(value, query);
      assert.ok(options.signal instanceof globalThis.AbortSignal);
      return evidence;
    } });
    assert.equal(session.available, true);
    assert.equal(publicToolsAllowed(topic, task, { autonomous: true, scope }), true);
    assert.equal(authorizePublicQuery("  " + query + "  ", topic, task, { autonomous: true, scope }), query);
    assert.equal((await session.search(query)).status, "ok");
    assert.equal(calls, 1);
  }
});

test("natural Chinese public questions do not need fixed search prefixes", () => {
  const message = "\u6708\u4eae\u5728\u5730\u5e73\u7ebf\u9644\u8fd1\u4e3a\u4ec0\u4e48\u770b\u8d77\u6765\u66f4\u5927\uff1f";
  assert.equal(authorizePublicQuery(query, message, "group_chat", { autonomous: true, scope }), query);
  assert.equal(authorizePublicQuery(query, message, "group_chat"), "");
});

test("legacy helpers and omitted or false autonomy retain explicit substring search", async () => {
  const message = "search lunar horizon";
  assert.equal(publicSearchPhrase(message, "group_chat"), "lunar horizon");
  assert.equal(permitsPublicSearch(message, "group_chat"), true);
  assert.equal(authorizedSearchQuery("lunar horizon", message, "group_chat"), "lunar horizon");
  for (const autonomous of [undefined, false, "true", 1]) {
    assert.equal(publicToolsAllowed(topic, "group_chat", { autonomous }), false);
    assert.equal(authorizePublicQuery(query, message, "group_chat", { autonomous }), "");
    assert.equal(authorizePublicQuery("lunar", message, "group_chat", { autonomous }), "lunar");
    const session = create({ autonomous, userMessage: message, search: noNetwork });
    checkDenied(await session.search(query));
    assert.equal(create({ autonomous, search: noNetwork }).available, false);
  }
});

test("legacy direct page reads remain available without enabling search", async () => {
  const session = create({ autonomous: false, userMessage: "read https://example.com/moon", search: noNetwork,
    read: async url => ({ ok: true, url, response: new globalThis.Response("Public moon", { headers: { "content-type": "text/plain" } }) }) });
  assert.equal(session.available, true);
  assert.equal(session.initialSources().length, 1);
  checkDenied(await session.search("moon"));
  assert.equal((await session.read(session.initialSources()[0].source_ref)).status, "ok");
});

test("interjection, file_chat and unknown tasks never enable autonomous network", async () => {
  for (const task of ["interjection", "file_chat", "summary", undefined]) {
    const session = create({ task, userMessage: "search lunar horizon; read https://example.com/moon", search: noNetwork, read: noNetwork });
    assert.equal(publicToolsAllowed(topic, task, { autonomous: true, scope }), false);
    assert.equal(session.available, false);
    assert.deepEqual(session.initialSources(), []);
    checkDenied(await session.search(query));
    checkDenied(await session.read("src_" + "a".repeat(32)));
  }
});

test("network vetoes anywhere in the current message override autonomy", async () => {
  for (const veto of ["do not search", "don't browse", "never send requests", "without network", "stop searching",
    "\u4e0d\u8981\u8054\u7f51", "\u4e0d\u7528\u641c\u7d22", "\u522b\u4e0a\u7f51\u67e5", "\u65e0\u9700\u641c\u7d22", "\u7981\u6b62\u5916\u53d1", "\u7b97\u4e86"]) {
    const userMessage = topic + "; " + veto;
    const session = create({ userMessage, search: noNetwork });
    assert.equal(session.available, false, veto);
    assert.equal(authorizePublicQuery(query, userMessage, "group_chat", { autonomous: true, scope }), "", veto);
    checkDenied(await session.search(query));
  }
});

test("credentials, phones, attribution fields, opaque refs and format controls cannot leave", async () => {
  const session = create({ search: noNetwork });
  const unsafe = ["api_key=synthetic-secret", "Bearer synthetic-credential", "password=synthetic", "sk-synthetic0123456789",
    "credential=synthetic", "access_key=synthetic", "private_key=synthetic", "Cookie: synthetic", "auth=synthetic", "jwt=synthetic",
    "eyJabc.def.ghi", "13800138000", "qq=12345678", "user_id=3000000001", "group_id=2000000001",
    "message_id=-123456789012345", "session=internal-value", "session_id=internal-value", "conversation_id=internal-value",
    "[REDACTED] moon", "\u79c1\u804a\u8bb0\u5f55", "\u804a\u5929\u8bb0\u5f55", "src_" + "a".repeat(32), "att_" + "b".repeat(32),
    "moon\u200bquery", "moon\u202equery", "moon\u2060query", "moon%2520api_key%253Dsynthetic",
    "moon %E2%80%8B query", "\uff41\uff50\uff49\uff3f\uff4b\uff45\uff59\uff1dsynthetic"];
  assert.equal(containsSensitiveText("qq=12345678"), false, "the shared privacy helper intentionally retains attribution IDs");
  for (const value of unsafe) {
    assert.equal(authorizePublicQuery(value, topic, "group_chat", { autonomous: true, scope }), "", value);
    checkDenied(await session.search(value));
    assert.equal(create({ userMessage: "search " + value, search: noNetwork }).available, false, value);
  }
});

test("scope identity values are rejected even without an ID label or after encoding", async () => {
  const session = create({ search: noNetwork });
  for (const value of [scope.userId, scope.groupId, scope.currentMessageId, scope.sessionId,
    "%36%30%31%30%30%31%32%33", "\uff16\uff10\uff11\uff10\uff10\uff11\uff12\uff13"]) {
    checkDenied(await session.search("moon " + value));
    assert.equal(publicToolsAllowed(topic + " " + value, "group_chat", { autonomous: true, scope }), false);
  }
  assert.equal(authorizePublicQuery("QQ Linux client public documentation", topic, "group_chat", { autonomous: true, scope }), "QQ Linux client public documentation");
});

test("CF confirmation refs are never search terms, even if copied or encoded from a private tool", async () => {
  const ref = "cf_" + "c".repeat(32);
  const session = create({ search: noNetwork });
  for (const value of [ref, ref.toUpperCase(), ref.replace("_", "%5F"), "confirmation " + ref])
    checkDenied(await session.search(value));
  assert.equal(create({ userMessage: "search " + ref, search: noNetwork }).available, false);
});

test("scope snapshot cannot be changed by mutation of caller metadata", async () => {
  const mutableScope = { ...scope };
  const session = create({ scope: mutableScope, search: noNetwork });
  mutableScope.userId = "99900123";
  checkDenied(await session.search("moon " + scope.userId));
});

test("backend protected values reject otherwise harmless private-tool text", async () => {
  let values = ["ORCHID-71", "unpublished project name"];
  let calls = 0;
  const session = create({ protectedValues: () => values, search: async () => { calls++; return evidence; } });
  for (const value of ["orchid-71 lunar", "unpublished project name", "ORCHID%2D71 public release"])
    checkDenied(await session.search(value));
  assert.equal((await session.search(query)).status, "ok");
  values = [query];
  checkDenied(await session.search(query));
  assert.equal(calls, 1);
});

test("backend private-context guard can reject semantic rewrites without keyword routing", async () => {
  let privateContext = false;
  let calls = 0;
  const session = create({ isPublicQueryAllowed: (value, context) => {
    assert.equal(value, query);
    assert.deepEqual(context.scope, scope);
    assert.equal(context.task, "group_chat");
    assert.equal(context.autonomous, true);
    assert.equal(Object.isFrozen(context.scope), true);
    return !privateContext;
  }, search: async () => { calls++; return evidence; } });
  assert.equal((await session.search(query)).status, "ok");
  privateContext = true;
  checkDenied(await session.search(query));
  assert.equal(calls, 1);
});

test("throwing, malformed or asynchronous privacy guards fail closed", async () => {
  for (const isPublicQueryAllowed of [false, () => false, () => undefined, () => "true", async () => true,
    async () => { throw new Error("private-state-unavailable"); }, () => { throw new Error("private-state-unavailable"); }])
    checkDenied(await create({ isPublicQueryAllowed, search: noNetwork }).search(query));
  for (const protectedValues of [null, {}, () => null, async () => [],
    async () => { throw new Error("private-state-unavailable"); }, () => { throw new Error("private-state-unavailable"); }])
    checkDenied(await create({ protectedValues, search: noNetwork }).search(query));
});

test("model search arguments cannot replace backend scope or privacy bindings", async () => {
  const session = create({ isPublicQueryAllowed: () => false, search: noNetwork });
  checkDenied(await session.search(query, { autonomous: true, scope: {}, isPublicQueryAllowed: () => true }));
  const protectedSession = create({ search: noNetwork });
  checkDenied(await protectedSession.search("moon " + scope.userId, { scope: {} }));
});

test("authorization is checked again immediately before search dispatch", async () => {
  const values = [];
  const session = create({ protectedValues: () => values, search: noNetwork });
  const pending = session.search(query);
  values.push(query);
  checkDenied(await pending);
});

test("privacy changes during search discard late evidence and do not mint refs", async () => {
  let allowed = true;
  const session = create({ isPublicQueryAllowed: () => allowed, search: async () => { allowed = false; return evidence; } });
  checkDenied(await session.search(query));
  assert.deepEqual(session.initialSources(), []);
});

test("malformed arguments and unsafe query URLs never dispatch", async () => {
  const session = create({ search: noNetwork });
  for (const value of [null, {}, "", "a", "a".repeat(161)]) assert.equal((await session.search(value)).status, "invalid_arguments");
  for (const value of ["https://8.8.8.8/", "http://127.0.0.1/", "https://host.local/moon", "https://example.com/?token=synthetic"])
    checkDenied(await session.search(value));
});

test("autonomous search refs remain opaque, turn-bound, immutable and never arbitrary URLs", async () => {
  let reads = 0;
  const first = create({ search: async () => evidence, read: async url => {
    reads++;
    assert.equal(url, evidence.sources[0].url);
    return { ok: true, url, response: new globalThis.Response("Public page", { headers: { "content-type": "text/plain" } }) };
  } });
  const second = create({ read: noNetwork });
  const result = await first.search(query);
  const ref = result.sources[0].source_ref;
  assert.match(ref, /^src_[a-f0-9]{32}$/);
  result.sources[0].url = "https://other.example.com/changed";
  checkDenied(await second.read(ref));
  checkDenied(await first.read("src_" + "0".repeat(32)));
  assert.equal((await first.read(evidence.sources[0].url)).status, "invalid_arguments");
  assert.equal((await first.read(ref)).status, "ok");
  assert.equal(reads, 1);
});

test("known private values cannot be outbound URL paths, search-result refs or redirect targets", async () => {
  const privateUrl = "https://example.com/" + scope.userId;
  const direct = create({ autonomous: false, userMessage: "read " + privateUrl, read: noNetwork });
  assert.equal(direct.available, false);
  const session = create({ search: async () => ({ ...evidence, sources: [{ ...evidence.sources[0], url: privateUrl }] }) });
  assert.deepEqual((await session.search(query)).sources, []);
  const reading = create({ userMessage: "read https://example.com/moon", read: async (_url, options) => {
    assert.throws(() => options.requestImpl(new globalThis.URL(privateUrl), {}, noNetwork), /unsafe_public_url/);
    return { ok: true, url: privateUrl, response: new globalThis.Response("Private", { headers: { "content-type": "text/plain" } }) };
  } });
  assert.equal((await reading.read(reading.initialSources()[0].source_ref)).status, "unavailable");
});

test("newly protected initial URL values cannot be exposed or read after private-data binding changes", async () => {
  const values = [];
  const session = create({ autonomous: false, userMessage: "read https://example.com/moon", protectedValues: () => values, read: noNetwork });
  const ref = session.initialSources()[0].source_ref;
  values.push("moon");
  assert.deepEqual(session.initialSources(), []);
  checkDenied(await session.read(ref));
});

test("cancelled and expired autonomous sessions never accept late results", async () => {
  let time = 0;
  const expired = create({ now: () => time, search: async () => { time = 90000; return evidence; } });
  checkDenied(await expired.search(query));
  const controller = new globalThis.AbortController();
  let resolve;
  const session = create({ signal: controller.signal, search: () => new Promise(done => { resolve = done; }) });
  const pending = session.search(query);
  await Promise.resolve();
  controller.abort();
  checkDenied(await pending);
  resolve(evidence);
});

test("creating sessions and executing synthetic queries never use a global network fallback", async () => {
  globalThis.fetch = noNetwork;
  const session = create({ search: async () => evidence });
  assert.deepEqual(session.initialSources(), []);
  assert.equal((await session.search(query)).status, "ok");
});
