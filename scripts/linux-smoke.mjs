// Isolated Bridge smoke test used before deploying the Linux service.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qqfriend-linux-smoke-"));
const port = await findFreePort();
const output = [];
const ADMIN_TOKEN = "smoke-admin-token";
const ONEBOT_TOKEN = "smoke-onebot-token";
let child = null;

try {
  child = spawn(process.execPath, ["napcat_bridge.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      QQBOT_CONFIG_ROOT: path.join(sandbox, "config"),
      QQBOT_DATA_DIR: path.join(sandbox, "data"),
      QQBOT_LOG_DIR: path.join(sandbox, "logs"),
      QQBOT_TEMP_DIR: path.join(sandbox, "temp"),
      QQBOT_LISTEN_HOST: "127.0.0.1",
      QQBOT_LISTEN_PORT: String(port),
      QQBOT_NAPCAT_API: "http://127.0.0.1:1",
      QQBOT_NAPCAT_WS_API: "",
      QQBOT_NAPCAT_TOKEN: ONEBOT_TOKEN,
      QQBOT_MEME_AUTO_UPDATE: "0",
      QQBOT_STICKERS_ENABLED: "0",
      QQFRIEND_ADMIN_TOKEN: ADMIN_TOKEN,
      QQFRIEND_WEB_CONSOLE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", chunk => capture(chunk));
  child.stderr.on("data", chunk => capture(chunk));

  const health = await waitForJson(`http://127.0.0.1:${port}/health`, 15000);
  const status = await waitForJson(`http://127.0.0.1:${port}/admin/status`, 5000);
  const readiness = await getJsonResponse(`http://127.0.0.1:${port}/ready`);
  const savedConfig = await postJson(`http://127.0.0.1:${port}/admin/config`, {
    editable: { botNames: ["LinuxSmoke"] },
  });
  const consoleResponse = await fetch(`http://127.0.0.1:${port}/console/`, {
    signal: AbortSignal.timeout(5000),
  });
  const consoleHtml = await consoleResponse.text();

  assert(health.status === "ok", "health status is not ok");
  assert(status.status === "ok", "admin status is not ok");
  assert(readiness.status === 503 && readiness.payload.status === "not_ready", "readiness must fail closed without OneBot");
  await verifyIngress(port);
  assert(savedConfig.ok === true, "admin config write failed");
  assert(
    fs.existsSync(path.join(sandbox, "config", ".env_bot_names")),
    "admin config was not written to the isolated config root"
  );
  assert(
    fs.existsSync(path.join(sandbox, "logs", "admin-audit.log")),
    "admin audit was not written to the isolated log root"
  );
  assert(consoleResponse.ok && consoleHtml.includes("QQFriend 控制台"), "browser console is unavailable");
  assert(
    String(consoleResponse.headers.get("content-security-policy") || "").includes("default-src 'self'"),
    "browser console CSP is missing"
  );

  process.stdout.write(JSON.stringify({
    ok: true,
    host: "127.0.0.1",
    port,
    health: health.status,
    status: status.status,
    readiness: readiness.payload.status,
    console: "ok",
    configWrite: "ok",
    auditWrite: "ok",
    ingressAuth: "ok",
  }, null, 2) + "\n");
} catch (error) {
  process.stderr.write("Linux smoke test failed: " + error.message + "\n");
  if (output.length) process.stderr.write(output.join("").slice(-12000) + "\n");
  process.exitCode = 1;
} finally {
  await stopChild(child);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function capture(chunk) {
  output.push(String(chunk));
  while (output.join("").length > 20000) output.shift();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJson(url, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { "X-QQFriend-Admin-Token": ADMIN_TOKEN }, signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw lastError || new Error("endpoint timeout: " + url);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-QQFriend-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  return payload;
}

async function verifyIngress(listenPort) {
  const base = `http://127.0.0.1:${listenPort}`;
  for (const pathname of ["/", "/reply", "/inspect_msg"]) {
    const response = await fetch(base + pathname, { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) });
    assert([401, 403].includes(response.status), "unauthorized route accepted: " + pathname);
    await response.body?.cancel();
  }
  const event = await fetch(base + "/", {
    method: "POST", body: JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }),
    headers: { Authorization: "Bearer " + ONEBOT_TOKEN }, signal: AbortSignal.timeout(3000),
  });
  assert(event.status === 200, "authorized OneBot HTTP event rejected");
  await event.body?.cancel();
  const empty = await fetch(base + "/inspect_msg", { method: "POST", body: "", headers: { "X-QQFriend-Admin-Token": ADMIN_TOKEN }, signal: AbortSignal.timeout(3000) });
  assert(empty.status === 400, "empty body must return 400");
  await empty.body?.cancel();
  const spoofed = await fetch(base + "/health", { headers: { Origin: "http://localhost.evil.example" }, signal: AbortSignal.timeout(3000) });
  assert(spoofed.status === 403, "lookalike origin accepted");
  await spoofed.body?.cancel();
  await verifyWebSocket(listenPort, "", false);
  await verifyWebSocket(listenPort, ONEBOT_TOKEN, true);
}

async function verifyWebSocket(listenPort, token, expectedOpen) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/`, { headers: token ? { Authorization: "Bearer " + token } : {}, handshakeTimeout: 3000 });
    ws.once("open", () => {
      ws.close();
      if (expectedOpen) resolve(); else reject(new Error("unauthorized WebSocket accepted"));
    });
    ws.once("error", error => {
      if (!expectedOpen && /401/.test(error.message)) resolve(); else reject(error);
    });
  });
}

async function getJsonResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, payload: await response.json() };
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => processHandle.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}
