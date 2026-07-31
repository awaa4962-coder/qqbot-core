import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchMemes } from "../bridge/knowledge/memes/index.mjs";
import { isMemeLearningExcluded } from "../bridge/knowledge/memes/message-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chats = JSON.parse(fs.readFileSync(path.join(ROOT, "group_chats.json"), "utf8"));
const strict = process.argv.includes("--strict");
const totals = {
  messages: 0,
  matched: 0,
  autoMatched: 0,
  shortAutoMatched: 0,
};
const terms = new Map();

for (const [groupId, messages] of Object.entries(chats)) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "member") continue;
    const text = String(message.text || "").trim();
    if (!text || isMemeLearningExcluded(text)) continue;
    totals.messages += 1;
    const matches = matchMemes(text, { groupId });
    if (!matches.length) continue;
    totals.matched += 1;
    if (matches.some(item => item.source === "auto")) totals.autoMatched += 1;
    if (matches.some(item => item.source === "auto" && [...item.matched].length <= 2)) {
      totals.shortAutoMatched += 1;
    }
    for (const item of matches) terms.set(item.name, Number(terms.get(item.name) || 0) + 1);
  }
}

const report = {
  messages: totals.messages,
  matched: ratio(totals.matched, totals.messages),
  autoMatched: ratio(totals.autoMatched, totals.messages),
  shortAutoMatched: ratio(totals.shortAutoMatched, totals.messages),
  topTerms: [...terms.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([term, count]) => ({ term, count })),
  thresholds: {
    matched: 0.05,
    shortAutoMatched: 0.01,
  },
};

console.log(JSON.stringify(report, null, 2));
if (strict && (report.matched.rate > 0.05 || report.shortAutoMatched.rate > 0.01)) {
  process.exitCode = 1;
}

function ratio(count, total) {
  return {
    count,
    rate: total ? Number((count / total).toFixed(4)) : 0,
    percent: total ? Number((count / total * 100).toFixed(2)) + "%" : "0%",
  };
}
