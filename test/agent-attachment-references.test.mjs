import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import vm from "node:vm";
import { runVmTestFile } from "./vm-test-runner.mjs";

const scope = () => ({ surface: "group", userId: "601", groupId: "501", currentMessageId: "71" });
const file = () => ({ name: "report.TXT", url: "https://example.com/report.txt?token=synthetic", file: "backend-file", size: 32 });
const plain = value => JSON.parse(JSON.stringify(value));
const stopped = reason => ({ code: "CHAT_TOOL_STOPPED", message: reason });
const denied = { status: "denied", reason: "reference_not_in_turn" };

async function fixture() {
  const controller = new globalThis.AbortController();
  const state = { active: scope(), signal: controller.signal, privacy: 0, users: new Map(), time: 1000, chatError: null, parentError: null, parentCalls: 0 };
  const context = vm.createContext({});
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
  const chat = synthetic({ currentChatScope: () => state.active, chatRunSignal: () => state.signal,
    assertChatRunCurrent: () => { if (state.chatError) throw state.chatError; } });
  const generation = synthetic({ getMemoryPrivacyGeneration: () => state.privacy,
    getUserMemoryGeneration: uid => state.users.get(String(uid)) || 0 });
  const privacy = new vm.SourceTextModule(await readFile(new URL("../bridge/privacy.mjs", import.meta.url), "utf8"), { context });
  const module = new vm.SourceTextModule(await readFile(new URL("../bridge/chat-tools/attachment-references.mjs", import.meta.url), "utf8"), { context });
  const imports = new Map([["node:crypto", synthetic({ randomBytes })], ["../cognition/chat-run.mjs", chat],
    ["../memory-profile/generation.mjs", generation], ["../privacy.mjs", privacy]]);
  await module.link(specifier => {
    assert.ok(imports.has(specifier), "unexpected dependency: " + specifier);
    return imports.get(specifier);
  });
  await module.evaluate();
  const create = (files = [file()], options = {}) => module.namespace.createAttachmentReferenceSession(files, {
    scope: scope(), messageId: "71", now: () => state.time,
    assertCurrent: () => { state.parentCalls++; if (state.parentError) throw state.parentError; }, ...options,
  });
  return { create, state, controller };
}

function firstRef(session) { return session.initialReferences()[0].attachment_ref; }

