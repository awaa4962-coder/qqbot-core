import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-file-context-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root,
  QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });

const { CFG } = await import("../bridge/config.mjs");
const { prepareAttachmentEvidence } = await import("../bridge/context/attachments.mjs");
const { buildReplyContextPacket } = await import("../bridge/context/assemble.mjs");
const { fetchFileEvidence, fetchFileContent } = await import("../bridge/napcat.mjs");
const { fetchSafeText } = await import("../bridge/safe-url.mjs");
const { handlePrivateMessage } = await import("../bridge/reply-private.mjs");
const { getConversationThread, resetCognitionForTest } = await import("../bridge/cognition/index.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
const { saveApiProvider, saveApiRoutes } = await import("../bridge/api-providers/store.mjs");

CFG.friendWhitelist = [60100];
saveApiProvider({ id: "file-evidence-primary", model: "file-evidence-primary", presetId: "custom-openai-chat",
  auth: "none", endpoint: "https://example.com/file-evidence-primary", capabilities: ["text"], enabled: true }, { root });
saveApiRoutes({ file_chat: { primary: "file-evidence-primary", fallback: null } }, { root });

let messageId = 90000;
const context = (files, text = "请核查附件") => ({ user_id: 60100, nickname: "合成用户", text, files, images: [], message_id: ++messageId });
const file = index => ({ name: "case-" + index + ".txt", url: "https://example.com/file-" + index });
const sentReceipt = { status: "ok", retcode: 0, data: { message_id: 90001 } };

test("prepares at most three complete atomic evidence layers with redacted names and bodies", async () => {
  const calls = [];
  const files = [file(1), { ...file(2), name: "C:\\private\\password=synthetic.txt" }, file(3), file(4)];
  const result = await prepareAttachmentEvidence(files, { fetchEvidence: async item => {
    calls.push(item.url);
    return { status: "ok", text: "header\npassword=synthetic\nlast line" };
  } });
  assert.deepEqual(calls, files.slice(0, 3).map(item => item.url));
  assert.deepEqual({ total: result.total, attempted: result.attempted, unreadable: result.unreadable, omitted: result.omitted },
    { total: 4, attempted: 3, unreadable: 0, omitted: 1 });
  assert.equal(result.layers.length, 3);
  for (const [offset, layer] of result.layers.entries()) {
    const index = offset + 1;
    assert.equal(layer.contextGroup, "attachment:" + index);
    assert.equal(layer.contextAtomic, true);
    assert.equal(layer.contextPriority, 98);
    assert.deepEqual(layer.contextSources, [{ kind: "file", reason: "attachment", fileIndex: index }]);
    assert.match(layer.content, /header\npassword=\[REDACTED\]\nlast line/);
    assert.doesNotMatch(layer.content, /https:\/\/|C:\\private|synthetic/);
  }
});

test("unsupported, empty, and unavailable attachments do not masquerade as readable text", async () => {
  const values = [
    { status: "unsupported", reason: "unsupported_type" },
    { status: "ok", text: "  " },
    { status: "unavailable", reason: "read_failed" },
  ];
  let offset = 0;
  const result = await prepareAttachmentEvidence([file(1), file(2), file(3)], { fetchEvidence: async () => values[offset++] });
  assert.equal(result.layers.length, 0);
  assert.equal(result.unreadable, 3);
  assert.equal(result.attempted, 3);
});

test("attachment coverage is backend-validated and measured after the actual selection", async () => {
  const evidence = await prepareAttachmentEvidence([file(1)], { fetchEvidence: async () => ({ status: "ok", text: "full file body" }) });
  const options = { uid: "60100", groupId: "private", mode: "private-file", userMsg: "current question", attachmentEvidence: evidence };
  const packet = buildReplyContextPacket(options);
  assert.equal(packet.attachmentCoverage.included, 1);
  assert.equal(packet.budget.chars, packet.currentInput.length + packet.messages.reduce((sum, item) => sum + item.content.length, 0));
  assert.ok(packet.budget.chars <= packet.budget.maxChars);
  assert.match(packet.currentInput, /current question/);
  assert.match(packet.currentInput, /正文完整提供1份/);
  for (const overrides of [
    { groupId: "51001" }, { mode: "private" },
    { attachmentEvidence: { ...evidence, total: 2 } },
    { attachmentEvidence: { ...evidence, attempted: 4 } },
    { attachmentEvidence: { ...evidence, unreadable: -1 } },
    { attachmentEvidence: { ...evidence, layers: [{ ...evidence.layers[0], contextPriority: 50 }] } },
    { attachmentEvidence: { ...evidence, layers: [{ ...evidence.layers[0], contextSources: [{ kind: "file", reason: "attachment", fileIndex: 2 }] }] } },
  ]) assert.throws(() => buildReplyContextPacket({ ...options, ...overrides }), /attachment_context_invalid/);
});

test("structured fetch preserves format, SSRF, redirect and byte limits without exposing errors", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new globalThis.Response("body"); });
  const hostile = { toString: () => { throw new Error("coercion must not run"); } };
  assert.equal((await fetchFileEvidence({ name: hostile, url: hostile })).status, "unsupported");
  assert.deepEqual(await fetchFileEvidence({ name: "x.txt", url: hostile, file: hostile }),
    { status: "unavailable", reason: "missing_url" });
  assert.equal((await fetchFileEvidence({ name: "x.pdf", url: "https://example.com/x.pdf" })).status, "unsupported");
  assert.equal((await fetchFileEvidence({ name: "x.txt", url: "http://127.0.0.1/x.txt" })).status, "unavailable");
  assert.equal(requests, 0);
  assert.match(await fetchFileContent({ name: "x.pdf", url: "https://example.com/x.pdf" }), /二进制/);
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async () => new globalThis.Response(null, { status: 302, headers: { location: "http://localhost/private" } }));
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "unavailable", reason: "read_failed" });
  t.mock.restoreAll();

  t.mock.method(globalThis, "fetch", async () => new globalThis.Response("x".repeat(10001)));
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "unavailable", reason: "read_failed" });
});

