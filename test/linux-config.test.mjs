import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Linux environment overrides connection and stream settings without changing defaults", async () => {
  const configUrl = pathToFileURL(path.join(ROOT, "bridge", "config.mjs")).href;
  const configRoot = path.join(ROOT, "dist", "linux-config-root-test");
  const dataRoot = path.join(ROOT, "dist", "linux-data-root-test");
  const logRoot = path.join(ROOT, "dist", "linux-log-root-test");
  const source = [
    `const { CFG } = await import(${JSON.stringify(configUrl)});`,
    "process.stdout.write(JSON.stringify({",
    "  napcatApi: CFG.napcatApi,",
    "  napcatWsApi: CFG.napcatWsApi,",
    "  napcatAccessToken: CFG.napcatAccessToken,",
    "  napcatStreamRequired: CFG.napcatStreamRequired,",
    "  napcatStreamChunkBytes: CFG.napcatStreamChunkBytes,",
    "  listenHost: CFG.listenHost,",
    "  listenPort: CFG.listenPort,",
    "  webConsoleEnabled: CFG.webConsoleEnabled,",
    "  summaryScheduler: CFG.summaryScheduler,",
    "  configRoot: CFG.configRoot,",
    "  adminAuditFile: CFG.adminAuditFile,",
    "  memoryProfileFile: CFG.memoryProfileFile,",
    "}));",
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      QQBOT_NAPCAT_API: "http://napcat.internal:6700/",
      QQBOT_NAPCAT_WS_API: "ws://napcat.internal:3001",
      QQBOT_NAPCAT_TOKEN: "test-napcat-token",
      QQBOT_NAPCAT_STREAM_REQUIRED: "1",
      QQBOT_NAPCAT_STREAM_CHUNK_BYTES: String(2 * 1024 * 1024),
      QQBOT_CONFIG_ROOT: configRoot,
      QQBOT_DATA_DIR: dataRoot,
      QQBOT_LOG_DIR: logRoot,
      QQBOT_LISTEN_HOST: "127.0.0.1",
      QQBOT_LISTEN_PORT: "17689",
      QQFRIEND_WEB_CONSOLE: "1",
      QQBOT_SUMMARY_SCHEDULER: "systemd-user-timer",
    },
  });
  const value = JSON.parse(stdout);
  assert.equal(value.napcatApi, "http://napcat.internal:6700");
  assert.equal(value.napcatWsApi, "ws://napcat.internal:3001");
  assert.equal(value.napcatAccessToken, "test-napcat-token");
  assert.equal(value.napcatStreamRequired, true);
  assert.equal(value.napcatStreamChunkBytes, 1024 * 1024);
  assert.equal(value.listenHost, "127.0.0.1");
  assert.equal(value.listenPort, 17689);
  assert.equal(value.webConsoleEnabled, true);
  assert.equal(value.summaryScheduler, "systemd-user-timer");
  assert.equal(value.configRoot, configRoot);
  assert.equal(value.adminAuditFile, path.join(logRoot, "admin-audit.log"));
  assert.equal(value.memoryProfileFile, path.join(dataRoot, ".qqfriend", "memory_profiles.json"));
});

test("Linux bootstrap secures NapCat WebUI before the first container start", () => {
  const prepare = fs.readFileSync(path.join(ROOT, "deploy", "linux", "prepare.sh"), "utf8");
  const check = fs.readFileSync(path.join(ROOT, "deploy", "linux", "check.sh"), "utf8");
  const compose = fs.readFileSync(path.join(ROOT, "deploy", "linux", "compose.yaml"), "utf8");
  assert.match(prepare, /state\/napcat\/config/);
  assert.match(prepare, /"host": "0\.0\.0\.0"/);
  assert.match(prepare, /webui_token="\$\(random_hex 32\)"/);
  assert.match(prepare, /chmod 600[\s\S]*webui\.json/);
  assert.match(check, /NapCat WebUI host port is loopback-only/);
  assert.match(check, /NapCat WebUI token is non-default/);
  assert.match(compose, /"127\.0\.0\.1:6099:6099"/);
  assert.match(compose, /"127\.0\.0\.1:16789:16789"/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
  assert.match(compose, /ACCOUNT: \$\{NAPCAT_ACCOUNT:-\}/);
  assert.match(compose, /QQBOT_NAPCAT_API: http:\/\/napcat:6700/);
  assert.match(compose, /QQBOT_NAPCAT_WS_API: ws:\/\/napcat:3001/);
  assert.match(compose, /QQBOT_SUMMARY_SCHEDULER: systemd-user-timer/);
});

test("Linux Docker deployment includes a persistent user timer for daily summaries", () => {
  const installer = fs.readFileSync(path.join(ROOT, "deploy", "linux", "install-summary-timer.sh"), "utf8");
  const service = fs.readFileSync(path.join(
    ROOT,
    "deploy",
    "linux",
    "systemd-user",
    "qqfriend-compose-summary.service"
  ), "utf8");
  const timer = fs.readFileSync(path.join(
    ROOT,
    "deploy",
    "linux",
    "systemd-user",
    "qqfriend-compose-summary.timer"
  ), "utf8");

  assert.match(installer, /systemctl --user enable --now qqfriend-compose-summary\.timer/);
  assert.match(installer, /loginctl show-user/);
  assert.doesNotMatch(installer, /sudo systemctl/);
  assert.match(service, /docker compose[\s\S]*run --rm --no-deps -T bridge node daily_summary\.mjs/);
  assert.match(service, /Restart=on-failure/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00:05:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
});
