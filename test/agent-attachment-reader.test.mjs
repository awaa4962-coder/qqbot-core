import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachmentReader } from "../bridge/chat-tools/attachment-reader.mjs";

const REF = "att_synthetic_1";
const args = extra => ({ attachment_ref: REF, ...extra });
const body = count => Array.from({ length: count }, (_value, index) => `line ${index + 1}`).join("\n");
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// The A-module contract is injected: no configuration, network, QQ, storage or A-module import.
function fixture({ text = body(50), evidence, fetchEvidence, descriptor = {}, file = {}, signal, assertCurrent } = {}) {
  const state = { current: true, allowed: true, calls: [], checks: 0 };
  const entry = { status: "ok", file: { name: "notes.txt", url: "https://example.com/synthetic.txt", ...file },
    descriptor: { attachment_ref: REF, name: "notes.txt", type: "txt", bytes: null, status: "not_read", ...descriptor },
    binding: { scope: { surface: "group_chat", userId: "12345678", groupId: "87654321" },
      messageId: "11223344", expiresAt: Date.now() + 90000 } };
  const references = {
    resolve: ref => state.allowed && ref === REF ? entry : { status: "denied" },
    assertCurrent: () => { state.checks++; if (!state.current || Date.now() >= entry.binding.expiresAt) throw new Error("synthetic privacy change"); },
    expiry: () => entry.binding.expiresAt,
  };
  const reader = createAttachmentReader({ references, signal, assertCurrent,
    fetchEvidence: async (metadata, options) => {
      state.calls.push({ metadata, options });
      return fetchEvidence ? fetchEvidence(metadata, options) : evidence || { status: "ok", text };
    } });
  return { reader, state, entry, references };
}

function bounded(result, status = "ok") {
  assert.equal(result.status, status);
  assert.deepEqual(Object.keys(result).sort(), ["attachment_ref", "coverage", "name", "status", "text"]);
  assert.deepEqual(Object.keys(result.coverage).sort(),
    ["fromLine", "remaining", "selection", "sourceComplete", "toLine", "totalLines", "truncated"]);
  assert.ok(JSON.stringify(result).length <= 1800);
  return result;
}

test("construction is lazy; unknown references cannot fetch or expose metadata", async () => {
  const { reader, state } = fixture();
  assert.equal(state.calls.length, 0);
  const result = bounded(await reader.read({ attachment_ref: "unknown" }), "denied");
  assert.equal(state.calls.length, 0);
  assert.equal(result.attachment_ref, "");
  assert.equal(result.name, "");
  assert.equal(result.coverage.sourceComplete, false);
});

test("default head is 20 lines with honest full-source and unread coverage", async () => {
  const { reader, state, entry } = fixture();
  const result = bounded(await reader.read(args()));
  assert.equal(result.text, body(20));
  assert.deepEqual(result.coverage, { sourceComplete: true, totalLines: 50, fromLine: 1,
    toLine: 20, selection: "head", truncated: true, remaining: 30 });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].metadata, entry.file);
  assert.deepEqual(Object.keys(state.calls[0].options), ["signal"]);
  assert.ok(state.checks >= 8);
});

test("inclusive range accepts 40 lines, clamps EOF, and reuses one download", async () => {
  const { reader, state } = fixture();
  const result = bounded(await reader.read(args({ start_line: 5, end_line: 44 })));
  assert.equal(result.text, body(50).split("\n").slice(4, 44).join("\n"));
  assert.deepEqual(result.coverage, { sourceComplete: true, totalLines: 50, fromLine: 5,
    toLine: 44, selection: "range", truncated: true, remaining: 10 });
  const eof = bounded(await reader.read(args({ start_line: 45, end_line: 60 })));
  assert.equal(eof.coverage.toLine, 50);
  assert.equal(eof.coverage.remaining, 44);
  const empty = bounded(await reader.read(args({ start_line: 51, end_line: 55 })), "empty");
  assert.equal(empty.text, "");
  assert.equal(empty.coverage.fromLine, 0);
  assert.equal(empty.coverage.toLine, 0);
  assert.equal(empty.coverage.remaining, 50);
  assert.equal(state.calls.length, 1);
});

