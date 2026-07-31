// Daily summary entrypoint. Each configured group has an independent guard.

import fs from "node:fs";
import path from "node:path";

import { CFG } from "./bridge/config.mjs";
import { runDailySummaries } from "./bridge/group-summary/index.mjs";

function logSummary(event, detail = {}) {
  const timestamp = new Date().toISOString();
  const line = "[" + timestamp + "] " + event + " " + JSON.stringify(detail) + "\n";
  const logFile = path.join(CFG.logDir, "summary-" + timestamp.slice(0, 10) + ".log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, line, "utf8");
  process.stdout.write(line);
}

const result = await runDailySummaries({
  log: logSummary,
});

logSummary("complete", {
  dateText: result.dateText,
  groups: result.groups,
  sent: result.sent,
  ok: result.ok,
});

if (!result.ok) process.exitCode = 1;
