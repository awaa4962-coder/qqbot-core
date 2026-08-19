// Shared NapCat authentication helpers. Tokens never leave request headers.

import { CFG } from "./config.mjs";

export function buildNapCatHeaders(headers = {}, options = {}) {
  const result = { ...headers };
  const token = String(options.token ?? CFG.napcatAccessToken ?? "").trim();
  if (token && !hasAuthorizationHeader(result)) {
    result.Authorization = "Bearer " + token;
  }
  return result;
}

export function buildNapCatWebSocketOptions(options = {}) {
  const headers = buildNapCatHeaders(options.headers || {}, options);
  return Object.keys(headers).length ? { headers } : {};
}

function hasAuthorizationHeader(headers) {
  return Object.keys(headers).some(key => key.toLowerCase() === "authorization");
}
