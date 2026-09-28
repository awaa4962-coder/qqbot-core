import { compareRelevance, messageFeatures, retrievalFeatures } from "../context/relevance.mjs";
import { prepareSummaryEvidence, summaryUserKey } from "./evidence.mjs";
import { redactSummaryText } from "./formatter.mjs";
import { budgetDiscussionEvidence } from "./evidence-budget.mjs";
export { parseSummaryDocument, parseSummaryDocumentResult } from "./document.mjs";
import { buildSummaryStats } from "./stats.mjs";
import { getSummaryStyle } from "./styles.mjs";
import { dateLabel, dateRange, formatDate } from "./date.mjs";
import { DEFAULT_SUMMARY_GROUP_NAME } from "./constants.mjs";

const UPDATE_RE = /仍|还是|没好|失败|修好|解决|确认|决定|完成|纠正|其实|改成|不对|验证|恢复/;

export function buildDiscussionBundle(messages, options = {}) {
  const evidence = prepareSummaryEvidence(messages, options);
  const actors = new Map();
  const byMessage = new Map();
  const discussions = [];
  for (const [index, message] of evidence.messages.entries()) {
    const uid = summaryUserKey(message);
    if (!actors.has(uid)) actors.set(uid, "P" + (actors.size + 1));
    const item = {
      uid, messageId: String(message.messageId || ""), replyToMessageId: String(message.replyToMessageId || ""),
      text: redactSummaryText(message.text), ts: Number(message.ts || 0),
      nickname: redactSummaryText(message.nickname || "群友").slice(0, 40),
      evidenceId: "E" + String(index + 1).padStart(4, "0"), actorId: actors.get(uid),
    };
    let discussion = byMessage.get(String(item.replyToMessageId || "")) || relatedDiscussion(item, discussions);
    if (!discussion) {
      discussion = { id: "D" + String(discussions.length + 1).padStart(3, "0"), messages: [] };
      discussions.push(discussion);
    }
    discussion.messages.push(item);
    if (item.messageId) byMessage.set(String(item.messageId), discussion);
  }
  return { ...budgetDiscussionEvidence(discussions, options), stats: buildSummaryStats(messages, { ...options, evidence }), filtered: evidence.metrics };
}

function relatedDiscussion(item, discussions) {
  const features = messageFeatures(item);
  let best = null;
  let score = 0;
  for (const discussion of discussions.slice(-30)) {
    const last = discussion.messages.at(-1);
    const gap = Number(item.ts) - Number(last.ts);
    if (gap < 0 || gap > 45 * 60000) continue;
    const match = Math.max(...discussion.messages.slice(-4).map(message => compareRelevance(features, messageFeatures(message)).score));
    if (match > score) { best = discussion; score = match; }
  }
  if (best) return best;
  if (!UPDATE_RE.test(item.text) || item.text.length > 30) return null;
  return discussions.slice(-30).reverse().find(discussion => {
    const last = discussion.messages.at(-1);
    return summaryUserKey(last) === summaryUserKey(item) && Number(item.ts) - Number(last.ts) < 3 * 60000;
  }) || null;
}

export function buildStructuredSummaryPrompt(bundle, options) {
  const style = getSummaryStyle(options.style);
  const reportStart = dateRange(options.dateText).start;
  const previousDate = formatDate(new Date(reportStart - 86400000));
  const nextDate = formatDate(new Date(reportStart + 86400000));
  const exampleId = options.onlyDiscussionId || bundle.discussions[0]?.id || "D001";
  const exampleEvidence = bundle.discussions.find(item => item.id === exampleId)?.messages[0]?.evidenceId || "E0001";
  const lines = bundle.discussions.map(discussion => {
    const messages = discussion.messages.map(item => {
      const time = new Date(Number(item.ts)).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      return `${item.evidenceId} ${time} ${item.actorId}（${redactSummaryText(item.nickname || "群友")}）：${item.text}`;
    });
    return discussion.id + "\n" + messages.join("\n");
  }).join("\n\n");
  return `本次日报数据：
群名：${options.groupName || DEFAULT_SUMMARY_GROUP_NAME}
聊天发生日：${options.dateText}
日期基准：今天/今晚=${options.dateText}，昨天=${previousDate}，明天/明晚=${nextDate}。
讨论上限：${style.maxTopics}
本次重写范围：${options.onlyDiscussionId ? "仅 " + options.onlyDiscussionId + "（一个 topic）" : "全日报"}

本次编号示例：
{"headline":"当天最重要的实际变化，没有主线可留空","headlineEvidenceIds":["${exampleEvidence}"],"topics":[{"id":"${exampleId}","title":"具体主题","body":"结论或进展在前，必要依据在后","status":"open","evidenceIds":["${exampleEvidence}"]}]}

证据：
${lines}`;
}

export function localSummaryDocument(bundle) {
  return { headline: "", headlineEvidenceIds: [], local: true, topics: bundle.discussions.slice(0, 3).map((item, index) => {
    return {
      id: item.id, title: localTopicLabel(item.messages[0]?.text, index),
      body: `采集到 ${item.messageCount} 条相关记录。`,
      status: "chat", evidenceIds: item.messages.map(message => message.evidenceId),
    };
  }) };
}

function localTopicLabel(text, index) {
  const names = { download: "文件下载", archive: "压缩文件", jm: "资源下载", driver: "驱动排查", network: "网络连接", reply: "机器人回复", summary: "群日报", memory: "记忆与上下文", image: "图片交流", model: "模型讨论" };
  for (const concept of retrievalFeatures(text).concepts) if (names[concept]) return names[concept];
  return "讨论片段 " + (index + 1);
}

export function renderSummaryDocument(document, bundle, options) {
  const lines = [`【${dateLabel(options.dateText)} 群聊日报】`];
  if (document.headline) lines.push("", "当日重点", document.headline);
  if (document.local) lines.push("", "以下仅列采集线索，不推测讨论结果。");
  if (document.topics.length) lines.push("", document.local ? "采集线索" : "讨论进展", ...document.topics.map(item => "• " + item.title + "：" + item.body));
  else lines.push("", "采集到的有效讨论较少，暂不推测当天主线。");
  lines.push("", `已采集：${bundle.stats.messageCount} 条记录，${bundle.stats.speakerCount} 位参与者。`);
  if (bundle.selection?.sampled || bundle.selection?.truncated) lines.push(`本次分析使用 ${bundle.selection.included}/${bundle.selection.total} 条有效文字，部分内容按预算抽样或截短。`);
  if (options.coverage?.source === "retained-only" || options.coverage?.capped || options.coverage?.malformed) lines.push("本次记录可能不完整，以上仅概括已采集内容。");
  return lines.join("\n");
}
