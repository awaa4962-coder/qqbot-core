import { createMcpServices } from "./services.mjs";

let services;
export async function initializeMcpServices(options = {}) {
  if (services) await services.close();
  const cfg = options.cfg || (await import("../config.mjs")).CFG;
  services = createMcpServices({ ...options, cfg });
  return services.initialize();
}
export function getMcpSnapshot(_options = {}) {
  return services?.snapshot() || { revision: "0", servers: [], configuration: { servers: [] }, status: "not_initialized" };
}
export async function applyMcpAction(body, _options = {}) {
  return services ? services.action(body) : { ok: false, reason: "not_initialized" };
}
export async function closeMcpServices() {
  const previous = services; services = undefined;
  await previous?.close();
}
