// scripts/send-summary-for-date.mjs - manually generate and send a group summary for one date.
import { resolveSummaryDate, sendGroupSummaryForDate } from "../bridge/group-summary.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateArg = args.find(arg => !arg.startsWith("--")) ||
  resolveSummaryDate();

const result = await sendGroupSummaryForDate({ dateText: dateArg, dryRun });
console.log(JSON.stringify({
  status: dryRun ? "generated" : "sent",
  date: dateArg,
  messages: result.messages,
  outputFile: result.outputFile,
  sent: result.sent,
}, null, 2));
