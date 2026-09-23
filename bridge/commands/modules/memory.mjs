import { CFG } from "../../config.mjs";
import { getMemoryPrivacyGeneration } from "../../memory-profile/generation.mjs";
import { prepareCommandText } from "../normalize.mjs";
import { canUsePrivateChat, isAdminUser } from "../permissions.mjs";
import { messageRouteRejection } from "../../event-admission.mjs";

const COMMAND_HEAD = /^(我的记忆|记忆帮助|记住|纠正记忆|删除记忆)(?=\s|$)/;
const NOTE_ID = /^[A-Za-z0-9_-]+$/;
const SELF_ONLY = "记忆命令只能管理你自己在当前会话的记忆，不能指定其他用户或群。";
const PRIVACY_CHANGED = "记忆或隐私状态已更新，请重新发送命令。";

export function isSelfMemoryCommand(cmd) {
  return COMMAND_HEAD.test(cmd);
}

export function memoryCommandHelp() {
  return [
    "我的记忆帮助",
    "我的记忆：查看当前会话中自己的记忆和 id",
    "记忆帮助：查看本帮助",
    "记住 <标题> = <内容>",
    "纠正记忆 <id> = <内容>",
    "删除记忆 <id>",
    "每个范围最多 32 条；标题最多 32 字，内容最多 300 字；命令保存有效期为 30 天，最长 90 天。",
    "群聊需要 @机器人；只能操作自己的记忆，各群与私聊相互隔离。",
    "私聊需要普通私聊白名单；管理员沿用现有命令权限，但也只能操作自己。",
    "私聊发送“记住”只授权保存这一条，不会开启自动保存私聊历史。",
  ].join("\n");
}

export function buildMemoryCommandReply(cmd, options = {}) {
  const request = prepareRequest(cmd, options);
  if (!request) return null;
  return request.reply || "记忆命令需要异步处理，请在群聊或私聊中直接发送命令。";
}

