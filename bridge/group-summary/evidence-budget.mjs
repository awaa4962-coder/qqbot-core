import { boundedEvidenceText } from "./journal.mjs";

export function budgetDiscussionEvidence(discussions, options = {}) {
  const budget = Math.max(512, Math.min(60000, Number(options.evidenceBudgetChars) || 36000));
  const limit = Math.min(1000, Math.floor(budget / 5));
  const records = discussions.flatMap(discussion => discussion.messages)
    .sort((a, b) => a.ts - b.ts)
    .map(item => ({ ...item, text: boundedEvidenceText(item.text, limit), evidenceTruncated: item.text.length > limit }));
  const cost = item => item.text.length + String(item.nickname || "").length + 56;
  const totalCost = records.reduce((sum, item) => sum + cost(item), 0);
  const chosen = new Map();
  let remaining = budget;
  const order = totalCost <= budget ? records.map((_item, index) => index) : spreadIndices(records.length);
  for (const index of order) {
    const item = records[index];
    if (cost(item) > remaining) continue;
    chosen.set(item.evidenceId, item); remaining -= cost(item);
  }
  return {
    discussions: discussions.map(discussion => ({
      id: discussion.id, messageCount: discussion.messages.length,
      messages: discussion.messages.filter(item => chosen.has(item.evidenceId)).map(item => chosen.get(item.evidenceId)),
    })).filter(discussion => discussion.messages.length),
    selection: { total: records.length, included: chosen.size, sampled: chosen.size < records.length,
      truncated: [...chosen.values()].filter(item => item.evidenceTruncated).length, chars: budget - remaining, budget },
  };
}

function spreadIndices(length) {
  if (!length) return [];
  const result = [0];
  if (length === 1) return result;
  result.push(length - 1);
  // Cover the whole day before filling smaller intervals; never take just its prefix.
  const intervals = [[1, length - 2]];
  for (let cursor = 0; cursor < intervals.length; cursor++) {
    const [left, right] = intervals[cursor];
    if (left > right) continue;
    const middle = Math.floor((left + right) / 2);
    result.push(middle);
    intervals.push([left, middle - 1], [middle + 1, right]);
  }
  return result;
}
