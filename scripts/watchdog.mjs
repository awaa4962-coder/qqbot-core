// scripts/watchdog.mjs — keep NapCat OneBot and qqfriend bridge alive
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasNapCatProcess } from "./napcat-process.mjs";
import { prepareNapCatLaunch } from "./runtime-paths.mjs";
import { monotonicNow } from "../bridge/runtime-clock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(ROOT, "logs");
const NAPCAT_LAUNCH = prepareNapCatLaunch({ root: ROOT });
const NAPCAT_EXE = NAPCAT_LAUNCH.executable;
const NAPCAT_DIR = path.dirname(NAPCAT_EXE);
const CHECK_INTERVAL_MS = 30000;
const START_COOLDOWN_MS = 60000;

let lastNapCatStart = 0;
let lastBridgeStart = 0;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(...parts) {
  const line = "[" + new Date().toISOString() + "] " + parts.join(" ") + "\n";
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "watchdog.log"), line, "utf8");
  process.stdout.write(line);
}

async function postJson(url) {
  try {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(3000) });
    const payload = await response.json();
    return response.ok &&
      payload?.status === "ok" &&
      /^\d+$/.test(String(payload?.data?.user_id || ""));
  } catch {
    return false;
  }
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function startDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || ROOT,
    detached: true,
    stdio: options.stdio || "ignore",
    windowsHide: true,
    env: options.env || process.env,
  });
  child.unref();
}

function startNapCat() {
  if (!fs.existsSync(NAPCAT_EXE)) {
    log("NapCat executable missing:", NAPCAT_EXE);
    return;
  }
  const now = monotonicNow();
  if (now - lastNapCatStart < START_COOLDOWN_MS) return;
  lastNapCatStart = now;
  log("starting NapCat");
  startDetached(NAPCAT_EXE, NAPCAT_LAUNCH.args, {
    cwd: NAPCAT_LAUNCH.cwd || NAPCAT_DIR,
    env: NAPCAT_LAUNCH.env,
  });
}

function startBridge() {
  const now = monotonicNow();
  if (now - lastBridgeStart < START_COOLDOWN_MS) return;
  lastBridgeStart = now;
  const out = path.join(LOG_DIR, "watchdog-bridge-" + nowStamp() + ".log");
  log("starting bridge, log:", out);
  const logFd = fs.openSync(out, "a");
  try {
    startDetached(process.execPath, ["napcat_bridge.mjs"], {
      cwd: ROOT,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
}

async function checkOnce() {
  const napcatOk = await postJson("http://127.0.0.1:6700/get_login_info");
  if (!napcatOk) {
    const exists = await hasNapCatProcess({ runtimeDir: NAPCAT_LAUNCH.cwd || NAPCAT_DIR });
    if (!exists) startNapCat();
  }

  const bridgeOk = await getJson("http://127.0.0.1:16789/health");
  if (napcatOk && !bridgeOk) startBridge();
}

log("watchdog started");
await checkOnce();
setInterval(function () {
  checkOnce().catch(function (error) {
    log("watchdog check error:", error.message);
  });
}, CHECK_INTERVAL_MS);
