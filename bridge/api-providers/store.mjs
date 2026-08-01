// Persistent API instances and task routing. Secret values live in sidecar files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findApiPreset } from "./presets.mjs";
import {
  defaultReasoningMode,
  getProviderReasoningControl,
  isReasoningMode,
  listReasoningModes,
  normalizeReasoningMode,
} from "./reasoning-policy.mjs";

const ROOT = path.resolve(
  process.env.QQBOT_CONFIG_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
);
const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const TASK_IDS = Object.freeze([
  "group_chat",
  "interjection",
  "private_chat",
  "file_chat",
  "group_summary",
  "relationship_comment",
  "sticker_select",
  "vision",
  "profile",
  "search_summary",
]);

export function createDefaultApiConfig() {
  return {
    schemaVersion: 2,
    revision: 1,
    providers: {
      mimo: defaultProvider("mimo", "MiMo 主力", "mimo-official", ".env_mimo"),
      deepseek: defaultProvider("deepseek", "DeepSeek 兜底", "deepseek-official", ".env_ds", true),
    },
    routes: {
      group_chat: route("mimo", "deepseek", "group_chat"),
      interjection: route("mimo", null, "interjection"),
      private_chat: route("deepseek", null, "private_chat"),
      file_chat: route("deepseek", null, "file_chat"),
      group_summary: route("mimo", "deepseek", "group_summary"),
      relationship_comment: route("mimo", "deepseek", "relationship_comment"),
      sticker_select: route("mimo", "deepseek", "sticker_select"),
      vision: route("mimo", null, "vision"),
      profile: route("mimo", "deepseek", "profile"),
      search_summary: route("deepseek", null, "search_summary"),
    },
    updatedAt: null,
  };
}

export function loadApiConfig(options = {}) {
  const root = options.root || ROOT;
  const file = options.file || path.join(root, ".qqfriend", "api-providers.json");
  const defaults = createDefaultApiConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeStoredConfig(parsed, defaults);
  } catch {
    return defaults;
  }
}

export function getTaskRoute(task, options = {}) {
  const config = options.config || loadApiConfig(options);
  const normalizedTask = TASK_IDS.includes(task) ? task : "group_chat";
  return { ...config.routes[normalizedTask] };
}

export function getProvider(providerId, options = {}) {
  const config = options.config || loadApiConfig(options);
  const provider = config.providers[String(providerId || "")];
  return provider ? { ...provider, capabilities: [...provider.capabilities] } : null;
}

export function readProviderSecret(provider, options = {}) {
  if (!provider || provider.auth === "none") return "";
  const root = options.root || ROOT;
  const fromEnv = provider.secretEnv ? String(process.env[provider.secretEnv] || "").trim() : "";
  if (fromEnv) return fromEnv;
  if (!provider.secretFile) return "";
  const secretPath = resolveRootFile(root, provider.secretFile);
  try {
    return fs.readFileSync(secretPath, "utf8").trim();
  } catch {
    return "";
  }
}

export function buildApiConfigSnapshot(options = {}) {
  const root = options.root || ROOT;
  const config = loadApiConfig({ root });
  return {
    schemaVersion: config.schemaVersion,
    revision: config.revision,
    updatedAt: config.updatedAt,
    providers: Object.values(config.providers).map(provider => publicProvider(provider, { root })),
    routes: cloneRoutes(config.routes),
    reasoningModes: listReasoningModes(),
    tasks: TASK_IDS.map(id => ({
      id,
      name: taskName(id),
      defaultReasoning: defaultReasoningMode(id),
      protectedFallback: id === "group_chat" ? "deepseek" : null,
    })),
    rollbackAvailable: fs.existsSync(path.join(root, ".qqfriend", "api-providers.previous.json")),
    security: {
      secretsReturned: false,
      redirectsAllowed: false,
      publicHttpsByDefault: true,
      localEndpointsRequireOptIn: true,
    },
  };
}

export function saveApiProvider(payload, options = {}) {
  const root = options.root || ROOT;
  const config = loadApiConfig({ root });
  const id = String(payload?.id || "").trim().toLowerCase();
  const existing = config.providers[id] || null;
  if (options.mode === "create" && existing) {
    throw new Error("API 实例 ID 已存在；新增不会覆盖原实例，请换一个 ID");
  }
  if (options.mode === "update" && !existing) {
    throw new Error("要修改的 API 实例不存在，请刷新后重试");
  }
  const provider = normalizeProviderPayload({ ...payload, id }, existing);
  writeProviderSecret(provider, payload?.key, { root });
  config.providers[provider.id] = provider;
  persistConfig(config, { root, backup: true });
  return publicProvider(provider, { root });
}

export function saveApiRoutes(routesPayload, options = {}) {
  const root = options.root || ROOT;
  const config = loadApiConfig({ root });
  const nextRoutes = normalizeRoutes(routesPayload, config);
  config.routes = nextRoutes;
  persistConfig(config, { root, backup: true });
  return cloneRoutes(config.routes);
}

