import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-material-session-"));
Object.assign(process.env, { NODE_ENV: "test", QQBOT_CONFIG_ROOT: root, QQBOT_DATA_DIR: path.join(root, "data"), QQBOT_LOG_DIR: path.join(root, "logs") });
const { withChatRun, currentChatScope } = await import("../bridge/cognition/chat-run.mjs");
const { createChatToolSession } = await import("../bridge/chat-tools/session.mjs");
const { createDraftTaskService } = await import("../bridge/chat-tools/draft-tasks.mjs");
const { invalidateMemoryPrivacyGeneration } = await import("../bridge/memory-profile/generation.mjs");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const scope = { surface: "group", groupId: "50150", userId: "60150", messageId: "70150" };
const file = { name: "notes.txt", url: "https://synthetic.invalid/notes.txt", size: 50 };
const config = () => ({ dataRoot: root, groupWhitelist: [50150], botBlacklist: [], agentGroupWhitelist: [50150],
  agentMaterialGroupWhitelist: [50150], agentDraftGroupWhitelist: [50150], summaryGroupWhitelist: [50150], conversationSummaryGroupWhitelist: [50150] });
const call = (name, args, id = "tool-1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const decode = reply => JSON.parse(reply.content);
let nextMessage = 80150;
async function inRun(cfg, operation) {
  let executed = false;
  const result = await withChatRun({ ...scope, messageId: String(++nextMessage) }, async () => {
    executed = true;
    return await operation();
  }, { cfg });
  assert.equal(executed, true, "the real chat handler must execute, not return a duplicate fence");
  return result;
}
const create = (cfg, overrides = {}) => createChatToolSession({ scope, cfg, task: "group_chat", mentioned: true,
  currentMessageId: currentChatScope()?.currentMessageId ?? scope.messageId, userMessage: "总结今天的聊天，先读附件的第一行", attachments: [file], ...overrides });

test("file refs reach model context without body, URL or private identity, then read only on demand", async () => {
  const cfg = config(); let fetched = 0;
  await inRun(cfg, async () => {
    const session = create(cfg, { fetchAttachmentEvidence: async () => { fetched++; return { status: "ok", text: "first\nsecond\nthird" }; } });
    const initial = session.sourceContext();
    assert.equal(fetched, 0);
    assert.doesNotMatch(JSON.stringify(initial), /https:|first|second|50150|60150|70150/);
    const ref = JSON.parse(initial.find(row => row.content.includes("附件引用")).content.split("\n")[1]).attachments[0].attachment_ref;
    const result = decode(await session.execute(call("read_current_attachment", { attachment_ref: ref, start_line: 1, end_line: 1 }), session.definitions(), {}));
    assert.equal(fetched, 1);
    assert.equal(result.status, "ok");
    assert.equal(result.text, "first");
    assert.equal(result.coverage.remaining, 2);
    assert.ok(JSON.stringify(result).length <= 2000);
  });
});

test("empty attachments and unmatched queries retain their truthful coverage instead of becoming failures", async () => {
  for (const [text, query, total] of [["", undefined, 0], ["first\nsecond", "absent", 2]]) {
    const cfg = config();
    await inRun(cfg, async () => {
      const session = create(cfg, { fetchAttachmentEvidence: async () => ({ status: "ok", text }) });
      const ref = JSON.parse(session.sourceContext().find(row => row.content.includes("附件引用")).content.split("\n")[1]).attachments[0].attachment_ref;
      const result = decode(await session.execute(call("read_current_attachment", { attachment_ref: ref, ...(query ? { query } : {}) }), session.definitions(), {}));
      assert.equal(result.status, "empty"); assert.equal(result.coverage.totalLines, total);
      assert.equal(result.coverage.sourceComplete, true); assert.equal(result.coverage.remaining, total);
      assert.match(JSON.stringify(session.fallbackContext()), /status.*empty/);
    });
  }
});

test("phase allowlists are independent, default closed and cannot be forged by declarations", async () => {
  const cfg = config(); cfg.agentMaterialGroupWhitelist = []; cfg.agentDraftGroupWhitelist = [];
  await inRun(cfg, async () => {
    const session = create(cfg, { fetchAttachmentEvidence: () => assert.fail("closed file downloaded") });
    assert.ok(session.definitions().every(tool => !["read_current_attachment", "draft_chat_summary", "read_draft_task"].includes(tool.function.name)));
    const forged = [{ type: "function", function: { name: "read_current_attachment" } }];
    assert.equal(decode(await session.execute(call("read_current_attachment", { attachment_ref: "att_forged" }), forged, {})).status, "denied");
  });
});

test("old caller message material is not silently rebound to a new active message", async () => {
  const cfg = config();
  const draftTaskService = createDraftTaskService({ cfg, filename: path.join(root, "missing-message-jobs.json"),
    createAdapter: () => assert.fail("missing message launched a draft") });
  await inRun(cfg, async () => {
    assert.throws(() => create(cfg, { currentMessageId: "70150" }), /reply_superseded/);
    const session = create(cfg, { currentMessageId: undefined, draftTaskService });
    assert.equal(session.definitions().some(tool => tool.function.name === "read_current_attachment"), false);
    assert.equal(session.sourceContext().some(row => row.content.includes("附件引用")), false);
    assert.equal(decode(await session.execute(call("draft_chat_summary", { kind: "daily" }), session.definitions(), {})).status, "invalid_arguments");
  });
});

test("explicitly negated summaries never declare or execute a draft model", async () => {
  const cfg = config();
  await inRun(cfg, async () => {
    const session = create(cfg, { attachments: [], userMessage: "不要总结今天的聊天", callNestedModel: () => assert.fail("negated model ran") });
    assert.equal(session.definitions().some(tool => tool.function.name === "draft_chat_summary"), false);
    assert.equal(decode(await session.execute(call("draft_chat_summary", { kind: "daily" }), [call("draft_chat_summary", {})], {})).status, "denied");
    assert.equal(session.snapshot().transportAttempts, 0);
  });
});

test("nested draft models reserve from the same rounds and actual attempt counters", async () => {
  const cfg = config(); let hooks = 0, validations = 0, calls = 0;
  const taskService = createDraftTaskService({ cfg, filename: path.join(root, "nested-jobs.json"), createAdapter: runtime => ({ generate: async () => {
    for (const position of ["primary", "fallback"]) await runtime.callModel("group_summary", position,
      { systemPrompt: "synthetic summary system", messages: [{ role: "user", content: "source data" }], maxTokens: 1536,
        beforeAttempt: () => { hooks++; return ""; }, validatePrepared: () => { validations++; } });
    return { ok: true, text: "合成草稿", coverage: { partial: true }, sent: false, persisted: false };
  } }) });
  await inRun(cfg, async () => {
    const session = create(cfg, { attachments: [], draftTaskService: taskService,
      callNestedModel: async (_task, _position, request) => {
        calls++; request.validatePrepared(request); assert.equal(request.beforeAttempt(), "");
        assert.equal(request.beforeAttempt(), ""); assert.equal(request.tools.length, 0);
        assert.ok(request.messages.some(message => message.content === "synthetic summary system"));
        return { ok: true };
      } });
    assert.equal(session.prepareModel({ messages: [{ role: "user", content: "current question" }], maxTokens: 1536 }).beforeAttempt(), "");
    const result = decode(await session.execute(call("draft_chat_summary", { kind: "daily" }), session.definitions(), {}));
    assert.equal(result.status, "ok");
    assert.equal(result.sent, false);
    assert.equal(result.persisted, false);
    assert.equal(calls, 2); assert.equal(hooks, 4); assert.equal(validations, 2);
    assert.equal(session.snapshot().modelRounds, 3);
    assert.equal(session.snapshot().transportAttempts, 5);
    assert.equal(session.prepareModel({ messages: [{ role: "user", content: "final answer" }] }).beforeAttempt(), "");
    assert.equal(session.snapshot().modelRounds, 4);
    assert.equal(session.remainingModels(), 0);
  });
});

test("scope erasure rejects a late attachment and removes fallback evidence", async () => {
  const cfg = config();
  await inRun(cfg, async () => {
    const session = create(cfg, { fetchAttachmentEvidence: async () => {
      invalidateMemoryPrivacyGeneration(); return { status: "ok", text: "must not survive erasure" };
    } });
    const ref = JSON.parse(session.sourceContext().find(row => row.content.includes("附件引用")).content.split("\n")[1]).attachments[0].attachment_ref;
    await assert.rejects(session.execute(call("read_current_attachment", { attachment_ref: ref }), session.definitions(), {}), /privacy_changed/);
    assert.throws(session.fallbackContext, /privacy_changed/);
  });
});

test("nested drafts cannot consume the final round and eight physical attempts remain a hard shared cap", async () => {
  const cfg = config(); let calls = 0;
  const taskService = createDraftTaskService({ cfg, filename: path.join(root, "budget-jobs.json"), createAdapter: runtime => ({ generate: async () => {
    for (let index = 0; index < 3; index++) await runtime.callModel("group_summary", "primary", { messages: [{ role: "user", content: "synthetic evidence" }] });
    assert.fail("the third nested model must never run");
  } }) });
  await inRun(cfg, async () => {
    const session = create(cfg, { attachments: [], draftTaskService: taskService, callNestedModel: async (_task, _position, prepared) => {
      calls++; assert.equal(prepared.maxAttempts, 2);
      assert.equal(prepared.beforeAttempt(), ""); assert.equal(prepared.beforeAttempt(), "");
      return { ok: true };
    } });
    const initial = session.prepareModel({ messages: [{ role: "user", content: "question" }] });
    assert.equal(initial.beforeAttempt(), ""); assert.equal(initial.beforeAttempt(), "");
    const draft = decode(await session.execute(call("draft_chat_summary", { kind: "daily" }), session.definitions(), {}));
    assert.equal(draft.status, "unavailable"); assert.equal(calls, 2);
    assert.equal(session.snapshot().modelRounds, 3); assert.equal(session.snapshot().transportAttempts, 6);
    const final = session.prepareModel({ messages: [{ role: "user", content: "final answer" }] });
    assert.equal(final.beforeAttempt(), ""); assert.equal(final.beforeAttempt(), "");
    assert.equal(final.beforeAttempt(), "tool_budget"); assert.equal(session.snapshot().transportAttempts, 8);
    assert.throws(() => session.prepareModel({ messages: [] }), /tool_budget/);
  });
});

test("invalid booleans cannot start drafts and business allowlist withdrawal stops an existing session", async () => {
  const cfg = config(); let started = 0;
  const taskService = { initialReferences: () => [], generate: () => { started++; assert.fail("invalid draft started"); } };
  await inRun(cfg, async () => {
    const session = create(cfg, { attachments: [], draftTaskService: taskService });
    const result = decode(await session.execute(call("draft_chat_summary", { kind: "daily", separate: "true" }), session.definitions(), {}));
    assert.equal(result.status, "invalid_arguments"); assert.equal(started, 0);
    cfg.summaryGroupWhitelist = [];
    assert.throws(session.assertCurrent, /tool_configuration_changed/);
    assert.throws(session.fallbackContext, /tool_configuration_changed/);
  });
});

test("summary privacy changes also invalidate cached draft evidence before the final model, without restoring old sessions", async () => {
  const cfg = config();
  const taskService = createDraftTaskService({ cfg, filename: path.join(root, "privacy-jobs.json"), createAdapter: () => ({ generate: async () => ({
    ok: true, text: "old synthetic draft", coverage: { partial: true }, sent: false, persisted: false,
  }) }) });
  await inRun(cfg, async () => {
    const session = create(cfg, { attachments: [], draftTaskService: taskService });
    assert.equal(decode(await session.execute(call("draft_chat_summary", { kind: "daily" }), session.definitions(), {})).status, "ok");
    const filename = path.join(root, ".qqfriend", "summaries", "privacy.json");
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify({ epoch: 1, users: {} }));
    assert.throws(session.fallbackContext, /privacy_changed/);
    assert.throws(() => session.prepareModel({ messages: [{ role: "user", content: "final" }] }), /privacy_changed/);
    fs.writeFileSync(filename, JSON.stringify({ epoch: 0, users: {} }));
    assert.throws(session.assertCurrent, /privacy_changed/);
  });
});
