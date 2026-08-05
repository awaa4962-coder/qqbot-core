import {
  isSummaryBotMessage,
  prepareSummaryEvidence,
  summaryUserKey,
} from "./evidence.mjs";
import { redactSummaryText } from "./formatter.mjs";

export function buildSummaryStats(messages, options = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const evidence = options.evidence || prepareSummaryEvidence(items, options);
  const humanSpeakers = new Set();
  const userMap = {};

  for (const message of items) {
    if (!isSummaryBotMessage(message, options)) humanSpeakers.add(summaryUserKey(message));
  }
  for (const message of evidence.messages) {
    const key = summaryUserKey(message);
    if (!userMap[key]) {
      userMap[key] = {
        nick: redactSummaryText(message.nickname || "群友").slice(0, 40),
        count: 0,
      };
    }
    userMap[key].count++;
  }
  const users = Object.values(userMap).sort((a, b) => b.count - a.count);
  return {
    messageCount: items.length,
    effectiveMessageCount: evidence.messages.length,
    speakerCount: humanSpeakers.size,
    top3: users.slice(0, 3).map(u => `${u.nick}（${u.count}条）`).join("、") || "暂无",
    filtered: { ...evidence.metrics },
  };
}
