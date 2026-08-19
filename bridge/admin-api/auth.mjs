// bridge/admin-api/auth.mjs - local-only guard for the desktop console API.

export function isLoopbackAddress(address) {
  const value = normalizeAddress(address);
  if (!value) return false;
  if (value === "::1" || value === "localhost") return true;
  if (value.startsWith("127.")) return true;
  if (value === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export function isPrivateAddress(address) {
  const value = normalizeAddress(address);
  const octets = parseIpv4(value);
  if (octets) {
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }

  const firstHextet = Number.parseInt(value.split(":", 1)[0], 16);
  return Number.isInteger(firstHextet) && firstHextet >= 0xfc00 && firstHextet <= 0xfdff;
}

export function isTrustedManagementAddress(address, options = {}) {
  if (isLoopbackAddress(address)) return true;
  const containerized = options.containerized ?? isContainerizedRuntime();
  return Boolean(containerized) && isPrivateAddress(address);
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
  const loopback = isLoopbackAddress(remoteAddress);
  if (!isTrustedManagementAddress(remoteAddress, options)) return false;

  const requiredToken = String(options.requiredToken ?? process.env.QQFRIEND_ADMIN_TOKEN ?? "").trim();
  // A rewritten container-gateway address is trusted only together with a token.
  if (!requiredToken) return loopback;
  return adminTokenFromRequest(req) === requiredToken;
}

export function adminForbiddenPayload() {
  return {
    error: "admin api is only available from the local host",
  };
}

function normalizeAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function parseIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  if (octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index])) {
    return null;
  }
  return octets;
}

function isContainerizedRuntime() {
  return /^(?:1|true|yes)$/i.test(String(process.env.QQFRIEND_CONTAINERIZED || "").trim());
}