test("attachment fetch accepts only full HTTP 200 responses without Content-Range", async t => {
  const responses = [
    new globalThis.Response("partial", { status: 206, headers: { "content-range": "bytes 0-6/50000" } }),
    new globalThis.Response("partial", { status: 200, headers: { "content-range": "bytes 0-6/50000" } }),
    new globalThis.Response("created", { status: 201 }),
    new globalThis.Response("complete", { status: 200 }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "unavailable", reason: "read_failed" });
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "unavailable", reason: "read_failed" });
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "unavailable", reason: "read_failed" });
  assert.deepEqual(await fetchFileEvidence(file(1)), { status: "ok", text: "complete" });
});

test("full-response enforcement stays opt-in for existing fetchSafeText callers", async t => {
  t.mock.method(globalThis, "fetch", async () => new globalThis.Response("range body", {
    status: 206, headers: { "content-range": "bytes 0-9/1000" },
  }));
  const url = "https://example.com/ordinary-text";
  assert.equal(await fetchSafeText(url, { maxBytes: 100 }), "range body");
  assert.equal(await fetchSafeText(url, { maxBytes: 100, requireFullResponse: true }), null);
});

test("file fetch propagates caller cancellation instead of returning a read failure", async t => {
  const controller = new globalThis.AbortController();
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), file(1).url);
    controller.abort(new Error("caller cancelled"));
    throw new Error("transport interrupted");
  });
  await assert.rejects(fetchFileEvidence(file(1), { signal: controller.signal }), /caller cancelled/);
  await assert.rejects(fetchFileEvidence({ name: "x.pdf", url: file(1).url }, { signal: controller.signal }), /caller cancelled/);
});