test("query is literal, case-insensitive, first-match only with minimal context", async () => {
  const text = "before\nnear\nNEEDLE [a.*]\nafter\nfar\nneedle [a.*]\nend";
  const { reader, state } = fixture({ text });
  const result = bounded(await reader.read(args({ query: "needle [a.*]" })));
  assert.equal(result.text, "near\nNEEDLE [a.*]\nafter");
  assert.deepEqual(result.coverage, { sourceComplete: true, totalLines: 7, fromLine: 2,
    toLine: 4, selection: "query", truncated: true, remaining: 4 });
  const miss = bounded(await reader.read(args({ query: "not found" })), "empty");
  assert.equal(miss.text, "");
  assert.equal(miss.coverage.remaining, 7);
  assert.equal(state.calls.length, 1);
});

test("oversized query context and distant line offsets cannot hide the match", async () => {
  for (const text of ["before ".repeat(600) + "\nneedle\nafter",
    "prefix ".repeat(900) + "needle" + " suffix".repeat(100),
    "\u0130".repeat(1500) + "needle" + "\ud83d\ude00".repeat(100)]) {
    const { reader } = fixture({ text });
    const result = bounded(await reader.read(args({ query: "NEEDLE" })));
    assert.match(result.text, /needle/);
    assert.equal(result.coverage.selection, "query");
    assert.equal(result.coverage.truncated, true);
    assert.ok(result.coverage.remaining >= 1);
    assert.doesNotMatch(result.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  }
});

test("query snippet keeps a 160-character match under worst JSON escaping", async () => {
  const query = "\u0000".repeat(160);
  const { reader } = fixture({ text: "before ".repeat(400) + query + " after".repeat(400),
    descriptor: { name: "\"\\".repeat(40) } });
  const result = bounded(await reader.read(args({ query })));
  assert.ok(result.text.includes(query));
  assert.equal(result.coverage.remaining, 1);
});

test("invalid fields, lengths and ranges never resolve or download", async () => {
  const { reader, state } = fixture();
  const invalid = [null, [], "text", {}, args({ path: "/etc/passwd" }), args({ url: "https://example.com" }),
    args({ limit: 20 }), args({ query: "x", start_line: 1, end_line: 2 }), args({ query: "" }),
    args({ query: " " }), args({ query: "x".repeat(161) }), args({ query: 1 }),
    args({ start_line: 1 }), args({ end_line: 20 }), args({ start_line: 0, end_line: 1 }),
    args({ start_line: -1, end_line: 1 }), args({ start_line: 4, end_line: 3 }),
    args({ start_line: 1.5, end_line: 2 }), args({ start_line: "1", end_line: 2 }),
    args({ start_line: 1, end_line: 41 }), args({ start_line: 1, end_line: Infinity }),
    args({ start_line: 1, end_line: Number.MAX_SAFE_INTEGER + 1 }),
    { attachment_ref: "a".repeat(97) }, { attachment_ref: "https://example.com" },
    { attachment_ref: "../file" }, args({ [Symbol("extra")]: "hidden" })];
  for (const input of invalid) bounded(await reader.read(input), "invalid_arguments");
  assert.equal(state.calls.length, 0);
  assert.equal(state.checks, 0);
});

test("160-character query is accepted and no-hit remains honest", async () => {
  const { reader } = fixture();
  bounded(await reader.read(args({ query: "x".repeat(160) })), "empty");
});

test("unsupported formats remain explicit and safe-service failures are not echoed", async () => {
  for (const name of ["notes.pdf", "notes.docx"]) {
    const { reader, state } = fixture({ file: { name }, descriptor: { name },
      evidence: { status: "unsupported", reason: "unsupported_type" } });
    const result = bounded(await reader.read(args()), "unavailable");
    assert.equal(result.text, "unsupported_format");
    assert.equal(state.calls[0].metadata.name, name);
  }
  for (const url of ["http://127.0.0.1/private", "file:///etc/passwd", "https://example.com/redirect-to-private"]) {
    const { reader, state } = fixture({ file: { url }, fetchEvidence: async metadata => {
      assert.equal(metadata.url, url);
      return { status: "unavailable", reason: `SSRF rejected ${url} token=synthetic-secret` };
    } });
    const result = bounded(await reader.read(args()), "unavailable");
    assert.equal(state.calls.length, 1);
    assert.equal(result.text, "read_failed");
    assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|file:|https:|synthetic-secret|SSRF/);
  }
});

test("reported sizes over 10000 reject before service access", async () => {
  for (const configuration of [{ descriptor: { bytes: 10001 } }, { file: { size: "10001" } },
    { file: { file_size: 10001 } }, { file: { fileSize: 10001 } }, { file: { bytes: 10001 } }]) {
    const { reader, state } = fixture(configuration);
    const result = bounded(await reader.read(args()), "unavailable");
    assert.equal(result.text, "size_limit");
    assert.equal(result.coverage.sourceComplete, false);
    assert.equal(state.calls.length, 0);
  }
});