export async function buildMemoryCommandReplyAsync(cmd, options = {}) {
  const guard = options.memoryGuard || createMemoryCommandGuard(options);
  const request = prepareRequest(cmd, options);
  if (!request) return null;
  if (request.reply) return request.reply;
  if (guard.stopReason()) return PRIVACY_CHANGED;
  try {
    const service = await noteService(options);
    const snapshot = await service.snapshot(request.scope);
    if (guard.stopReason()) return PRIVACY_CHANGED;
    if (request.action === "list") return renderSnapshot(snapshot, request.scope);
    const result = service.act({
      ...request.fields,
      ...request.scope,
      action: request.action,
      revision: snapshot.revision,
    }, {
      origin: "user_command",
      messageId: options.messageId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    // The synchronous backend invalidates on commit; only subsequent invalidation cancels its reply.
    guard.acceptCommit();
    const fresh = await result;
    if (guard.stopReason()) return PRIVACY_CHANGED;
    const verb = { create: "保存", update: "纠正", remove: "删除" }[request.action];
    return "记忆已" + verb + "。\n" + renderSnapshot(fresh, request.scope);
  } catch (error) {
    return renderError(error);
  }
}

export function createMemoryCommandGuard(options = {}) {
  let generation = options.contextPrivacyGeneration ?? getMemoryPrivacyGeneration();
  return {
    acceptCommit() { generation = getMemoryPrivacyGeneration(); },
    stopReason() {
      if (generation !== getMemoryPrivacyGeneration()) return "privacy_changed";
      const scope = memoryScope(options);
      if (!scope || memoryPermissionDenial(scope, options)) return "permission_changed";
      return "";
    },
  };
}

function prepareRequest(cmd, options) {
  if (!isSelfMemoryCommand(cmd)) return null;
  const scope = memoryScope(options);
  if (!scope) return { reply: "无法确认当前用户或会话，未读取或修改记忆。" };
  const denial = memoryPermissionDenial(scope, options);
  if (denial) return { reply: denial };
  const request = parseMemoryRequest(prepareCommandText(options.rawCommandText ?? cmd, options), scope);
  if (!request.reply && request.action !== "list" && !hasMessageSource(options.messageId)) {
    return { reply: "缺少有效消息来源，本次没有修改记忆。" };
  }
  return request;
}

function memoryPermissionDenial(scope, options) {
  const cfg = options.cfg || CFG;
  if (messageRouteRejection({ message_type: scope.groupId === "private" ? "private" : "group", user_id: scope.userId, group_id: scope.groupId }, cfg)) {
    return "当前会话已不满足访问条件。";
  }
  if (scope.groupId === "private" && !canUsePrivateChat(scope.userId, cfg) && !isAdminUser(scope.userId, options.admins || cfg.adminUins || [])) {
    return "记忆命令需要普通私聊白名单权限。";
  }
  const mentions = [...(options.mentions || []), ...(options.mentionedUsers || [])];
  if (mentions.some(item => !item.isBot && String(item.qq) !== String(options.selfUin ?? cfg.selfUin) && String(item.qq) !== String(scope.userId))) {
    return SELF_ONLY;
  }
  return "";
}

function parseMemoryRequest(source, scope) {
  const head = source.match(COMMAND_HEAD)?.[1];
  if (!head) return { reply: memoryCommandHelp() };
  if (head === "我的记忆" || head === "记忆帮助") {
    if (source !== head) return { reply: SELF_ONLY + "\n" + memoryCommandHelp() };
    return head === "记忆帮助" ? { reply: memoryCommandHelp() } : { action: "list", scope };
  }
  const arg = source.slice(head.length).trim();
  if (head === "删除记忆") {
    return NOTE_ID.test(arg)
      ? { action: "remove", fields: { id: arg }, scope }
      : { reply: SELF_ONLY + "\n用法：删除记忆 <id>；id 请从“我的记忆”获取。" };
  }
  return parseMemoryAssignment(head, arg, scope);
}

function parseMemoryAssignment(head, arg, scope) {
  const equals = arg.indexOf("=");
  const key = arg.slice(0, equals).trim();
  const text = arg.slice(equals + 1).trim();
  if (equals < 0 || !key || !text || (head === "纠正记忆" && !NOTE_ID.test(key))) {
    return { reply: "格式不正确，未修改记忆。\n" + memoryCommandHelp() };
  }
  return head === "记住"
    ? { action: "create", fields: { title: key, text }, scope }
    : { action: "update", fields: { id: key, text }, scope };
}

function memoryScope(options) {
  const userId = Number(options.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const group = options.groupId;
  const isPrivate = options.surface !== "group" && (group === undefined || group === null || group === "private");
  if (isPrivate) return { userId, groupId: "private" };
  const groupId = Number(group);
  return Number.isSafeInteger(groupId) && groupId > 0 ? { userId, groupId } : null;
}

function hasMessageSource(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return false;
  return /^-?\d{1,20}$/.test(String(value));
}

async function noteService(options) {
  if (options.noteService) return options.noteService;
  if (options.skipSave) throw Object.assign(new Error("测试记忆命令请注入 noteService.snapshot/act，不会访问真实记忆存储。"), { statusCode: 400 });
  const { memoryNotesSnapshot, applyMemoryNoteAction } = await import("../../memory-profile/notes.mjs");
  return { snapshot: memoryNotesSnapshot, act: applyMemoryNoteAction };
}

function renderSnapshot(snapshot, scope) {
  const label = scope.groupId === "private" ? "私聊" : "本群";
  const lines = ["我的记忆（" + label + "）"];
  if (!snapshot.items.length) lines.push("当前没有记忆。使用“记住 <标题> = <内容>”保存一条。");
  for (const item of snapshot.items) {
    lines.push("", item.id + " | " + item.title, item.text);
    const state = { active: "有效", expired: "已过期" }[item.state] || item.state;
    const source = item.kind === "user_statement" ? "本人命令" : "管理员备注";
    const expiry = new Date(item.expiresAt);
    lines.push("状态：" + state + "；来源：" + source + "；到期：" + (Number.isNaN(expiry.getTime()) ? "未标注" : expiry.toISOString()));
  }
  lines.push("", "发送“记忆帮助”查看用法。群聊中的命令回复对本群可见。");
  return lines.join("\n");
}

function renderError(error) {
  const status = Number(error?.statusCode);
  if (status >= 400 && status < 600) {
    const detail = String(error.message || "请求未通过检查。").slice(0, 300);
    const hint = status === 409 ? "\n请先发送“我的记忆”刷新，再重新操作。" : "";
    return "记忆操作未完成：" + detail + hint;
  }
  return "记忆服务暂时不可用，未能确认操作结果，请稍后发送“我的记忆”查看。";
}
