import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { CFG } from "../bridge/config.mjs";
import { parseIncomingEvent } from "../bridge/reply-handlers.mjs";
import { dispatchGroupCommand, matchSpecialGroupAction } from "../bridge/commands/action-dispatcher.mjs";
import { buildCommandReplyAsync } from "../bridge/commands/dispatcher.mjs";
import { parseConversationSummaryCommand as parse, resolveSummaryTargets, resolveSummaryRange } from "../bridge/features/conversation-summary/command.mjs";
import { selectSummaryRecords } from "../bridge/features/conversation-summary/records.mjs";
import { buildConversationSummaryRequest, generateConversationSummary, summaryFooter } from "../bridge/features/conversation-summary/prompt.mjs";
import { createConversationSummaryService } from "../bridge/features/conversation-summary/service.mjs";
import { captureSummaryMessage, forgetSummaryUser } from "../bridge/group-summary/journal.mjs";
import { createDefaultApiConfig, loadApiConfig } from "../bridge/api-providers/store.mjs";
import { handleAdminApiRequest } from "../bridge/admin-api/routes.mjs";

const NOW = Date.parse("2026-09-11T12:00:00+08:00");
const U1 = "6000000001";
const U2 = "6000000002";
const OTHER = "6000000003";
const GROUP = 2000000002;
const range = { from: NOW - 2 * 3600000, to: NOW };
const members = [{ uid: U1, name: "小林" }, { uid: U2, name: "小陈" }];

function row(uid, text, id = "one", extra = {}) {
  return { uid, text, messageId: id, nickname: uid === U1 ? "小林" : "小陈", ts: NOW - 60000, ...extra };
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-member-summary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, jobFile: path.join(root, "jobs.json"), chatLogFile: path.join(root, "legacy.json"), whitelist: [GROUP], now: NOW, delayMs: 0, ...extra };
}
function context(extra = {}) {
  return { isAtMe: true, group_id: GROUP, user_id: Number(U1), nickname: "小林", message_id: 99,
    mentions: [{ qq: String(CFG.selfUin), isBot: true }, { qq: U1, displayName: "小林" }], ...extra };
}
function model(text = "小林换线后又黑屏了，还没修好。") {
  return { ok: true, provider: "synthetic", raw: { choices: [{ message: { content: text }, finish_reason: "stop" }] } };
}

test("command grammar handles self, multiple targets and time without hijacking normal speech", () => {
  assert.equal(parse("总结一下这段代码"), null);
  assert.equal(parse("今天我们聊得不错"), null);
  assert.equal(parse("总结我").rangeText, "最近2小时");
  assert.equal(parse("分别总结 [CQ:at,qq=" + U1 + "] 今天").separate, true);
  assert.equal(parse("@QQFriend 总结我 昨天", { botNames: ["QQFriend"] }).rangeText, "昨天");
  assert.equal(matchSpecialGroupAction("总结我")?.id, "conversation-summary");
});

test("real OneBot at segments survive text cleanup and resolve the selected people", () => {
  const ctx = parseIncomingEvent({ message_type: "group", group_id: GROUP, user_id: Number(U1), message_id: 99,
    message: [{ type: "at", data: { qq: String(CFG.selfUin) } }, { type: "text", data: { text: "总结 " } },
      { type: "at", data: { qq: U1 } }, { type: "at", data: { qq: U2 } }, { type: "text", data: { text: "昨天" } }] });
  assert.equal(ctx.text, "总结  昨天");
  const targets = resolveSummaryTargets(ctx, parse(ctx.text));
  assert.deepEqual(targets.map(item => item.uid), [U1, U2]);
});

test("target selection rejects all-members, fake mentions, excess people and ambiguous self requests", () => {
  assert.throws(() => resolveSummaryTargets(context({ mentions: [{ qq: "all", isAll: true }] }), parse("总结")), /全体/);
  assert.throws(() => resolveSummaryTargets(context({ mentions: [] }), parse("总结 @小林")), /QQ 的 @/);
  assert.throws(() => resolveSummaryTargets(context({ mentions: Array.from({ length: 6 }, (_, i) => ({ qq: String(6000000010 + i) })) }), parse("总结")), /五个/);
  assert.throws(() => resolveSummaryTargets(context(), parse("总结我")), /不用再 @别人/);
  assert.deepEqual(resolveSummaryTargets(context({ mentions: [] }), parse("总结我")), [{ uid: U1, name: "小林" }]);
});

