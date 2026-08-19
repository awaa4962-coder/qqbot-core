// Loopback-only static host for the reusable management console.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { isTrustedManagementAddress } from "./admin-api/auth.mjs";

const DEFAULT_WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "launcher",
  "QQFriendLauncher",
  "Web"
);

const ASSETS = new Map([
  ["/console/", ["index.html", "text/html; charset=utf-8"]],
  ["/console/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/console/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/console/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/console/host-client.js", ["host-client.js", "text/javascript; charset=utf-8"]],
]);

export async function handleWebConsoleRequest(req, res, context = {}) {
  const enabled = context.enabled ?? CFG.webConsoleEnabled;
  const pathname = context.pathname || "/";
  if (!enabled || !pathname.startsWith("/console")) return false;

  if (!isTrustedManagementAddress(req.socket?.remoteAddress, {
    containerized: context.containerized,
  })) {
    writeText(res, 404, "not found");
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    writeText(res, 405, "method not allowed");
    return true;
  }
  if (pathname === "/console") {
    res.writeHead(302, { Location: "/console/" });
    res.end();
    return true;
  }

  const asset = ASSETS.get(pathname);
  if (!asset) {
    writeText(res, 404, "not found");
    return true;
  }

  try {
    const buffer = await fs.readFile(path.join(context.root || DEFAULT_WEB_ROOT, asset[0]));
    res.writeHead(200, buildHeaders(asset[1], buffer.length));
    res.end(req.method === "HEAD" ? undefined : buffer);
  } catch {
    writeText(res, 404, "console asset not found");
  }
  return true;
}

function buildHeaders(contentType, length) {
  return {
    "Cache-Control": "no-cache",
    "Content-Length": String(length),
    "Content-Security-Policy": [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob: https:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function writeText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(message);
}