if (!vm.SourceTextModule) {
  test("attachment reference pure/mock cases execute in isolated VM modules", t => {
    t.diagnostic(JSON.stringify(runVmTestFile(import.meta.url, { minTests: 43 })));
  });
} else {
  test("initial metadata is only an unread public descriptor and resolution stays backend-only", async () => {
    const { create, state } = await fixture();
    const session = create();
    const descriptor = session.initialReferences()[0];
    assert.deepEqual(Object.keys(descriptor).sort(), ["attachment_ref", "bytes", "name", "status", "type"]);
    assert.match(descriptor.attachment_ref, /^att_[a-f0-9]{32}$/);
    assert.deepEqual(plain(descriptor), { attachment_ref: descriptor.attachment_ref, name: "report.TXT", type: "txt", bytes: 32, status: "not_read" });
    assert.doesNotMatch(JSON.stringify(descriptor), /example|synthetic|backend-file|userId|messageId|groupId/);
    assert.deepEqual(plain(session.resolve(descriptor.attachment_ref)), { status: "ok", file: file(), descriptor: plain(descriptor),
      binding: { scope: { surface: "group", userId: "601", groupId: "501" }, messageId: "71", expiresAt: 601000 } });
    assert.equal(session.expiry(), 601000);
    assert.ok(state.parentCalls >= 2);
  });

  test("each session and attachment gets an independent unpredictable reference", async () => {
    const { create } = await fixture();
    const sessions = Array.from({ length: 20 }, () => create([file(), file(), file()]));
    const refs = sessions.flatMap(session => session.initialReferences().map(item => item.attachment_ref));
    assert.equal(new Set(refs).size, 60);
    assert.deepEqual(plain(sessions[1].resolve(refs[0])), denied);
  });

  test("only the first three current attachment slots can mint references", async () => {
    const { create } = await fixture();
    const files = Array.from({ length: 6 }, (_, index) => ({ ...file(), name: index + ".txt" }));
    const session = create(files);
    assert.deepEqual(session.initialReferences().map(item => item.name).join(","), "0.txt,1.txt,2.txt");
    assert.equal(create([null, {}, file(), file()]).initialReferences().length, 1);
  });

  test("fake, cross-session, URL, path, object and model metadata inputs are denied without coercion", async () => {
    const { create } = await fixture();
    const session = create();
    const ref = firstRef(session);
    const other = create();
    const hostile = { attachment_ref: ref, file: file(), scope: scope(), toString() { assert.fail("model object must not be coerced"); } };
    for (const value of ["att_" + "0".repeat(32), firstRef(other), file().url, "/etc/passwd", "C:\\secret.txt", ref + "/path", hostile, null, undefined, 71]) {
      assert.deepEqual(plain(session.resolve(value)), denied);
    }
    assert.equal(session.resolve(ref).status, "ok");
  });

  test("input files, scope, options and returned records cannot mutate the authority snapshot", async () => {
    const { create } = await fixture();
    const input = file();
    const sourceScope = scope();
    const options = { scope: sourceScope, messageId: "71", ttlMs: 5000 };
    const files = [input];
    const session = create(files, options);
    const descriptor = session.initialReferences()[0];
    const ref = descriptor.attachment_ref;
    input.url = "https://evil.example/"; input.name = "evil.pdf"; input.size = 999;
    files[0] = { name: "replacement.txt" }; files.push(file());
    sourceScope.userId = "602"; sourceScope.groupId = "502"; sourceScope.currentMessageId = "72";
    options.messageId = "72"; options.ttlMs = 999999;
    descriptor.name = "changed"; descriptor.attachment_ref = "att_fake";
    const result = session.resolve(ref);
    result.file.url = "https://evil.example/"; result.descriptor.status = "ok";
    result.binding.scope.userId = "602"; result.binding.messageId = "72"; result.binding.expiresAt = 9999999;
    assert.deepEqual(plain(session.resolve(ref).file), file());
    assert.equal(session.resolve(ref).binding.messageId, "71");
    assert.equal(session.resolve(ref).binding.scope.userId, "601");
    assert.equal(session.expiry(), 6000);
    assert.equal(session.initialReferences()[0].status, "not_read");
  });

  test("backend files clone only own primitive whitelist fields and never evaluate getters", async () => {
    const { create } = await fixture();
    const input = { ...file(), path: "/etc/passwd", userId: "999", messageId: "999", metadata: { secret: "synthetic" } };
    Object.defineProperty(input, "ignored", { get() { throw new Error("unlisted accessor"); } });
    const inherited = Object.create({ url: "https://evil.example/", size: 99 });
    inherited.name = "own.txt";
    Object.defineProperty(inherited, "file", { get() { throw new Error("whitelisted accessor"); } });
    const session = create([input, inherited, { name: { value: "nested.txt" }, url: { url: "https://evil.example/" } }]);
    const refs = session.initialReferences();
    assert.equal(refs.length, 2);
    assert.deepEqual(plain(session.resolve(refs[0].attachment_ref).file), file());
    assert.deepEqual(plain(session.resolve(refs[1].attachment_ref).file), { name: "own.txt" });
  });

  for (const [label, changed] of [["user", { userId: "602" }], ["group", { groupId: "502" }],
    ["surface", { surface: "private", groupId: "private" }], ["missing active chat", null]]) {
    test("identity change rejects " + label + " and cannot revive the session", async () => {
      const { create, state } = await fixture();
      const session = create(); const ref = firstRef(session);
      state.active = changed ? { ...scope(), ...changed } : null;
      assert.throws(() => session.resolve(ref), stopped("permission_changed"));
      state.active = scope();
      assert.throws(() => session.initialReferences(), stopped("permission_changed"));
    });
  }

  test("a different turn message rejects even when user and group remain unchanged", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.active.currentMessageId = "72";
    assert.throws(() => session.resolve(ref), stopped("reply_superseded"));
  });

  test("same message identity in another chat run rejects by the captured run signal", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.signal = new globalThis.AbortController().signal;
    assert.throws(() => session.resolve(ref), stopped("reply_superseded"));
  });

  test("factory cannot replace the active user or turn with a supplied backend scope", async () => {
    const { create } = await fixture();
    assert.throws(() => create([file()], { scope: { ...scope(), userId: "602" } }).initialReferences(), stopped("permission_changed"));
    assert.throws(() => create([file()], { scope: { ...scope(), currentMessageId: "72" }, messageId: "72" }).initialReferences(), stopped("reply_superseded"));
  });

  test("privacy global generation is independently checked even with no-op parent guard", async () => {
    const { create, state } = await fixture();
    const session = create([file()], { assertCurrent: () => {} }); const ref = firstRef(session);
    state.privacy++;
    assert.throws(() => session.resolve(ref), stopped("privacy_changed"));
    state.privacy--;
    assert.throws(() => session.assertCurrent(), stopped("privacy_changed"));
  });

  test("user generation changes revoke without a global generation bump", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.users.set("601", 1);
    assert.throws(() => session.resolve(ref), stopped("preferences_changed"));
  });

  test("another user's preference-only generation does not revoke this scope", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.users.set("602", 1);
    assert.equal(session.resolve(ref).status, "ok");
  });

  test("chat-run cancellation errors are propagated and latched", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    const error = Object.assign(new Error("permission_changed"), { code: "CHAT_CANCELLED" });
    state.chatError = error;
    assert.throws(() => session.resolve(ref), value => value === error);
    state.chatError = null;
    assert.throws(() => session.assertCurrent(), value => value === error);
  });

  test("parent guard preserves the original shared budget rather than starting a new turn", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.time += 1;
    const error = Object.assign(new Error("tool_deadline"), { code: "CHAT_TOOL_STOPPED" });
    state.parentError = error;
    assert.throws(() => session.resolve(ref), value => value === error);
    state.parentError = null;
    assert.throws(() => session.assertCurrent(), value => value === error);
  });

  for (const kind of ["external", "chat-run"]) {
    test(kind + " abort rejects before providing backend metadata", async () => {
      const { create, controller } = await fixture();
      const external = new globalThis.AbortController();
      const session = create([file()], { signal: external.signal }); const ref = firstRef(session);
      (kind === "external" ? external : controller).abort(new Error("synthetic cancellation"));
      assert.throws(() => session.resolve(ref), stopped("reply_superseded"));
      assert.throws(() => session.initialReferences(), stopped("reply_superseded"));
    });
  }

  test("attachment TTL defaults to ten minutes and never extends past that cap", async () => {
    const { create } = await fixture();
    assert.equal(create().expiry(), 601000);
    assert.equal(create([file()], { ttlMs: 9999999 }).expiry(), 601000);
    assert.equal(create([file()], { ttlMs: 10 }).expiry(), 1010);
    for (const ttlMs of [0, -1, "600000", null, NaN, Infinity]) {
      const session = create([file()], { ttlMs });
      assert.equal(session.expiry(), 1000);
      assert.throws(() => session.initialReferences(), stopped("reply_expired"));
    }
  });

  test("short TTL expires at the exact boundary and remains revoked after clock rollback", async () => {
    const { create, state } = await fixture();
    const session = create([file()], { ttlMs: 2000 }); const ref = firstRef(session);
    state.time = 2999; assert.equal(session.resolve(ref).status, "ok");
    state.time = 3000; assert.throws(() => session.resolve(ref), stopped("reply_expired"));
    state.time = 2999; assert.throws(() => session.assertCurrent(), stopped("reply_expired"));
  });

  test("the ninety-second turn cap wins over the ten-minute attachment TTL", async () => {
    const { create, state } = await fixture();
    const session = create(); const ref = firstRef(session);
    state.time = 90999; assert.equal(session.resolve(ref).status, "ok");
    state.time = 91000; assert.throws(() => session.resolve(ref), stopped("tool_deadline"));
    assert.equal(session.expiry(), 601000);
  });

  test("nonfinite clocks and backwards time fail closed", async () => {
    for (const time of [999, NaN, Infinity, "1001"]) {
      const { create, state } = await fixture();
      const session = create(); const ref = firstRef(session);
      state.time = time;
      assert.throws(() => session.resolve(ref), stopped("reply_expired"));
    }
  });

  test("fractional injected clocks remain compatible with the parent's monotonic clock", async () => {
    const { create, state } = await fixture();
    state.time = 1000.5;
    const session = create([file()], { ttlMs: 2000 }); const ref = firstRef(session);
    assert.equal(session.expiry(), 3000.5);
    state.time = 3000.49; assert.equal(session.resolve(ref).status, "ok");
    state.time = 3000.5; assert.throws(() => session.resolve(ref), stopped("reply_expired"));
  });

  test("filename paths and URLs never enter public names and type is only an extension", async () => {
    const { create } = await fixture();
    for (const [name, expected, type] of [["/home/private/report.PDF", "report.PDF", "pdf"],
      ["C:\\private\\report.md", "report.md", "md"], ["folder%2Freport.json", "report.json", "json"],
      ["https://example.com/private?token=synthetic", "unnamed", "unknown"],
      ["report https://example.com/private", "unnamed", "unknown"], ["file:///etc/passwd", "unnamed", "unknown"],
      ["mailto:private@example.com", "unnamed", "unknown"],
      ["https%253A%252F%252Fexample.com%252Fsecret", "unnamed", "unknown"], ["no-extension", "no-extension", "unknown"]]) {
      const descriptor = create([{ ...file(), name }]).initialReferences()[0];
      assert.equal(descriptor.name, expected); assert.equal(descriptor.type, type);
      assert.equal(descriptor.status, "not_read");
    }
  });

  test("filename credentials, phone numbers, encoded secrets and invisible separators are cleaned", async () => {
    const { create } = await fixture();
    for (const name of ["api_key=synthetic.txt", "password='synthetic/value'.txt", "13800138000.txt",
      "sk-synthetic0123456789.txt", "Bearer synthetic0123456789.txt", "api_key%3Dsynthetic.txt",
      "api_\u200bkey=synthetic.txt", "report.txt?token=synthetic", "report.txt#synthetic"]) {
      const descriptor = create([{ ...file(), name }]).initialReferences()[0];
      assert.doesNotMatch(descriptor.name, /synthetic|13800138000|\u200b/);
      assert.ok(descriptor.name.length <= 120);
    }
    for (const name of ["uid=13800138000.txt", "user_id=601.txt", "message_id=-12345678901234567.txt"]) {
      const descriptor = create([{ ...file(), name }]).initialReferences()[0];
      assert.equal(descriptor.name, "[REDACTED].txt");
    }
  });

  test("R1 complete authentication strings never leave public filename descriptors", async () => {
    const { create } = await fixture();
    const credential = "c3ludGhldGljOnNlY3JldA==";
    for (const name of ["authorization=Basic " + credential + ".txt",
      "AUTHORIZATION = Basic " + credential + ".txt", "proxy-authorization=Basic " + credential + ".txt",
      'authorization="Basic ' + credential + '".txt', "Basic " + credential + ".txt",
      "authorization=Basic aa+/bb==.txt", "authorization=Digest username=synthetic,response=" + credential + ".txt",
      encodeURIComponent("authorization=Basic " + credential + ".txt")]) {
      const session = create([{ ...file(), name }]);
      const descriptor = session.initialReferences()[0];
      assert.doesNotMatch(JSON.stringify(descriptor), /c3ludGhldGlj|OnNlY3JldA|aa\+|bb==|synthetic|Basic|Digest/);
      assert.match(descriptor.name, /\[REDACTED\]/);
      const resolved = session.resolve(descriptor.attachment_ref);
      assert.deepEqual(plain(resolved.descriptor), plain(descriptor));
      assert.equal(resolved.file.name, name);
    }
  });

  test("R1 empty session without a scope has no attachment identity or expiry constraint", async () => {
    const { create, state } = await fixture();
    state.active = null;
    state.signal = undefined;
    const session = create([], { scope: null, messageId: undefined });
    assert.deepEqual(plain(session.initialReferences()), []);
    assert.doesNotThrow(() => session.assertCurrent());
    assert.equal(session.expiry(), null);
    state.time += 90000;
    assert.doesNotThrow(() => session.assertCurrent());
    assert.deepEqual(plain(session.resolve("att_" + "a".repeat(32))), denied);
    assert.ok(state.parentCalls >= 4);
  });

  test("R1 zero-reference sessions bypass only attachment identity and TTL and deny foreign refs", async () => {
    for (const [files, options] of [[[], { messageId: undefined }], [[file()], { messageId: undefined }],
      [[], {}], [[null, { path: "/etc/passwd" }], {}]]) {
      const { create, state } = await fixture();
      const foreignRef = firstRef(create());
      const session = create(files, options);
      state.time = 91000;
      assert.doesNotThrow(() => session.assertCurrent());
      state.time = 601001;
      state.active = { ...scope(), userId: "602", groupId: "502", currentMessageId: "72" };
      state.signal = new globalThis.AbortController().signal;
      assert.doesNotThrow(() => session.assertCurrent());
      assert.deepEqual(plain(session.initialReferences()), []);
      assert.equal(session.expiry(), null);
      for (const ref of [foreignRef, file().url, "/etc/passwd", { attachment_ref: foreignRef }]) {
        assert.deepEqual(plain(session.resolve(ref)), denied);
      }
    }
  });

  test("R1 empty session keeps the global privacy guard and sticky rejection", async () => {
    const { create, state } = await fixture();
    const session = create([]);
    state.privacy++;
    assert.throws(() => session.assertCurrent(), stopped("privacy_changed"));
    state.privacy--;
    assert.throws(() => session.resolve("att_" + "a".repeat(32)), stopped("privacy_changed"));
  });

  test("R1 empty session keeps its bound user's privacy generation guard", async () => {
    const { create, state } = await fixture();
    const session = create([]);
    state.users.set("601", 1);
    assert.throws(() => session.assertCurrent(), stopped("preferences_changed"));
  });

  test("R1 empty session keeps the shared parent budget guard", async () => {
    const { create, state } = await fixture();
    const session = create([]);
    const error = Object.assign(new Error("tool_deadline"), { code: "CHAT_TOOL_STOPPED" });
    state.parentError = error;
    assert.throws(() => session.assertCurrent(), value => value === error);
    state.parentError = null;
    assert.throws(() => session.initialReferences(), value => value === error);
  });

  test("R1 empty session keeps the existing chat-run guard", async () => {
    const { create, state } = await fixture();
    const session = create([]);
    const error = Object.assign(new Error("permission_changed"), { code: "CHAT_CANCELLED" });
    state.chatError = error;
    assert.throws(() => session.assertCurrent(), value => value === error);
  });

  for (const kind of ["external", "chat-run"]) {
    test("R1 empty session keeps " + kind + " cancellation", async () => {
      const { create, controller } = await fixture();
      const external = new globalThis.AbortController();
      const session = create([], { signal: external.signal });
      (kind === "external" ? external : controller).abort();
      assert.throws(() => session.assertCurrent(), stopped("reply_superseded"));
    });
  }

  test("missing names, controls and very long filenames get bounded plain descriptors", async () => {
    const { create } = await fixture();
    for (const name of [undefined, "", "\u0000\u200b", "a".repeat(1000) + ".txt"]) {
      const descriptor = create([{ ...file(), name }]).initialReferences()[0];
      assert.ok(descriptor.name.length > 0 && descriptor.name.length <= 120);
      assert.doesNotMatch(descriptor.name, /[\p{Cc}\p{Cf}]/u);
    }
  });

  test("bytes is a reported nonnegative safe integer or null without coercion or inference", async () => {
    const { create } = await fixture();
    for (const [size, expected] of [[0, 0], [32, 32], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [undefined, null], ["32", null], [-1, null], [1.5, null], [NaN, null], [Infinity, null], [Number.MAX_SAFE_INTEGER + 1, null]]) {
      const session = create([{ ...file(), size }]);
      const descriptor = session.initialReferences()[0];
      assert.equal(descriptor.bytes, expected);
      assert.equal(session.resolve(descriptor.attachment_ref).file.size ?? null, expected);
    }
  });

  test("missing or malformed message IDs mint no references", async () => {
    const { create } = await fixture();
    for (const messageId of [undefined, null, "", " 71", "71 ", "+71", "071", "-071", "-0", -0, 1.5,
      "1.5", "1e3", "123456789012345678901", Number.MAX_SAFE_INTEGER + 1, {}, true, "/etc/passwd"]) {
      const session = create([file()], { messageId });
      assert.deepEqual(plain(session.initialReferences()), []);
      assert.deepEqual(plain(session.resolve("att_" + "0".repeat(32))), denied);
    }
  });

  test("canonical bounded positive and negative message IDs retain exact backend binding", async () => {
    for (const messageId of [71, -71, 0, "0", "-71", "12345678901234567890", "-12345678901234567890"]) {
      const { create, state } = await fixture();
      state.active.currentMessageId = messageId;
      const session = create([file()], { scope: { ...scope(), currentMessageId: messageId }, messageId });
      assert.equal(session.resolve(firstRef(session)).binding.messageId, String(messageId));
    }
  });

  test("contradictory scope message IDs do not mint refs and missing active IDs cannot authorize", async () => {
    const { create, state } = await fixture();
    assert.deepEqual(plain(create([file()], { scope: { ...scope(), currentMessageId: "72" } }).initialReferences()), []);
    assert.deepEqual(plain(create([file()], { scope: { ...scope(), messageId: "72" } }).initialReferences()), []);
    const session = create();
    delete state.active.currentMessageId;
    assert.throws(() => session.initialReferences(), stopped("reply_superseded"));
  });

  test("invalid scopes and missing file arrays never expand attachment authority", async () => {
    const { create } = await fixture();
    for (const sourceScope of [{}, { ...scope(), userId: "bad" }, { ...scope(), groupId: "bad" },
      { ...scope(), surface: "other" }, { surface: "private", userId: "601", groupId: "501" }]) {
      assert.deepEqual(plain(create([file()], { scope: sourceScope }).initialReferences()), []);
    }
    for (const files of [null, {}, "https://example.com/a", [], [null, {}, { path: "/etc/passwd" }]]) {
      assert.deepEqual(plain(create(files).initialReferences()), []);
    }
  });

  test("private scopes bind to the current user and numeric/string group identities are equivalent", async () => {
    const { create, state } = await fixture();
    state.active = { surface: "private", userId: 601, currentMessageId: 71 };
    const session = create([file()], { scope: { surface: "private", userId: "601" } });
    assert.equal(session.resolve(firstRef(session)).binding.scope.groupId, "private");
    state.active = { ...scope(), userId: 601, groupId: 501, currentMessageId: 71 };
    assert.equal(create().resolve(firstRef(create())).status, "denied");
    const groupSession = create();
    assert.equal(groupSession.resolve(firstRef(groupSession)).status, "ok");
  });
}