export function deleteApiProvider(providerId, options = {}) {
  const root = options.root || ROOT;
  const id = String(providerId || "");
  if (id === "mimo" || id === "deepseek") throw new Error("内置主力和 DeepSeek 兜底不能删除");
  const config = loadApiConfig({ root });
  if (!config.providers[id]) throw new Error("API 实例不存在");
  if (Object.values(config.routes).some(item => item.primary === id || item.fallback === id)) {
    throw new Error("这个 API 仍在任务插槽中，先切换插槽再删除");
  }
  delete config.providers[id];
  persistConfig(config, { root, backup: true });
  return { ok: true, deleted: id };
}

export function rollbackApiConfig(options = {}) {
  const root = options.root || ROOT;
  const current = path.join(root, ".qqfriend", "api-providers.json");
  const previous = path.join(root, ".qqfriend", "api-providers.previous.json");
  if (!fs.existsSync(previous)) throw new Error("没有可回滚的 API 配置");
  const previousConfig = normalizeStoredConfig(JSON.parse(fs.readFileSync(previous, "utf8")), createDefaultApiConfig());
  const currentRaw = fs.existsSync(current) ? fs.readFileSync(current, "utf8") : "";
  atomicWriteJson(current, withNextRevision(previousConfig));
  if (currentRaw) atomicWriteText(previous, currentRaw);
  return buildApiConfigSnapshot({ root });
}

export function resolveProviderEndpoint(provider) {
  const endpoint = String(provider?.endpoint || "").trim();
  if (!endpoint) throw new Error("API Endpoint 不能为空");
  if (endpoint.includes("{model}")) {
    if (!provider.model) throw new Error("这个接口地址需要填写模型名");
    return endpoint.replaceAll("{model}", encodeURIComponent(provider.model));
  }
  return endpoint;
}

export function validateProviderEndpoint(provider) {
  const endpoint = resolveProviderEndpoint(provider);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("API Endpoint 不是有效网址");
  }
  if (url.username || url.password) throw new Error("API Endpoint 不能包含账号或密码");
  const local = isLoopbackHost(url.hostname);
  if (local && provider.allowLocal !== true) throw new Error("本地接口需要明确启用本地模型模式");
  if (!local && url.protocol !== "https:") throw new Error("公网 API 必须使用 HTTPS");
  if (local && !["http:", "https:"].includes(url.protocol)) throw new Error("本地 API 只支持 HTTP 或 HTTPS");
  if (!local && isPrivateHost(url.hostname)) throw new Error("不允许连接内网或链路本地地址");
  return url.href;
}

function defaultProvider(id, name, presetId, secretFile, protectedProvider = false) {
  const preset = findApiPreset(presetId);
  return {
    id,
    name,
    presetId,
    protocol: preset.protocol,
    endpoint: preset.endpoint,
    model: preset.model,
    auth: preset.auth,
    tokenField: preset.tokenField,
    allowLocal: preset.allowLocal,
    capabilities: [...preset.capabilities],
    secretFile,
    protected: protectedProvider,
    enabled: true,
  };
}

function route(primary, fallback, task) {
  return { primary, fallback, reasoning: defaultReasoningMode(task) };
}

