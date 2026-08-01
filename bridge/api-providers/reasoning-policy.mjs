// Task-level reasoning policy. Provider adapters receive only supported native fields.

export const REASONING_MODES = Object.freeze([
  Object.freeze({ id: "economy", name: "省额度" }),
  Object.freeze({ id: "auto", name: "智能" }),
  Object.freeze({ id: "deep", name: "深度" }),
]);

const MODE_IDS = new Set(REASONING_MODES.map(item => item.id));
const ECONOMY_TASKS = new Set(["interjection", "relationship_comment", "sticker_select"]);
const DEEP_TASKS = new Set(["file_chat", "group_summary", "vision", "profile"]);
const COMPLEX_REQUEST = /(?:为什么|为何|分析|推理|比较|对比|方案|规划|代码|报错|原理|证明|计算|总结|详细|解释|怎么做|怎么办|如何实现|风险|排查|审核|审计|why|analy[sz]e|compare|plan|code|debug|explain|reason)/i;

export function defaultReasoningMode(task) {
  if (ECONOMY_TASKS.has(String(task || ""))) return "economy";
  if (DEEP_TASKS.has(String(task || ""))) return "deep";
  return "auto";
}

export function normalizeReasoningMode(value, task) {
  const mode = String(value || "").trim().toLowerCase();
  return MODE_IDS.has(mode) ? mode : defaultReasoningMode(task);
}

export function isReasoningMode(value) {
  return MODE_IDS.has(String(value || "").trim().toLowerCase());
}

export function listReasoningModes() {
  return REASONING_MODES.map(item => ({ ...item }));
}

export function getProviderReasoningControl(provider) {
  if (!provider?.capabilities?.includes("reasoning")) {
    return control("none", false, []);
  }
  if (isDeepSeekProvider(provider)) {
    return control("provider-default", false, []);
  }
  if (provider.protocol === "openai-responses") {
    return control("effort", true, ["economy", "auto", "deep"]);
  }
  if (provider.protocol === "openai-chat") {
    return isMiMoProvider(provider)
      ? control("mimo-toggle", true, ["economy", "auto", "deep"])
      : control("provider-default", false, []);
  }
  return control("provider-default", false, []);
}

export function applyReasoningPolicy(provider, request = {}, options = {}) {
  const task = String(options.task || "group_chat");
  const configuredMode = normalizeReasoningMode(options.mode, task);
  const controlInfo = getProviderReasoningControl(provider);
  const effectiveMode = configuredMode === "auto"
    ? resolveAutomaticMode(task, request)
    : configuredMode;
  const meta = {
    task,
    configuredMode,
    effectiveMode,
    control: controlInfo.kind,
    applied: false,
  };

  if (!controlInfo.configurable) return { request: { ...request }, meta };

  const next = { ...request };
  if (controlInfo.kind === "effort") {
    next.reasoning = { effort: effectiveMode === "deep" ? "high" : "none" };
    meta.applied = true;
    return { request: next, meta };
  }

  next.thinking = { type: effectiveMode === "deep" ? "enabled" : "disabled" };
  meta.applied = true;
  return { request: next, meta };
}

export function resolveAutomaticMode(task, request = {}) {
  const normalizedTask = String(task || "group_chat");
  if (ECONOMY_TASKS.has(normalizedTask)) return "economy";
  if (DEEP_TASKS.has(normalizedTask)) return "deep";

  const text = policyText(lastUserText(request.messages));
  if (request.reasoningSignals?.hasImages || hasImageInput(request.messages)) return "deep";
  if (text.length >= 120 || COMPLEX_REQUEST.test(text)) return "deep";
  if ((text.match(/[?？]/g) || []).length >= 2) return "deep";
  if ((text.match(/\n/g) || []).length >= 2) return "deep";
  return "economy";
}

function policyText(text) {
  const structuredMessage = String(text || "").match(/(?:^|\n)message=([^\n]*)/i);
  return structuredMessage ? structuredMessage[1].trim() : String(text || "").trim();
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index--) {
    if (list[index]?.role !== "user") continue;
    return contentText(list[index].content);
  }
  return "";
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => typeof part === "string" ? part : part?.text || "")
    .filter(Boolean)
    .join("\n");
}

function hasImageInput(messages) {
  return (messages || []).some(message => Array.isArray(message?.content) && message.content.some(part =>
    part?.type === "image_url" || part?.type === "input_image" || Boolean(part?.inlineData)
  ));
}

function isMiMoProvider(provider) {
  const preset = String(provider?.presetId || "").toLowerCase();
  const model = String(provider?.model || "").toLowerCase();
  let host = "";
  try {
    host = new URL(String(provider?.endpoint || "")).hostname.toLowerCase();
  } catch {
    // Endpoint validation reports malformed URLs before the request is sent.
  }
  return preset === "mimo-official" || model.startsWith("mimo-") || host.endsWith("xiaomimimo.com") || host === "mimo.mi.com";
}

function isDeepSeekProvider(provider) {
  const preset = String(provider?.presetId || "").toLowerCase();
  const host = safeHostname(provider?.endpoint);
  return preset === "deepseek-official" || host === "api.deepseek.com";
}

function safeHostname(endpoint) {
  try {
    return new URL(String(endpoint || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function control(kind, configurable, modes) {
  return { kind, configurable, modes: [...modes] };
}
