import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CFG } from "../../config.mjs";
import { monotonicNow } from "../../runtime-clock.mjs";
import { createTaskRunner } from "../../tasks/runner.mjs";
import { sendTextToGroup, splitLongText } from "../../outbound-message.mjs";
import { isSuccessfulOutbound } from "../../cognition/outcome.mjs";
import { assertSummaryEpoch } from "../../group-summary/state.mjs";
import { conversationSummaryHelp, resolveSummaryRange, resolveSummaryTargets } from "./command.mjs";
import { selectSummaryRecords } from "./records.mjs";
import { generateConversationSummary, summaryFooter } from "./prompt.mjs";

export function createConversationSummaryService(options = {}) {
  const tasks = createTaskRunner({
    filename: options.jobFile || path.join(CFG.dataRoot, ".qqfriend", "tasks", "conversation-summaries.json"),
    maxConcurrent: 2, historyLimit: 30, busyMessage: "这个群的总结还没做完，稍等一下。",
    resultError: result => result.error || "总结未完成，请稍后查看任务状态。",
    describeResult: result => ({ sent: Boolean(result.sent), provider: result.provider || "", reason: result.reason || "" }),
  });
  const lastStarted = new Map();
  const seen = new Set();
  const clock = options.clock || monotonicNow;
  const sender = options.sender || (payload => sendTextToGroup({ ...payload, maxAttempts: 1 }));
  const allowed = group => (options.whitelist || CFG.conversationSummaryGroupWhitelist).map(String).includes(String(group));

  async function handle(ctx, parsed) {
    if (!ctx?.isAtMe || !ctx.group_id) return false;
    if (parsed.help) { await notify(ctx, conversationSummaryHelp()); return true; }
    if (!allowed(ctx.group_id)) { await notify(ctx, "这个群还没开启成员聊天总结，请管理员在配置里添加“聊天总结群”。"); return true; }
    const eventKey = ctx.message_id ? String(ctx.group_id) + ":" + ctx.message_id : "";
    if (eventKey && seen.has(eventKey)) return true;
    try {
      const targets = resolveSummaryTargets(ctx, parsed, options);
      const range = resolveSummaryRange(parsed.rangeText, options.now ?? Date.now());
      const bundle = selectSummaryRecords(ctx.group_id, targets, range, { ...options, excludeMessageId: ctx.message_id });
      if (!bundle.selected) { await notify(ctx, "这段时间没找到可总结的发言。可以换个时间范围试试，但没收到的消息我补不回来。"); return true; }
      if (clock() - (lastStarted.get(String(ctx.group_id)) ?? -Infinity) < (options.cooldownMs ?? 60000)) {
        await notify(ctx, "这个群刚做过总结，隔一分钟再试吧。"); return true;
      }
      await launch(ctx, parsed, bundle, eventKey);
    } catch (error) { await notify(ctx, publicError(error)); }
    return true;
  }

  async function launch(ctx, parsed, bundle, eventKey) {
    let acknowledged;
    const gate = new Promise(resolve => { acknowledged = resolve; });
    tasks.start({ scope: String(ctx.group_id), action: "conversation-summary", meta: {
      groupId: String(ctx.group_id), targetCount: bundle.targets.length, from: bundle.range.from, to: bundle.range.to,
    }, run: async ({ progress }) => {
      await gate;
      return await complete(ctx, parsed, bundle, progress);
    } });
    lastStarted.set(String(ctx.group_id), clock());
    if (eventKey) seen.add(eventKey);
    while (lastStarted.size > 200) lastStarted.delete(lastStarted.keys().next().value);
    while (seen.size > 500) seen.delete(seen.values().next().value);
    try { await notify(ctx, "正在看这段聊天，整理好了就发出来。"); }
    finally { acknowledged(); }
  }

  async function complete(ctx, parsed, bundle, progress) {
    try {
      assertSummaryEpoch(bundle.privacyEpoch, options);
      const result = await generateConversationSummary(bundle, { ...options, separate: parsed.separate, userId: ctx.user_id, onProgress: progress,
        beforeCall: () => assertSummaryEpoch(bundle.privacyEpoch, options) });
      const text = result.ok ? result.text + "\n\n" + summaryFooter(bundle) : result.text;
      progress("sending");
      const chunks = splitLongText(text, 900);
      for (const [index, chunk] of chunks.entries()) {
        assertSummaryEpoch(bundle.privacyEpoch, options);
        if (!allowed(ctx.group_id)) throw new Error("group_disabled");
        const receipt = await sender({ groupId: ctx.group_id, text: chunk, replyTo: index === 0 ? ctx.message_id : undefined });
        if (!isSuccessfulOutbound(receipt)) return { ok: false, reason: "send_unconfirmed", error: "发送结果未确认，没有自动重发。" };
        if (index + 1 < chunks.length) await delay(options.delayMs ?? 300);
      }
      return { ok: result.ok, sent: true, provider: result.provider, reason: result.reason };
    } catch {
      return { ok: false, sent: false, reason: "records_changed_or_send_failed", error: "记录已变化或发送失败，旧总结不会自动重发。" };
    }
  }

  async function notify(ctx, text) {
    try { await sender({ groupId: ctx.group_id, text, replyTo: ctx.message_id }); } catch { /* Do not turn a failed notification into a repeated task. */ }
  }
  return { handle, snapshot: () => ({ tasks: tasks.list() }), wait: tasks.wait };
}

export const conversationSummaryService = createConversationSummaryService();

function publicError(error) {
  const message = String(error?.message || "");
  if (error?.code || /[\\/]/.test(message) || !/[\u4e00-\u9fff]/.test(message)) return "这次没能开始总结，请稍后再试。";
  return message.slice(0, 180);
}
