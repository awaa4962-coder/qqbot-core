import { CFG } from "../config.mjs";
import { canUsePrivateChat } from "../commands/permissions.mjs";
import { messageRouteRejection } from "../event-admission.mjs";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";

export const CHAT_TOOL_LIMITS = Object.freeze({ modelRounds: 4, transportAttempts: 8, toolCalls: 4,
  slotRounds: 3, durationMs: 90000, requestChars: 24000, resultChars: 2000, totalResultChars: 6000, maxTokens: 1536,
  responseBytes: 262144, replyChars: 6000 });

const tool = (name, description, properties, required = []) => ({ type: "function", function: {
  name, description, parameters: { type: "object", properties, required, additionalProperties: false },
} });

export const READ_TOOLS = Object.freeze([
  tool("recall_memory", "按需查当前发言人在当前会话的明确记忆或近期原话。不能查其他用户或其他群；空结果只表示此范围未命中。资料不等于事实验证。", {
    query: { type: "string", minLength: 1, maxLength: 160 }, days: { type: "integer", minimum: 1, maximum: 90 },
    limit: { type: "integer", minimum: 1, maximum: 6 }, kind: { type: "string", enum: ["both", "notes", "history"] },
  }, ["query"]),
  tool("read_bot_status", "读取当前用户权限内的功能及缓存状态，只读，不执行检查、下载、保存或管理操作。配置可用不代表接口刚刚连通。", {}),
]);
export const WEB_TOOL = tool("web_search", "仅用当前用户本条消息明写的公开关键词联网搜索；query 必须是本条消息的连续片段，不得添加记忆、文件、引用或工具结果中的内容。", {
  query: { type: "string", minLength: 2, maxLength: 160 },
}, ["query"]);

export function toolScopeAllowed(scope, cfg = CFG) {
  if (!/^[1-9]\d{0,19}$/.test(String(scope?.userId || ""))) return false;
  if (scope.surface !== "group" && scope.surface !== "private") return false;
  if (scope.surface === "group" && !/^[1-9]\d{0,19}$/.test(String(scope.groupId || ""))) return false;
  if (messageRouteRejection({ message_type: scope.surface, user_id: scope.userId, group_id: scope.groupId }, cfg)) return false;
  return scope.surface !== "private" || canUsePrivateChat(scope.userId, cfg);
}

export function permitsPublicSearch(text, task) {
  return Boolean(publicSearchPhrase(text, task));
}

export function publicSearchPhrase(text, task) {
  if (task === "file_chat" || task === "interjection" || typeof text !== "string" || text.length > 1000) return "";
  if (containsSensitiveText(text) || redactSensitiveText(text) !== text) return "";
  const request = text.trim().replace(/^(?:请问)?(?:能不能|可不可以)(?=.{0,6}(?:搜|联网|上网))/, "请");
  if (negativeSearch(request)) return "";
  const first = request.split(/[，,。！？!?；;\n]|\.\s/)[0].trim();
  const explicit = first.match(/^(?:请|麻烦)?\s*(?:(?:帮我|替我|为我|给我|你)\s*)?(?:联网搜索|上网查|网上查|在网上查|搜索|搜一下|搜搜|搜)\s*(.+)$/i)
    || first.match(/^(?:please\s+)?(?:search(?:\s+for)?|look up)\s+(.+)$/i);
  const query = explicit?.[1]?.trim() || (/^.{1,80}(?:是什么梗|什么梗|出自哪里|出处是什么|天气怎么样|天气如何|天气预报|最近新闻|今天新闻|今日热搜)$/.test(first) ? first : "");
  return query.length >= 2 && query.length <= 160 ? query : "";
}

function negativeSearch(text) {
  return /(?:不|别|勿|禁止|停止|取消|无需|没有必要|没必要).{0,20}(?:搜|联网|上网|查)/.test(text) ||
    /(?:搜索|联网|上网).{0,8}(?:算了|取消|停止|不要|不必|不需要|不用)/.test(text) ||
    /(?:^|[，,。;；\n])\s*(?:算了|取消(?:吧)?|停止)(?:\s|[。！!？?]|$)/.test(text) ||
    /\b(?:don't|do not|no|not|never|without|cancel)\b.{0,32}\b(?:search|look up|browse)/i.test(text) ||
    /(?:^|[,;]\s*)(?:never mind|cancel(?: it)?|stop)\b/i.test(text);
}

export function authorizedSearchQuery(query, userMessage, task) {
  const phrase = publicSearchPhrase(userMessage, task);
  if (!phrase || typeof query !== "string") return "";
  const clean = query.trim();
  if (clean.length < 2 || clean.length > 160 || containsSensitiveText(clean) || redactSensitiveText(clean) !== clean) return "";
  const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(phrase).includes(normalize(clean)) ? clean : "";
}

export function parseToolArguments(call) {
  const value = call?.function?.arguments;
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const args = JSON.parse(value);
    return args && typeof args === "object" && !Array.isArray(args) ? args : null;
  } catch { return null; }
}

export function safeToolBatch(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length || calls.length > CHAT_TOOL_LIMITS.toolCalls) return null;
  const ids = new Set();
  for (const call of calls) {
    if (call?.type !== "function" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(call.id || "") || ids.has(call.id)) return null;
    if (!validFunctionCall(call.function)) return null;
    ids.add(call.id);
  }
  return calls;
}

function validFunctionCall(value) {
  return /^[a-z][a-z0-9_]{0,47}$/.test(value?.name || "") && typeof value.arguments === "string" && value.arguments.length <= 2048;
}