test("ranges use Shanghai dates and reject future, invalid and excessive requests", () => {
  assert.deepEqual(resolveSummaryRange("最近2小时", NOW), range);
  assert.equal(resolveSummaryRange("今天", NOW).from, Date.parse("2026-09-11T00:00:00+08:00"));
  assert.equal(resolveSummaryRange("昨天", NOW).to, Date.parse("2026-09-11T00:00:00+08:00") - 1);
  assert.equal(resolveSummaryRange("最近7天", NOW).from, Date.parse("2026-09-05T00:00:00+08:00"));
  for (const input of ["最近0小时", "最近999小时", "最近8天", "2026-09-12", "2026-09-31", "所有历史"]) assert.throws(() => resolveSummaryRange(input, NOW));
});

test("only the current group and requested time range enter the selection", t => {
  const options = fixture(t, { records: [row(U1, "本群", "one", { groupId: GROUP }), row(U1, "其他群", "two", { groupId: GROUP + 1 }), row(U1, "过期", "three", { ts: range.from - 1 })] });
  const bundle = selectSummaryRecords(GROUP, members, range, options);
  assert.deepEqual(bundle.transcript.map(item => item.text), ["本群"]);
});

test("reference context stays attributed to its author, without unrelated nearby talk", t => {
  const options = fixture(t, { records: [
    row(OTHER, "先换一根线试试", "parent", { ts: NOW - 100000 }),
    row("6000000004", "晚饭吃火锅", "unrelated", { ts: NOW - 80000 }),
    row(U1, "换过了，还是不行", "child", { replyToMessageId: "parent" }),
  ] });
  const bundle = selectSummaryRecords(GROUP, [members[0]], range, options);
  assert.equal(bundle.selected, 1); assert.equal(bundle.background, 1);
  assert.equal(bundle.transcript.find(item => item.text.includes("换一根")).target, false);
  assert.equal(bundle.transcript.some(item => item.text.includes("火锅")), false);
  const input = buildConversationSummaryRequest(bundle);
  assert.match(input.messages[0].content, /仅作背景/);
  assert.match(input.messages[0].content, /"回复":"M1"/);
});

test("same-text messages from different people survive, but one person's repetition is collapsed", t => {
  const options = fixture(t, { records: [row(U1, "我这边好了", "one"), row(U1, "我这边好了", "two"), row(U2, "我这边好了", "three")] });
  const bundle = selectSummaryRecords(GROUP, members, range, options);
  assert.deepEqual(bundle.targets.map(person => person.count), [1, 1]);
});

test("messages sharing a second keep capture order so later corrections remain later", t => {
  const options = fixture(t, { records: [row(U1, "我以为修好了", "one"), row(U1, "不对，还是没修好", "two")] });
  const bundle = selectSummaryRecords(GROUP, [members[0]], range, options);
  assert.deepEqual(bundle.transcript.map(item => item.text), ["我以为修好了", "不对，还是没修好"]);
});

test("bot output, commands, cleared placeholders and image-only messages never become target evidence", t => {
  const options = fixture(t, { records: [row(U1, "总结我", "one"), row(U1, "[图片]", "two"), row(U1, "[已按用户请求清除]", "three"), row(String(CFG.selfUin), "机器人说过的话", "four"), row(U1, "助手", "five", { role: "assistant" })] });
  assert.equal(selectSummaryRecords(GROUP, members, range, options).selected, 0);
});

