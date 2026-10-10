import { CFG } from "../config.mjs";
import { canUsePrivateChat } from "../commands/permissions.mjs";
import { messageRouteRejection } from "../event-admission.mjs";
import { containsSensitiveText, redactSensitiveText } from "../privacy.mjs";
import { toolDefinition } from "./registry.mjs";

import { CHAT_TOOL_LIMITS } from "./limits.mjs";
export { CHAT_TOOL_LIMITS } from "./limits.mjs";

export const READ_TOOLS = Object.freeze([toolDefinition("recall_memory"), toolDefinition("read_bot_status")]);
export const WEB_TOOL = toolDefinition("web_search");
export const CALCULATE_TOOL = toolDefinition("calculate");
export const PAGE_TOOL = toolDefinition("read_public_page");
export const ATTACHMENT_TOOL = toolDefinition("read_current_attachment");
export const DRAFT_TOOL = toolDefinition("draft_chat_summary");
export const DRAFT_TASK_TOOL = toolDefinition("read_draft_task");
export const PERSONAL_CHANGE_TOOL = toolDefinition("prepare_personal_change");
export const REMINDER_TOOL = toolDefinition("prepare_reminder");
export const PERSONAL_ACTIONS_TOOL = toolDefinition("read_personal_actions");

export function permitsReminderPreparation(message) {
  return Boolean(reminderRequest(message));
}

const REMINDER_PREFIX = /^(?:(?:请|麻烦)(?:帮我)?|帮我)?\s*/u;
const TIME_PREFIX = /^[\d一二三四五六七八九十百两半个分秒钟小时天日后今明年月周星期上下早晚中午凌晨点在:：T+.Z\-\s]{0,80}$/u;
const RELATIVE = /^([0-9]{1,5}|一|二|两|三|四|五|六|七|八|九|十|半)(?:个)?(分钟|小时|天|周)(?:以后|之后|后)\s*/u;

function relativeMinutes(text) {
  const match = RELATIVE.exec(text);
  if (!match) return null;
  const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
  const value = numbers[match[1]] ?? Number(match[1]);
  const scale = { 分钟: 1, 小时: 60, 天: 1440, 周: 10080 }[match[2]];
  return { minutes: value * scale, length: match[0].length };
}

function reminderRequest(message) {
  const text = typeof message === "string" ? message.normalize("NFKC").replace(/\p{Cf}/gu, "").trim() : "";
  const source = text.replace(/^@[^\s@]{1,32}\s+/u, "").replace(REMINDER_PREFIX, "");
  if (!source || /(?:只是|仅|只).{0,8}(?:解释|引用|分析)|(?:不要|不用|别|禁止|不必).{0,8}(?:提醒|取消|执行|创建|设置)|不执行/u.test(source)) return null;
  const first = source.trim();
  const cancel = /^取消(?:我的)?提醒\s+(rem_[a-f0-9]{32})$/u.exec(first);
  if (cancel) return { action: "cancel", ref: cancel[1] };
  const create = /^(.*?)提醒(?:我|一下)(?:一下)?\s*[:：]?\s*(.+)$/u.exec(first);
  if (!create || !TIME_PREFIX.test(create[1])) return null;
  const body = create[2].trim();
  const relative = relativeMinutes(create[1].trim()) || relativeMinutes(body);
  const withoutTime = relativeMinutes(body);
  return { action: "create", body, shortenedBody: withoutTime ? body.slice(withoutTime.length).trim() : body, relative };
}

export function authorizedReminderArguments(args, message) {
  const request = reminderRequest(message);
  if (!request || !args || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
  const field = key => Object.getOwnPropertyDescriptor(args, key)?.value;
  if (field("action") !== request.action) return false;
  if (request.action === "cancel") return field("ref") === request.ref;
  if (typeof field("text") !== "string" || ![request.body, request.shortenedBody].includes(field("text"))) return false;
  return !request.relative || (field("delay_minutes") === request.relative.minutes && field("when") === undefined);
}

export function agentPersonalAllowed(scope, cfg = CFG, options = {}) {
  return agentScopeAllowed(scope, cfg, options) && (cfg.agentWriteGroupWhitelist || []).some(id => String(id) === String(scope.groupId));
}

export function agentRemindersAllowed(scope, cfg = CFG, options = {}) {
  return agentScopeAllowed(scope, cfg, options) && (cfg.agentReminderGroupWhitelist || []).some(id => String(id) === String(scope.groupId));
}

export function agentMaterialsAllowed(scope, cfg = CFG, options = {}) {
  return agentScopeAllowed(scope, cfg, options) && (cfg.agentMaterialGroupWhitelist || []).some(id => String(id) === String(scope.groupId));
}

export function agentDraftsAllowed(scope, cfg = CFG, options = {}) {
  return agentScopeAllowed(scope, cfg, options) && (cfg.agentDraftGroupWhitelist || []).some(id => String(id) === String(scope.groupId));
}

export function agentScopeAllowed(scope, cfg = CFG, options = {}) {
  return options.mentioned === true && options.task === "group_chat" && options.allowTools !== false &&
    scope?.surface === "group" && toolScopeAllowed(scope, cfg) &&
    Array.isArray(cfg.agentGroupWhitelist) && cfg.agentGroupWhitelist.some(id => String(id) === String(scope.groupId));
}

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
  return publicNetworkCancelled(text) || /(?:不|别|勿|禁止|停止|取消|无需|没有必要|没必要).{0,20}(?:搜|联网|上网|查)/.test(text) ||
    /(?:搜索|联网|上网).{0,8}(?:算了|取消|停止|不要|不必|不需要|不用)/.test(text) ||
    /(?:^|[，,。;；\n])\s*(?:算了|取消(?:吧)?|停止)(?:\s|[。！!？?]|$)/.test(text) ||
    /\b(?:don't|do not|no|not|never|without|cancel)\b.{0,32}\b(?:search|look up|browse)/i.test(text) ||
    /(?:^|[,;]\s*)(?:never mind|cancel(?: it)?|stop)\b/i.test(text);
}

export function publicNetworkCancelled(text) {
  if (typeof text !== "string") return true;
  return /(?:不(?:要|用)|别|勿|禁止|无需|取消|停止).{0,24}(?:联网|上网|网络|外发|发出请求|发送请求)/.test(text) ||
    /\b(?:don't|do not|no|never|without|cancel|stop)\b.{0,48}\b(?:network|browse|requests?|sending|send)\b/i.test(text) ||
    /(?:^|[，,。；;\n!?！？])\s*(?:算了|不要了|不用了|取消(?:吧)?|停止|别查了|别读了|不用看了)(?:\s|[，,。；;!?！？]|$)/.test(text) ||
    /(?:^|[,;\n.!?])\s*(?:never mind|cancel(?: it)?|stop)(?:\s|[,.!?;]|$)/i.test(text);
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

export function safeToolBatch(message, maxCalls = CHAT_TOOL_LIMITS.toolCalls) {
  const calls = message?.tool_calls;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 24 || !Array.isArray(calls) || !calls.length || calls.length > maxCalls) return null;
  const ids = new Set();
  for (const call of calls) {
    if (!validToolCallEnvelope(call) || ids.has(call.id)) return null;
    if (typeof call.function.arguments !== "string" || call.function.arguments.length > 2048) return null;
    ids.add(call.id);
  }
  return calls;
}

export function validToolCallEnvelope(call) {
  return call?.type === "function" && typeof call.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(call.id) &&
    typeof call.function?.name === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(call.function.name);
}