test("an 8k middle passage reaches the gateway as file evidence, not the current input or private thread", async t => {
  resetCognitionForTest();
  const middle = "MIDDLE_FILE_FACT_8421";
  const body = "start\n" + "a".repeat(3900) + middle + "b".repeat(3900) + "\nend";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://example.com/file-evidence-primary");
    assert.equal(options.method, "POST");
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "已核查。" } }] }) };
  });
  const sent = [];
  const ctx = context([file(1)], "文件中段写了什么？");
  await handlePrivateMessage(ctx, {
    fetchEvidence: async () => ({ status: "ok", text: body }),
    sendPrivateMsg: async (_uid, text) => { sent.push(text); return sentReceipt; },
  });
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.ok(messages.some(item => typeof item.content === "string" && item.content.includes(middle)));
  assert.ok(!messages.at(-1).content.includes(middle));
  assert.match(messages.at(-1).content, /文件中段写了什么/);
  assert.deepEqual(sent, ["已核查。"]);
  const thread = getConversationThread("60100", "private");
  assert.ok(thread);
  assert.doesNotMatch(JSON.stringify(thread), /MIDDLE_FILE_FACT_8421|a{100}|b{100}/);
  assert.match(thread.turns.at(-1).userSummary, /附件共1份，已提供1份/);
  assert.equal(thread.turns.at(-1).assistantSummary, "已核查。");
});

test("a 1500-character file question reaches the actual gateway intact", async t => {
  resetCognitionForTest();
  const middle = "MIDDLE_QUESTION_FACT_1500";
  const prefix = "A".repeat(730);
  const suffix = "B".repeat(1500 - prefix.length - middle.length);
  const question = prefix + middle + suffix;
  assert.equal(question.length, 1500);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://example.com/file-evidence-primary");
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "已核查。" } }] }) };
  });
  const sent = [];
  await handlePrivateMessage(context([file(1)], question), {
    fetchEvidence: async () => ({ status: "ok", text: "complete attachment" }),
    sendPrivateMsg: async (_uid, text) => { sent.push(text); return sentReceipt; },
  });
  assert.equal(requests.length, 1);
  const current = requests[0].messages.at(-1).content;
  assert.ok(current.includes(prefix) && current.includes(middle) && current.includes(suffix));
  assert.deepEqual(sent, ["已核查。"]);
});

test("a file question beyond the private-file context limit never reaches model or send", async () => {
  let models = 0;
  let sends = 0;
  await assert.rejects(handlePrivateMessage(context([file(1)], "Q".repeat(14001)), {
    fetchEvidence: async () => ({ status: "ok", text: "complete attachment" }),
    executeChatTask: async () => { models++; return { kind: "reply", text: "unexpected" }; },
    sendPrivateMsg: async () => { sends++; return sentReceipt; },
  }), { code: "context_current_input_limit" });
  assert.equal(models, 0);
  assert.equal(sends, 0);
});

test("three long files disclose only actual budget-selected coverage in the same reply", async () => {
  const sent = [];
  let task;
  await handlePrivateMessage(context([file(1), file(2), file(3)]), {
    fetchEvidence: async item => ({ status: "ok", text: item.name + "\n" + "x".repeat(7900) }),
    executeChatTask: async request => { task = request; return { kind: "reply", text: "这是本轮结论。" }; },
    sendPrivateMsg: async (_uid, text) => { sent.push(text); return sentReceipt; },
  });
  const included = task.history.filter(item => item.content?.startsWith("[附件 ")).length;
  assert.ok(included >= 1 && included < 3);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith("[附件说明]"));
  assert.match(sent[0], new RegExp("已提供" + included + "份"));
  assert.match(sent[0], new RegExp("另有" + (3 - included) + "份未读取或未提供"));
  assert.doesNotMatch(sent[0], /case-\d|https:\/\//);
});