test("same-name targets remain distinct and prompt omits raw QQ IDs, secrets and image URLs", t => {
  const options = fixture(t, { records: [row(U1, "sk-abcdefghijklmnopqrstuv https://private.example/image", "one", { imageUrls: ["https://private.example/image"] }), row(U2, "另一人的话", "two")] });
  const bundle = selectSummaryRecords(GROUP, members.map(item => ({ ...item, name: "同名" })), range, options);
  assert.notEqual(bundle.targets[0].name, bundle.targets[1].name);
  const prompt = buildConversationSummaryRequest(bundle);
  const text = JSON.stringify(prompt.messages);
  assert.doesNotMatch(text, /6000000001|6000000002|abcdefghijklmnopqrstuv|private\.example/);
  assert.match(prompt.systemPrompt, /说人话/);
  assert.match(prompt.systemPrompt, /不套固定/);
});

test("selection budget is balanced between targets and truncation is disclosed", t => {
  const records = Array.from({ length: 150 }, (_, i) => row(U1, '引号"'.repeat(300) + i, String(i), { ts: NOW - i * 1000 }));
  records.push(row(U2, "我只有这一条重要消息", "other"));
  const options = fixture(t, { records });
  const bundle = selectSummaryRecords(GROUP, members, range, options);
  assert.ok(bundle.transcript.some(item => item.uid === U2));
  assert.equal(bundle.sampled, true); assert.equal(bundle.truncated, true);
  const request = buildConversationSummaryRequest(bundle);
  assert.ok(request.systemPrompt.length + request.messages[0].content.length < 16000);
  assert.match(summaryFooter(bundle), /部分内容/);
});

test("journal and live rolling records merge without reintroducing forgotten messages", t => {
  const options = fixture(t, { groupChats: { [GROUP]: [row(U2, "尚未落盘的新消息", "live")] } });
  captureSummaryMessage({ group_id: GROUP, user_id: Number(U1), message_id: "journal", text: "按日记录", eventTime: NOW - 90000 }, { ...options, now: NOW });
  assert.equal(selectSummaryRecords(GROUP, members, range, options).selected, 2);
  forgetSummaryUser(U1, { ...options, now: NOW });
  assert.equal(selectSummaryRecords(GROUP, members, range, options).selected, 1);
});

test("unusable primary output invokes fallback without exposing private reasoning", async t => {
  const options = fixture(t, { records: [row(U1, "黑屏问题还没解决")] });
  const bundle = selectSummaryRecords(GROUP, members, range, options);
  const positions = [];
  const result = await generateConversationSummary(bundle, { callProvider: async (_task, position) => {
    positions.push(position);
    return position === "primary" ? { ok: true, raw: { choices: [{ message: { content: "", reasoning_content: "private-reasoning-only" } }] } } : model();
  } });
  assert.deepEqual(positions, ["primary", "fallback"]);
  assert.doesNotMatch(result.text, /private-reasoning-only/);
});

test("truncated primary responses and all-provider failure are handled explicitly", async t => {
  const options = fixture(t, { records: [row(U1, "聊天内容")] });
  const bundle = selectSummaryRecords(GROUP, members, range, options);
  const result = await generateConversationSummary(bundle, { callProvider: async () => ({ ok: true, raw: { choices: [{ finish_reason: "length", message: { content: "没说完的内容" } }] } }) });
  assert.equal(result.ok, false); assert.match(result.text, /没拿到能用/);
});

test("ordinary group members can run the command; private and unmentioned messages cannot", async t => {
  const options = fixture(t, { records: [row(U1, "黑屏还没修好")] });
  const sent = [];
  let calls = 0;
  const service = createConversationSummaryService({ ...options, sender: async value => { sent.push(value); return { status: "ok" }; }, callProvider: async () => { calls++; return model(); } });
  const ctx = context({ text: "总结 今天" });
  assert.equal(await dispatchGroupCommand({ ...ctx, isAtMe: false }, { service }), false);
  assert.equal(await dispatchGroupCommand(ctx, { service, admins: [] }), true);
  await service.wait();
  assert.equal(calls, 1); assert.equal(sent.length, 2);
  assert.match(sent[0].text, /正在看/); assert.match(sent[1].text, /黑屏/);
  assert.match(await buildCommandReplyAsync("总结我", { userId: Number(U1), admins: [] }), /不读取私聊/);
});

