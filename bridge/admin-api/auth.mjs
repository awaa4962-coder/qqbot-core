// bridge/admin-api/auth.mjs - local-only guard for the desktop console API.

export function isLoopbackAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  if (!value) return false;
  if (value === "::1" || value === "localhost") return true;
  if (value.startsWith("127.")) return true;
  if (value.startsWith("::ffff:127.")) return true;
  if (value === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export function adminTokenFromRequest(req) {
  const headerToken = req.headers?.["x-qqfriend-admin-token"];
  if (headerToken) return String(headerToken).trim();
  const auth = String(req.headers?.authorization || "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return "";
}

export function isAuthorizedAdminRequest(req, options = {}) {
  const remoteAddress = options.remoteAddress || req.socket?.remoteAddress || "";
  if (!isLoopbackAddress(remoteAddress)) return false;

  const requiredToken = String(options.requiredToken ?? process.env.QQFRIEND_ADMIN_TOKEN ?? "").trim();
  if (!requiredToken) return true;
  return adminTokenFromRequest(req) === requiredToken;
}

export function adminForbiddenPayload() {
  return {
    error: "admin api is only available from localhost",
  };
}
