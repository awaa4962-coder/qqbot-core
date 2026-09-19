// scripts/send-summary-for-date.mjs - manually generate and send a group summary for one date.
import { pathToFileURL } from "node:url";
import { CFG } from "../bridge/config.mjs";
import { resolveSummaryDate, sendGroupSummaryForDate } from "../bridge/group-summary.mjs";
import { summaryKey } from "../bridge/group-summary/state.mjs";

export function parseSummaryDateArgs(args, options = {}) {
  let dateText;
  let group;
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--group" || arg.startsWith("--group=")) {
      if (group !== undefined) throw new Error("Specify the group only once");
      group = arg === "--group" ? args[++index] : arg.slice("--group=".length);
      if (!/^\d+$/.test(group || "")) throw new Error("--group requires a positive group ID");
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg) && dateText === undefined) dateText = arg;
    else if (/^\d+$/.test(arg) && group === undefined) group = arg;
    else throw new Error("Usage: summary:date [YYYY-MM-DD] [--group GROUP_ID] [--dry-run]");
  }
  group = resolveCommandGroup(group, options);
  dateText ||= resolveSummaryDate(options.now);
  summaryKey(dateText, group);
  return { dateText, groupId: Number(group), dryRun };
}

function resolveCommandGroup(group, options) {
  if (group !== undefined) return group;
  const groups = [...new Set((options.groupWhitelist || CFG.summaryGroupWhitelist).map(String))];
  if (groups.length !== 1) throw new Error("Specify --group when the summary whitelist does not contain exactly one group");
  return groups[0];
}

export async function runSummaryForDateCli(args, options = {}) {
  const parsed = parseSummaryDateArgs(args, options);
  const result = await (options.run || sendGroupSummaryForDate)({ ...options, ...parsed });
  const success = Boolean(result.ok === true && !result.pending &&
    (parsed.dryRun || result.sent || (result.skipped && result.reason === "already_sent")));
  return {
    exitCode: success ? 0 : 1,
    output: {
      status: result.pending ? "pending" : !success ? "failed" : result.skipped ? "skipped" : result.sent ? "sent" : "generated",
      date: parsed.dateText, groupId: parsed.groupId, ok: success,
      messages: result.messages, outputFile: result.outputFile, sent: Boolean(result.sent),
      reason: result.reason || result.error, message: result.message,
      summary: parsed.dryRun ? result.summary : undefined,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { exitCode, output } = await runSummaryForDateCli(process.argv.slice(2));
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", error: error.message }));
    process.exitCode = 1;
  }
}
