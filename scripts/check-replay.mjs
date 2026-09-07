import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-replay-check-"));
Object.assign(process.env, {
  NODE_ENV: "test", QQBOT_CONFIG_ROOT: sandbox, QQBOT_DATA_DIR: sandbox,
  QQBOT_LOG_DIR: sandbox, QQBOT_MEMORY_PROFILE_FILE: path.join(sandbox, "profiles.json"),
});
try {
  const { runReplayChecks } = await import("../bridge/diagnostics/replay.mjs");
  const result = runReplayChecks();
  for (const check of result.checks) console.log((check.ok ? "PASS " : "FAIL ") + check.name);
  console.log(result.checks.filter(item => item.ok).length + "/" + result.checks.length + " checks passed; no model calls or QQ sends.");
  if (!result.ok) process.exitCode = 1;
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
