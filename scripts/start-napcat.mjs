// scripts/start-napcat.mjs - start the configured NapCat without duplicating it.

import fs from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { hasNapCatProcess } from "./napcat-process.mjs";
import { prepareNapCatLaunch } from "./runtime-paths.mjs";

const NAPCAT_API = String(process.env.QQBOT_NAPCAT_API || "http://127.0.0.1:6700").replace(/\/+$/, "");
const NAPCAT_LAUNCH = prepareNapCatLaunch();
const NAPCAT_EXE = NAPCAT_LAUNCH.executable;

if (await napCatReady()) {
  process.stdout.write("NapCat OneBot already ready.\n");
  process.exit(0);
}

if (await hasNapCatProcess({ runtimeDir: NAPCAT_LAUNCH.cwd || path.dirname(NAPCAT_EXE) })) {
  process.stdout.write("NapCat process already exists; waiting for OneBot.\n");
  process.exit(await waitUntilReady(90000) ? 0 : 2);
}

if (!fs.existsSync(NAPCAT_EXE)) {
  process.stderr.write("NapCat executable missing: " + NAPCAT_EXE + "\n");
  process.exit(1);
}

const child = await import("node:child_process").then(({ spawn }) => spawn(NAPCAT_EXE, NAPCAT_LAUNCH.args, {
  cwd: NAPCAT_LAUNCH.cwd || path.dirname(NAPCAT_EXE),
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: NAPCAT_LAUNCH.env,
}));
child.unref();
process.stdout.write("NapCat started (" + NAPCAT_LAUNCH.mode + "): " + NAPCAT_EXE + "\n");
process.exit(await waitUntilReady(90000) ? 0 : 2);

async function napCatReady() {
  try {
    const response = await fetch(NAPCAT_API + "/get_login_info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2500),
    });
    const payload = await response.json();
    return response.ok &&
      payload?.status === "ok" &&
      /^\d+$/.test(String(payload?.data?.user_id || ""));
  } catch {
    return false;
  }
}

async function waitUntilReady(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await napCatReady()) return true;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return false;
}
