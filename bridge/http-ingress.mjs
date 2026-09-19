import { timingSafeEqual } from "node:crypto";

export function isAllowedBrowserOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && url.origin === origin;
  } catch { return false; }
}

export function isAuthorizedOneBotRequest(req, requiredToken) {
  const expected = String(requiredToken || "").trim();
  const authorization = String(req.headers?.authorization || "");
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!expected || !match || !isAllowedBrowserOrigin(req.headers?.origin)) return false;
  const supplied = Buffer.from(match[1]);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function readRequestJson(req, { maxBytes = 1024 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => finish(requestError("request body timed out", 408)), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      if (error) {
        // IncomingMessage can emit ECONNRESET after 'aborted'. It is not a process-fatal error.
        const ignoreReset = () => {};
        req.on("error", ignoreReset);
        req.once("close", () => req.off("error", ignoreReset));
        req.pause();
        reject(error);
      } else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) { finish(requestError("request body too large", 413)); return; }
      chunks.push(Buffer.from(chunk));
    }
    function onAborted() { finish(requestError("request aborted", 400)); }
    function onError() { finish(requestError("request body failed", 400)); }
    function onEnd() {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (!text) throw new Error("empty");
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
        finish(null, value);
      } catch { finish(requestError("JSON object required", 400)); }
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}