test("actual UTF-8 bytes are checked, not reported size or character count", async () => {
  for (const text of ["a".repeat(10001), "\u4e2d".repeat(3334)]) {
    const { reader } = fixture({ text, descriptor: { bytes: 1 } });
    const result = bounded(await reader.read(args()), "unavailable");
    assert.equal(result.text, "size_limit");
  }
  const { reader } = fixture({ text: "a".repeat(10000), descriptor: { bytes: 10000 } });
  const result = bounded(await reader.read(args()));
  assert.equal(result.coverage.sourceComplete, true);
  assert.equal(result.coverage.remaining, 1);
});

test("secrets, URLs, IDs and filenames are filtered before memo or selection", async () => {
  const secret = "sk-syntheticsecret123";
  const text = `api_key=${secret}\npassword=private-value\nBearer synthetic-token-123\n` +
    "qq=12345678 group_id=87654321 message_id=-11223344\nhttps://example.com/private?token=secret\npublic";
  const { reader, state } = fixture({ text, descriptor: { name: "C:\\private\\password=hidden.txt" } });
  const first = bounded(await reader.read(args()));
  assert.match(first.text, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(first), /syntheticsecret|private-value|synthetic-token|12345678|87654321|11223344|https:|hidden|C:\\|binding/);
  const secretSearch = bounded(await reader.read(args({ query: secret })), "empty");
  assert.equal(secretSearch.text, "");
  const visible = bounded(await reader.read(args({ query: "public" })));
  assert.match(visible.text, /public/);
  assert.equal(state.calls.length, 1);
});

const basicCredential = "c3ludGhldGljOnNlY3JldA==";
const digestRecord = 'Digest username="SYN_R2_USER", realm="SYN_R2_REALM", nonce="SYN_R2_NONCE", ' +
  'uri="/private/auth", response="SYN_R2_RESPONSE", cnonce="SYN_R2_CNONCE", opaque="SYN_R2_OPAQUE", qop=auth, nc=00000001';
const digestSecrets = ["SYN_R2_USER", "SYN_R2_REALM", "SYN_R2_NONCE", "/private/auth", "SYN_R2_RESPONSE",
  "SYN_R2_CNONCE", "SYN_R2_OPAQUE", "00000001"];
const fullwidthAuthentication = value => value.replace(/[!-~]/g, point => String.fromCharCode(point.charCodeAt(0) + 0xfee0));
for (const [label, record, secrets] of [
  ["standalone Basic", "Basic " + basicCredential, [basicCredential]],
  ["short padded Basic", "Basic Og==", ["Og=="]],
  ["Basic complete field", "Authorization=Basic " + basicCredential + ", extra=SYN_R2_BASIC_TAIL", [basicCredential, "SYN_R2_BASIC_TAIL"]],
  ["Digest complete field", "Proxy-Authorization: " + digestRecord, digestSecrets],
  ["standalone Digest", digestRecord, digestSecrets],
  ["obfuscated Digest", "Autho\u200brization: " + digestRecord.replace("Digest", "Di\u2060gest"), digestSecrets],
  ["fullwidth Basic", fullwidthAuthentication("Basic " + basicCredential), [basicCredential]],
  ["folded Digest", 'Authorization: Digest username="SYN_R2_USER",\r\n  realm="SYN_R2_REALM", nonce="SYN_R2_NONCE", response="SYN_R2_RESPONSE"',
    ["SYN_R2_USER", "SYN_R2_REALM", "SYN_R2_NONCE", "SYN_R2_RESPONSE"]],
]) {
  test(`R2 complete authentication redaction protects head, query, cache and wire: ${label}`, async () => {
    const text = `before\r\n${record}\r\npublic`;
    const totalLines = text.split(/\r\n?/).length;
    const { reader, state } = fixture({ text });
    const head = bounded(await reader.read(args()));
    assert.match(head.text, /\[REDACTED\]/);
    assert.deepEqual(head.coverage, { sourceComplete: true, totalLines, fromLine: 1,
      toLine: totalLines, selection: "head", truncated: false, remaining: 0 });
    const query = bounded(await reader.read(args({ query: "public" })));
    const cached = bounded(await reader.read(args()));
    assert.deepEqual(cached, head);
    for (const result of [head, query, cached]) {
      const wire = JSON.stringify(result);
      const fallback = "read_current_attachment\n" + wire;
      for (const secret of secrets) {
        assert.ok(!wire.includes(secret), label + " leaked " + secret);
        assert.ok(!fallback.includes(secret), label + " leaked into fallback");
      }
      assert.doesNotMatch(result.text, /\p{Cf}|[\uff01-\uff5e]/u);
    }
    const miss = bounded(await reader.read(args({ query: secrets[0] })), "empty");
    assert.equal(miss.text, "");
    assert.equal(miss.coverage.remaining, totalLines);
    assert.equal(state.calls.length, 1);
  });
}

