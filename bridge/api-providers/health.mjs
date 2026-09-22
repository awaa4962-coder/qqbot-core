import { loadApiConfig, readProviderSecret, validateProviderEndpoint } from "./store.mjs";

// Configuration readiness is not a network probe or proof that the API is online.
export function readApiProviderHealth(options = {}) {
  try {
    const config = options.config || loadApiConfig(options);
    const tasks = Object.fromEntries(Object.entries(config.routes || {}).map(([task, route]) => [
      task, taskReadiness(task, route, config, options),
    ]));
    const issues = Object.entries(tasks).flatMap(([task, state]) => state.issues.map(issue => task + ":" + issue));
    if (config.routes?.group_chat?.fallback !== "deepseek") issues.push("group_chat:fallback_not_protected");
    return {
      enabled: true, health: issues.length ? "degraded" : "ready", configurationOnly: true, issues, tasks,
      routes: Object.fromEntries(Object.entries(config.routes || {}).map(([task, route]) => [task, {
        primary: route.primary, fallback: route.fallback || null, reasoning: route.reasoning,
      }])),
    };
  } catch {
    return { enabled: true, health: "degraded", configurationOnly: true,
      issues: ["configuration_invalid"], tasks: {}, routes: {}, configurationError: "API 配置无效或无法读取；已停止模型调用" };
  }
}

function taskReadiness(task, route, config, options) {
  const primary = slotReadiness(task, route.primary, config, options);
  const fallback = route.fallback ? slotReadiness(task, route.fallback, config, options) : null;
  const issues = [];
  if (!primary.ready) issues.push("primary_" + primary.reason);
  if (fallback && !fallback.ready) issues.push("fallback_" + fallback.reason);
  return { ready: primary.ready || Boolean(fallback?.ready), primary, fallback, issues };
}

function slotReadiness(task, id, config, options) {
  const provider = config.providers?.[id];
  if (!provider?.enabled) return { ready: false, reason: "unavailable" };
  if (task === "vision" && !provider.capabilities?.includes("vision")) return { ready: false, reason: "not_multimodal" };
  try {
    validateProviderEndpoint(provider);
    if (provider.auth !== "none" && !(options.readSecret || readProviderSecret)(provider, options)) {
      return { ready: false, reason: "credentials_missing" };
    }
  } catch {
    return { ready: false, reason: "configuration_invalid" };
  }
  return { ready: true, reason: "configured" };
}