test("missing targets or disabled groups do not call the model", async t => {
  const options = fixture(t, { records: [row(U1, "文字")] });
  const sent = [];
  const service = createConversationSummaryService({ ...options, whitelist: [], sender: async value => sent.push(value), callProvider: () => assert.fail("no model") });
  await service.handle(context(), parse("总结"));
  assert.match(sent[0].text, /没开启/);
  const empty = createConversationSummaryService({ ...options, records: [], callProvider: () => assert.fail("no model"), sender: async value => sent.push(value) });
  await empty.handle(context(), parse("总结"));
  assert.match(sent.at(-1).text, /没找到/);
});

test("repeated event IDs and group cooldown do not start another paid request", async t => {
  const options = fixture(t, { records: [row(U1, "还有问题需要检查")] });
  let calls = 0;
  const service = createConversationSummaryService({ ...options, sender: async () => ({ status: "ok" }), callProvider: async () => { calls++; return model(); } });
  await service.handle(context(), parse("总结")); await service.wait();
  await service.handle(context(), parse("总结"));
  await service.handle(context({ message_id: 100 }), parse("总结")); await service.wait();
  assert.equal(calls, 1);
});

test("long summaries are segmented once, with only the first result segment quoting the request", async t => {
  const options = fixture(t, { records: [row(U1, "文字")] });
  const sent = [];
  const service = createConversationSummaryService({ ...options, sender: async value => { sent.push(value); return { status: "ok" }; }, callProvider: async () => model("这件事后来还没有进展。".repeat(220)) });
  await service.handle(context(), parse("总结")); await service.wait();
  assert.ok(sent.length > 3); assert.equal(sent[1].replyTo, 99);
  for (const value of sent.slice(2)) { assert.equal(value.replyTo, undefined); assert.ok(value.text.length <= 900); }
  assert.equal(service.snapshot().tasks[0].phase, "done");
});

test("forgetting during model generation blocks fallback and final sending", async t => {
  const options = fixture(t, { records: [row(U1, "需要清理的内容")] });
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const sent = [];
  const service = createConversationSummaryService({ ...options, sender: async value => { sent.push(value); return { status: "ok" }; }, callProvider: async () => {
    calls++; started(); await new Promise(resolve => { release = resolve; }); return { ok: false };
  } });
  await service.handle(context(), parse("总结")); await entered;
  forgetSummaryUser(U1, { ...options, now: NOW }); release(); await service.wait();
  assert.equal(calls, 1); assert.equal(sent.length, 1); assert.equal(service.snapshot().tasks[0].phase, "failed");
});

test("unconfirmed delivery stops instead of resending or creating a daily report marker", async t => {
  const options = fixture(t, { records: [row(U1, "文字")] });
  let sends = 0;
  const service = createConversationSummaryService({ ...options, callProvider: async () => model("聊天原话里的事情。".repeat(220)), sender: async () => { sends++; return sends === 1 ? { status: "ok" } : null; } });
  await service.handle(context(), parse("总结")); await service.wait();
  assert.equal(sends, 2); assert.equal(service.snapshot().tasks[0].reason, "send_unconfirmed");
  assert.deepEqual(fs.readdirSync(options.root), ["jobs.json"]);
  assert.doesNotMatch(fs.readFileSync(options.jobFile, "utf8"), /聊天原话|6000000001|小林/);
});

test("new API slot inherits existing daily-summary routing without rewriting saved config", t => {
  const options = fixture(t);
  const config = createDefaultApiConfig(); delete config.routes.conversation_summary;
  config.routes.group_summary = { primary: "mimo", fallback: "deepseek", reasoning: "deep" };
  const directory = path.join(options.root, ".qqfriend"); fs.mkdirSync(directory);
  const file = path.join(directory, "api-providers.json"); const before = JSON.stringify(config); fs.writeFileSync(file, before);
  assert.deepEqual(loadApiConfig({ root: options.root }).routes.conversation_summary, config.routes.group_summary);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("task metadata endpoint requires existing admin authentication", async () => {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url: "/admin/conversation-summaries", socket: { remoteAddress: "203.0.113.5" }, headers: {} });
  let code;
  await handleAdminApiRequest(req, {}, { pathname: req.url, requiredToken: "test-only", sendJson(_res, value) { code = value; } });
  assert.equal(code, 403);
});