test("R2 authentication filtering preserves explicit range coverage across folded fields", async () => {
  const { reader } = fixture({ text: 'first\r\nAuthorization: Digest username="SYN_R2_USER",\r\n' +
    '  realm="SYN_R2_REALM", response="SYN_R2_RESPONSE"\r\nlast' });
  const range = bounded(await reader.read(args({ start_line: 2, end_line: 3 })));
  assert.equal(range.text, "Authorization: [REDACTED]\n[REDACTED]");
  assert.deepEqual(range.coverage, { sourceComplete: true, totalLines: 4, fromLine: 2,
    toLine: 3, selection: "range", truncated: true, remaining: 2 });
});

for (const [label, field] of [["zero-width", "api_\u200bkey"],
  ["full-width", "\uff41\uff50\uff49\uff3f\uff4b\uff45\uff59"],
  ["mixed formats", "api_\u200c\u2060\ufeffkey"]]) {
  test(`R1 secret normalization protects head, query and cached text: ${label}`, async () => {
    const secret = "SYNTHETIC_R1_SECRET";
    const { reader, state } = fixture({ text: `before\r\n${field}=${secret}\r\npublic` });
    const head = bounded(await reader.read(args()));
    assert.equal(head.text, "before\napi_key=[REDACTED]\npublic");
    assert.deepEqual(head.coverage, { sourceComplete: true, totalLines: 3, fromLine: 1,
      toLine: 3, selection: "head", truncated: false, remaining: 0 });
    const query = bounded(await reader.read(args({ query: "api_key" })));
    assert.equal(query.text, head.text);
    const cached = bounded(await reader.read(args()));
    assert.deepEqual(cached, head);
    for (const result of [head, query, cached]) {
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.doesNotMatch(result.text, /\p{Cf}|[\uff01-\uff5e]/u);
    }
    const miss = bounded(await reader.read(args({ query: secret })), "empty");
    assert.equal(miss.text, "");
    assert.equal(miss.coverage.remaining, 3);
    assert.equal(state.calls.length, 1);
  });
}

for (const [label, path, quote] of [["quoted POSIX", "/home/private/.ssh/id_rsa", "'"],
  ["bare POSIX", "/home/private/.ssh/id_rsa", ""],
  ["Windows backslash", String.raw`C:\Users\private\.ssh\id_rsa`, '"'],
  ["Windows slash", "C:/Users/private/.ssh/id_rsa", ""],
  ["UNC", String.raw`\\private-server\share\id_rsa`, '"'],
  ["POSIX spaces", "/home/private folder/id_rsa", '"'],
  ["Windows spaces", String.raw`C:\Users\private folder\id_rsa`, '"'],
  ["JSON-escaped Windows", String.raw`C:\\Users\\private\\.ssh\\id_rsa`, '"']]) {
  test(`R1 body path redaction protects head, query and cached text: ${label}`, async () => {
    const { reader, state } = fixture({ text: `before\nlocal_path=${quote}${path}${quote}\npublic` });
    const head = bounded(await reader.read(args()));
    assert.equal(head.text, `before\nlocal_path=${quote}[REDACTED]${quote}\npublic`);
    assert.deepEqual(head.coverage, { sourceComplete: true, totalLines: 3, fromLine: 1,
      toLine: 3, selection: "head", truncated: false, remaining: 0 });
    const query = bounded(await reader.read(args({ query: "local_path" })));
    assert.equal(query.text, head.text);
    const cached = bounded(await reader.read(args()));
    assert.deepEqual(cached, head);
    for (const result of [head, query, cached]) assert.ok(!result.text.includes(path));
    const miss = bounded(await reader.read(args({ query: path })), "empty");
    assert.equal(miss.text, "");
    assert.equal(miss.coverage.remaining, 3);
    assert.equal(state.calls.length, 1);
  });
}

