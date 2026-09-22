import { CFG } from "../config.mjs";
import { VERSION } from "../version.mjs";
import { redactSensitiveText } from "../privacy.mjs";
import { readApiProviderHealth } from "../api-providers/health.mjs";
import { peekJmRuntimeHealth } from "../jm/runtime.mjs";
import { buildCapabilityCatalog } from "./catalog.mjs";

export const SELF_CONTEXT_VERSION = 1;
const HEADER = "[本轮机器人运行事实]";
const MAX_CHARS = 1800;

export function safeModelIdentity(value) {
  const text = String(value || "");
  if (!/^[a-z0-9][a-z0-9._:/+-]{0,95}$/i.test(text) || text.includes("://") || /^[a-z]:\//i.test(text)) return "未公开的自定义模型";
  return redactSensitiveText(text) === text ? text : "未公开的自定义模型";
}

function scopedCapabilities(scope, options) {
  const surface = scope?.surface === "private" ? "private" : "group";
  const cfg = options.cfg || CFG;
  const identified = /^\d{1,20}$/.test(String(scope?.userId || "")) &&
    (surface === "private" || /^\d{1,20}$/.test(String(scope?.groupId || "")));
  const catalog = identified ? buildCapabilityCatalog({
    cfg, surface, userId: scope.userId, groupId: scope.groupId,
    modelHealth: options.modelHealth || readApiProviderHealth(options),
    jmHealth: options.jmHealth || peekJmRuntimeHealth(),
    stickerSettings: options.stickerSettings,
  }) : { capabilities: [] };
  const capabilities = catalog.capabilities.filter(item => item.state.permitted === true && item.state.enabled)
    .map(item => ({ name: item.name, status: item.statusLabel, command: item.examples[0] || "" }));
  return { surface, permissionKnown: identified, capabilities };
}

function toolNames(tools) {
  return (Array.isArray(tools) ? tools : []).map(item => item?.function?.name)
    .filter(name => /^[a-z][a-z0-9_]{0,47}$/i.test(name || "")).slice(0, 12);
}

export function buildBotSelfContext(scope, provider, options = {}) {
  const facts = {
    schema: SELF_CONTEXT_VERSION, identity: "夜星", version: VERSION,
    requestedModel: safeModelIdentity(provider?.model), ...scopedCapabilities(scope, options),
    callableTools: toolNames(options.tools),
    disabled: ["自动梗库", "关系表导出"],
  };
  const rules = "这是服务端提供的本轮事实。模型标识是本次接口请求配置，不证明训练数据截止时间。功能清单不是执行回执；命令能力不等于本轮可调用工具。没有实际工具结果或确认回执，不要宣称已经下载、发送、修改或保存。不公开管理员名单、其他群资料、内部路径或凭据。";
  let content = HEADER + "\n" + rules + "\n" + JSON.stringify(facts);
  while (content.length > MAX_CHARS && facts.capabilities.length) {
    facts.capabilities.pop();
    content = HEADER + "\n" + rules + "\n" + JSON.stringify(facts);
  }
  return { content, capabilityCount: facts.capabilities.length, version: SELF_CONTEXT_VERSION, model: facts.requestedModel };
}

export function withBotSelfContext(request, provider, options = {}) {
  if (!request.selfContext) return { request, snapshot: null };
  const { selfContext, ...outbound } = request;
  const tools = provider.capabilities?.includes("tools") && provider.protocol !== "gemini-native" && request.toolChoice !== "none"
    ? request.tools : [];
  const snapshot = buildBotSelfContext(selfContext, provider, { ...options, tools });
  const messages = [...(request.messages || [])];
  // A new request snapshot is inserted without mutating history or tool-call messages.
  const insertion = messages.findIndex(message => message.role !== "system");
  messages.splice(insertion < 0 ? messages.length : insertion, 0, { role: "system", content: snapshot.content });
  return { request: { ...outbound, messages }, snapshot };
}