test("the short coverage notice preserves a 6000-char answer and records its actual confirmed summary", async () => {
  resetCognitionForTest();
  const answer = "x".repeat(6000 - "并非已经修复。".length) + "并非已经修复。";
  const sent = [];
  const ctx = context([file(1), file(2), file(3)], "现在修好了吗？");
  await handlePrivateMessage(ctx, {
    fetchEvidence: async () => ({ status: "unavailable", reason: "read_failed" }),
    executeChatTask: async () => ({ kind: "reply", text: answer }),
    sendPrivateMsg: async (_uid, text) => { sent.push(text); return sentReceipt; },
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length > answer.length && sent[0].length <= answer.length + 160);
  assert.ok(sent[0].startsWith("[附件说明]"));
  assert.ok(sent[0].endsWith(answer));
  assert.ok(sent[0].includes("\n\n" + answer));
  const turn = getConversationThread("60100", "private").turns.at(-1);
  assert.match(turn.assistantSummary, /并非已经修复/);
  assert.doesNotMatch(turn.assistantSummary, /已回复文件问题/);
  assert.match(turn.userSummary, /附件共3份，已提供0份/);
});

test("three zero-read cases remain separate unreadable counts and send one honest reply", async () => {
  const outcomes = [
    { status: "unsupported", reason: "unsupported_type" },
    { status: "ok", text: "  " },
    { status: "unavailable", reason: "read_failed" },
  ];
  let calls = 0;
  let request;
  const sent = [];
  const ctx = context([file(1), file(2), file(3)], "请比较三个文件");
  await handlePrivateMessage(ctx, {
    fetchEvidence: async () => outcomes[calls++],
    executeChatTask: async value => { request = value; return { kind: "reply", text: "没有可读正文，不能比较。" }; },
    sendPrivateMsg: async (_uid, text) => { sent.push(text); return sentReceipt; },
  });
  assert.equal(calls, 3);
  assert.deepEqual(ctx.attachmentCoverage, { total: 3, attempted: 3, included: 0, omitted: 0, unreadable: 3 });
  assert.equal(request.userMsg, "请比较三个文件");
  assert.ok(request.history.every(item => !item.content?.startsWith("[附件 ")));
  assert.match(request.options.currentInput, /正文完整提供0份，读取失败或不支持3份/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[附件说明\]/);
  assert.ok(sent[0].endsWith("\n\n没有可读正文，不能比较。"));
  assert.match(sent[0], /另有3份未读取或未提供/);
});

test("coverage heads a real split send even when the next chunk fails", async t => {
  const sentChunks = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), CFG.napcatApi + "/send_private_msg");
    const text = JSON.parse(options.body).message[0].data.text;
    sentChunks.push(text);
    return sentChunks.length === 1
      ? { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { message_id: 99001 } }) }
      : { ok: true, json: async () => ({ status: "failed", retcode: -1 }) };
  });
  await handlePrivateMessage(context([file(1)], "附件呢？"), {
    fetchEvidence: async () => ({ status: "unavailable", reason: "read_failed" }),
    executeChatTask: async () => ({ kind: "reply", text: "结论。" + "x".repeat(1800) }),
  });
  assert.equal(sentChunks.length, 2);
  assert.ok(sentChunks[0].startsWith("[附件说明]"));
  assert.match(sentChunks[0], /已提供0份/);
});

test("forget and permission revocation after an attachment await prevent model and send", async () => {
  for (const invalidate of [invalidateMemoryPrivacyGeneration, () => { CFG.friendWhitelist = []; }]) {
    CFG.friendWhitelist = [60100];
    let models = 0;
    let sends = 0;
    await handlePrivateMessage(context([file(1)]), {
      fetchEvidence: async () => { invalidate(); return { status: "ok", text: "late private body" }; },
      executeChatTask: async () => { models++; return { kind: "reply", text: "should not run" }; },
      sendPrivateMsg: async () => { sends++; return sentReceipt; },
    });
    assert.equal(models, 0);
    assert.equal(sends, 0);
  }
  CFG.friendWhitelist = [60100];
});

test("the private whitelist rejects files before evidence fetch or model work", async () => {
  CFG.friendWhitelist = [];
  let fetches = 0;
  let models = 0;
  try {
    await handlePrivateMessage(context([file(1)]), {
      fetchEvidence: async () => { fetches++; return { status: "ok", text: "private body" }; },
      executeChatTask: async () => { models++; return { kind: "reply", text: "should not run" }; },
    });
    assert.equal(fetches, 0);
    assert.equal(models, 0);
  } finally {
    CFG.friendWhitelist = [60100];
  }
});