test("R1 filtering preserves line range coordinates and ordinary relative text", async () => {
  const { reader } = fixture({ text: "first\r\napi_\u200bkey=SYNTHETIC_R1_SECRET\r\n" +
    "local_path='/home/private/.ssh/id_rsa'\r\ndocs/readme.txt\r\nlast" });
  const range = bounded(await reader.read(args({ start_line: 2, end_line: 4 })));
  assert.equal(range.text, "api_key=[REDACTED]\nlocal_path='[REDACTED]'\ndocs/readme.txt");
  assert.deepEqual(range.coverage, { sourceComplete: true, totalLines: 5, fromLine: 2,
    toLine: 4, selection: "range", truncated: true, remaining: 2 });
});

test("redaction expansion cannot produce a memo larger than 10KB", async () => {
  const { reader } = fixture({ text: "token=x\n".repeat(900) });
  const result = bounded(await reader.read(args()), "unavailable");
  assert.equal(result.text, "size_limit");
});

test("JSON budget accounts for escaping and marks partial lines unread", async () => {
  for (const text of ["\"\\\t".repeat(2000), "\ud83d\ude00".repeat(2000), body(45)]) {
    const { reader } = fixture({ text });
    const result = bounded(await reader.read(args()));
    assert.equal(result.coverage.sourceComplete, true);
    assert.equal(result.coverage.truncated, true);
    assert.ok(result.coverage.remaining > 0);
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/u);
  }
});

test("short, CRLF and empty sources have accurate complete coverage", async () => {
  const { reader } = fixture({ text: "one\r\ntwo\rthree" });
  const result = bounded(await reader.read(args()));
  assert.equal(result.text, "one\ntwo\nthree");
  assert.deepEqual(result.coverage, { sourceComplete: true, totalLines: 3, fromLine: 1,
    toLine: 3, selection: "head", truncated: false, remaining: 0 });
  for (const evidence of [{ status: "ok", text: "" }, { status: "unavailable", reason: "empty" }]) {
    const empty = fixture({ evidence });
    const value = bounded(await empty.reader.read(args()), "empty");
    assert.equal(value.text, "");
    assert.equal(value.coverage.sourceComplete, true);
    assert.equal(value.coverage.totalLines, 0);
    assert.equal(value.coverage.truncated, false);
    assert.equal(value.coverage.remaining, 0);
  }
});

test("a selected blank line is covered without inventing nonempty evidence", async () => {
  const { reader } = fixture({ text: "first\n\nthird" });
  const result = bounded(await reader.read(args({ start_line: 2, end_line: 2 })), "empty");
  assert.equal(result.text, "");
  assert.deepEqual(result.coverage, { sourceComplete: true, totalLines: 3, fromLine: 2,
    toLine: 2, selection: "range", truncated: true, remaining: 2 });
});

test("accessors and malformed objects are rejected without evaluation", async () => {
  const { reader, state } = fixture();
  const accessor = { get attachment_ref() { throw new Error("never evaluate an argument getter"); } };
  bounded(await reader.read(accessor), "invalid_arguments");
  const revoked = globalThis.Proxy.revocable({}, {});
  revoked.revoke();
  bounded(await reader.read(revoked.proxy), "invalid_arguments");
  assert.equal(state.calls.length, 0);
});

test("concurrent and repeated reads share only one redacted text memo", async () => {
  const gate = deferred();
  const { reader, state } = fixture({ fetchEvidence: () => gate.promise });
  const first = reader.read(args());
  const second = reader.read(args({ start_line: 21, end_line: 30 }));
  await Promise.resolve();
  assert.equal(state.calls.length, 1);
  gate.resolve({ status: "ok", text: body(50) });
  const [head, range] = await Promise.all([first, second]);
  bounded(head);
  bounded(range);
  assert.equal(range.coverage.fromLine, 21);
  bounded(await reader.read(args({ query: "line 45" })));
  assert.equal(state.calls.length, 1);
});

test("each instance is isolated; total reads are bounded including cache hits", async () => {
  const { reader, state } = fixture();
  for (let index = 0; index < 4; index++) bounded(await reader.read(args()));
  const over = bounded(await reader.read(args()), "denied");
  assert.equal(over.text, "read_limit");
  assert.equal(state.calls.length, 1);
  const separate = fixture();
  bounded(await separate.reader.read(args()));
  assert.equal(separate.state.calls.length, 1);
});