function normalizeStoredConfig(value, defaults) {
  const source = value && typeof value === "object" ? value : {};
  const providers = { ...defaults.providers };
  for (const [id, item] of Object.entries(source.providers || {})) {
    try {
      providers[id] = normalizeProviderPayload({ ...item, id }, providers[id]);
    } catch {
      // Keep the last valid/default provider instead of breaking startup.
    }
  }
  const base = {
    schemaVersion: 2,
    revision: positiveInteger(source.revision, defaults.revision),
    providers,
    routes: defaults.routes,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
  base.routes = normalizeRoutes(source.routes || {}, base, { partial: true });
  return base;
}

function normalizeProviderPayload(payload, existing = null) {
  const source = payload && typeof payload === "object" ? payload : {};
  const current = existing || {};
  const preset = findApiPreset(firstValue(source.presetId, current.presetId));
  const template = preset || {};
  const id = String(firstValue(source.id, current.id, "")).trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("API ID 只能使用小写字母、数字和连字符");
  const protocol = String(firstValue(source.protocol, template.protocol, current.protocol, ""));
  if (!["openai-chat", "openai-responses", "anthropic-messages", "gemini-native"].includes(protocol)) {
    throw new Error("不支持的 API 协议");
  }
  const provider = {
    id,
    name: cleanText(firstValue(source.name, current.name, template.name, id), 60, "API 名称"),
    presetId: String(firstValue(source.presetId, current.presetId, template.id, "custom-openai-chat")),
    protocol,
    endpoint: cleanText(firstDefined(source.endpoint, current.endpoint, template.endpoint, ""), 500, "Endpoint", true),
    model: cleanText(firstDefined(source.model, current.model, template.model, ""), 160, "模型名", true),
    auth: normalizeAuth(firstValue(source.auth, current.auth, template.auth, "bearer")),
    tokenField: cleanText(firstValue(source.tokenField, current.tokenField, template.tokenField, "max_tokens"), 60, "Token 字段"),
    allowLocal: Boolean(firstDefined(source.allowLocal, current.allowLocal, template.allowLocal, false)),
    capabilities: normalizeCapabilities(firstValue(source.capabilities, current.capabilities, template.capabilities)),
    secretFile: firstValue(current.secretFile, ".env_api_" + id),
    protected: current.protected === true,
    enabled: firstDefined(source.enabled, current.enabled, true) !== false,
  };
  validateProviderEndpoint(provider);
  return provider;
}

function normalizeRoutes(payload, config, options = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const result = cloneRoutes(config.routes);
  for (const task of TASK_IDS) {
    if (!Object.prototype.hasOwnProperty.call(source, task)) continue;
    const candidate = source[task] || {};
    const primary = normalizeProviderReference(candidate.primary, config.providers, false);
    const fallback = normalizeProviderReference(candidate.fallback, config.providers, true);
    if (!options.partial && candidate.reasoning !== undefined && !isReasoningMode(candidate.reasoning)) {
      throw new Error("不支持的思考档位：" + String(candidate.reasoning));
    }
    const reasoning = normalizeReasoningMode(candidate.reasoning ?? result[task]?.reasoning, task);
    result[task] = { primary, fallback, reasoning };
  }
  if (!options.partial && result.group_chat.fallback !== "deepseek") {
    throw new Error("群聊 DeepSeek 兜底为受保护插槽，不能清空或替换");
  }
  return result;
}

function normalizeProviderReference(value, providers, nullable) {
  const id = String(value || "").trim();
  if (!id && nullable) return null;
  if (!providers[id] || providers[id].enabled === false) throw new Error("任务插槽引用了不存在或停用的 API：" + id);
  return id;
}

function persistConfig(config, options = {}) {
  const root = options.root || ROOT;
  const dir = path.join(root, ".qqfriend");
  const file = path.join(dir, "api-providers.json");
  const previous = path.join(dir, "api-providers.previous.json");
  fs.mkdirSync(dir, { recursive: true });
  if (options.backup && fs.existsSync(file)) {
    atomicWriteText(previous, fs.readFileSync(file, "utf8"));
  }
  atomicWriteJson(file, withNextRevision(config));
}

function withNextRevision(config) {
  return {
    ...config,
    revision: positiveInteger(config.revision, 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}

function writeProviderSecret(provider, key, options = {}) {
  if (key === undefined || key === null || String(key).trim() === "") return;
  if (provider.auth === "none") throw new Error("无鉴权接口不需要填写 Key");
  const secret = String(key).trim();
  if (secret.length < 8 || /[\r\n]/.test(secret)) throw new Error("API Key 格式不正确");
  const secretPath = resolveRootFile(options.root || ROOT, provider.secretFile);
  atomicWriteText(secretPath, secret);
}

function publicProvider(provider, options = {}) {
  return {
    id: provider.id,
    name: provider.name,
    presetId: provider.presetId,
    protocol: provider.protocol,
    endpoint: provider.endpoint,
    model: provider.model,
    auth: provider.auth,
    tokenField: provider.tokenField,
    allowLocal: provider.allowLocal,
    capabilities: [...provider.capabilities],
    reasoningControl: getProviderReasoningControl(provider),
    protected: provider.protected,
    enabled: provider.enabled,
    keyConfigured: provider.auth === "none" || Boolean(readProviderSecret(provider, options)),
  };
}

function resolveRootFile(root, relativeFile) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relativeFile || ""));
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("密钥文件必须位于项目目录内");
  }
  return resolved;
}

function cloneRoutes(routes) {
  return Object.fromEntries(TASK_IDS.map(task => {
    const source = routes[task] || route("mimo", null, task);
    return [task, {
      primary: source.primary,
      fallback: source.fallback ?? null,
      reasoning: normalizeReasoningMode(source.reasoning, task),
    }];
  }));
}

function normalizeCapabilities(value) {
  const allowed = new Set(["text", "vision", "tools", "reasoning"]);
  const list = Array.isArray(value) ? value : [];
  const result = [...new Set(list.map(String).filter(item => allowed.has(item)))];
  return result.length ? result : ["text"];
}

function normalizeAuth(value) {
  const auth = String(value || "");
  if (!["bearer", "x-api-key", "x-goog-api-key", "api-key", "none"].includes(auth)) {
    throw new Error("不支持的鉴权方式");
  }
  return auth;
}

function cleanText(value, maxLength, label, allowEmpty = false) {
  const text = String(value || "").trim();
  if (!text && !allowEmpty) throw new Error(label + "不能为空");
  if (text.length > maxLength || /[\r\n]/.test(text)) throw new Error(label + "格式不正确");
  return text;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === "0.0.0.0" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function atomicWriteJson(file, value) {
  atomicWriteText(file, JSON.stringify(value, null, 2) + "\n");
}

function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, file);
}

function taskName(id) {
  return ({
    group_chat: "群聊主回复",
    interjection: "随机插话",
    private_chat: "私聊",
    file_chat: "文件理解",
    group_summary: "群日报",
    relationship_comment: "关系短评",
    sticker_select: "表情选择",
    vision: "图片识别",
    profile: "用户画像",
    search_summary: "搜索总结",
  })[id] || id;
}

export const API_TASK_IDS = TASK_IDS;