test("at most three distinct 10KB memos/downloads exist in a session", async () => {
  const { entry, references } = fixture();
  let calls = 0;
  const reader = createAttachmentReader({ references: { ...references, resolve: ref => ({ ...entry,
    descriptor: { ...entry.descriptor, attachment_ref: ref } }) },
    fetchEvidence: async () => { calls++; return { status: "ok", text: "a".repeat(10000) }; } });
  for (const ref of ["att_1", "att_2", "att_3"]) bounded(await reader.read({ attachment_ref: ref }));
  const fourth = bounded(await reader.read({ attachment_ref: "att_4" }), "denied");
  assert.equal(fourth.text, "download_limit");
  assert.equal(calls, 3);
});

test("failed downloads also spend the finite download budget", async () => {
  const { reader, state } = fixture({ fetchEvidence: () => { throw new Error("token=never-echo-this https://private.invalid"); } });
  for (let index = 0; index < 3; index++) {
    const result = bounded(await reader.read(args()), "unavailable");
    assert.equal(result.text, "read_failed");
  }
  bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 3);
});

test("pre-aborted signals deny before download", async () => {
  const controller = new globalThis.AbortController();
  controller.abort(new Error("synthetic secret abort"));
  const { reader, state } = fixture({ signal: controller.signal });
  const result = bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 0);
  assert.equal(result.text, "");
});

test("abort settles ignored transport immediately and rejects its late completion", async () => {
  const controller = new globalThis.AbortController();
  const gate = deferred();
  const { reader, state } = fixture({ signal: controller.signal, fetchEvidence: () => gate.promise });
  const reading = reader.read(args());
  await Promise.resolve();
  assert.equal(state.calls[0].options.signal, controller.signal);
  controller.abort(new Error("token=private-abort"));
  bounded(await reading, "denied");
  gate.resolve({ status: "ok", text: "late private data" });
  await Promise.resolve();
  bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 1);
});

test("privacy, permission and expiry changes refuse concurrent late results and refill", async () => {
  for (const change of [value => { value.state.current = false; }, value => { value.state.allowed = false; },
    value => { value.entry.binding.expiresAt = Date.now() - 1; }, value => { value.entry.file.url = "https://example.com/changed"; }]) {
    const gate = deferred();
    const value = fixture({ fetchEvidence: () => gate.promise });
    const first = value.reader.read(args());
    const second = value.reader.read(args({ query: "late" }));
    await Promise.resolve();
    change(value);
    gate.resolve({ status: "ok", text: "late private data" });
    for (const result of await Promise.all([first, second])) bounded(result, "denied");
    value.state.current = true;
    value.state.allowed = true;
    value.entry.binding.expiresAt = Date.now() + 90000;
    bounded(await value.reader.read(args()), "denied");
    assert.equal(value.state.calls.length, 1);
  }
});

test("cache hits recheck authorization and never revive after forgetting", async () => {
  const { reader, state } = fixture();
  bounded(await reader.read(args()));
  const before = state.checks;
  bounded(await reader.read(args()));
  assert.ok(state.checks > before);
  state.current = false;
  bounded(await reader.read(args()), "denied");
  state.current = true;
  bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 1);
});

test("resolve denial of an existing memo permanently invalidates it", async () => {
  const { reader, state } = fixture();
  bounded(await reader.read(args()));
  state.allowed = false;
  bounded(await reader.read(args()), "denied");
  state.allowed = true;
  bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 1);
});

test("parent guard is checked before and after fetch and memo reuse", async () => {
  let parentCurrent = true;
  let parentChecks = 0;
  const gate = deferred();
  const { reader, state } = fixture({ assertCurrent: () => {
    parentChecks++;
    if (!parentCurrent) throw new Error("private parent permission changed");
  }, fetchEvidence: () => gate.promise });
  const reading = reader.read(args());
  await Promise.resolve();
  parentCurrent = false;
  gate.resolve({ status: "ok", text: "private late" });
  bounded(await reading, "denied");
  assert.ok(parentChecks >= 2);
  parentCurrent = true;
  bounded(await reader.read(args()), "denied");
  assert.equal(state.calls.length, 1);
});

test("service cancellation codes poison the reader without leaking the original error", async () => {
  for (const code of ["CHAT_CANCELLED", "CHAT_TOOL_STOPPED"]) {
    const { reader, state } = fixture({ fetchEvidence: () => { throw Object.assign(new Error("private original"), { code }); } });
    const result = bounded(await reader.read(args()), "denied");
    assert.doesNotMatch(JSON.stringify(result), /private original|CHAT_/);
    bounded(await reader.read(args()), "denied");
    assert.equal(state.calls.length, 1);
  }
});
