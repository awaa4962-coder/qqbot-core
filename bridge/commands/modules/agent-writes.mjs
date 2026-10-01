import { CFG } from "../../config.mjs";
import { agentWriteCoordinator } from "../../chat-tools/write-coordinator.mjs";
import { agentPersonalAllowed, agentRemindersAllowed } from "../../chat-tools/policy.mjs";
import { getMemoryPrivacyGeneration } from "../../memory-profile/generation.mjs";
import { prepareCommandText } from "../normalize.mjs";

const HEAD = /^(?:确认|取消确认|待确认|my-actions|我的提醒|my-reminders|取消提醒)(?=\s|$)/;
const CF = /^cf_[a-f0-9]{32}$/;
const REM = /^rem_[a-f0-9]{32}$/;
const GUIDE = "请在开放功能的群里 @机器人使用：待确认、确认 <cf_编号>、取消确认 <cf_编号>、我的提醒、取消提醒 <rem_编号>。";
const ACTIVE = { task: "group_chat", mentioned: true };

export function isAgentWriteCommand(cmd) { return HEAD.test(cmd); }
export function agentWriteCommandGuide() { return GUIDE; }

export function createAgentWriteCommandGuard(options = {}) {
  let generation = options.contextPrivacyGeneration ?? getMemoryPrivacyGeneration();
  const cfg = options.cfg || CFG;
  const scope = scopeFromOptions(options);
  return {
    acceptCommit() { generation = getMemoryPrivacyGeneration(); },
    stopReason() {
      if (generation !== getMemoryPrivacyGeneration()) return "privacy_changed";
      if (!scope || (!agentPersonalAllowed(scope, cfg, ACTIVE) && !agentRemindersAllowed(scope, cfg, ACTIVE))) return "permission_changed";
      return "";
    },
  };
}

export async function buildAgentWriteCommandReply(cmd, options = {}) {
  if (!isAgentWriteCommand(cmd)) return null;
  const scope = scopeFromOptions(options);
  if (!scope || options.mentioned !== true || !hasMessageId(options.messageId)) return GUIDE;
  // Only the actual current user's text may authorize a deterministic action, never quoted material or model output.
  const actual = typeof options.currentUserText === "string" ? prepareCommandText(options.currentUserText, {
    ...options, requireMention: true,
  }).replace(/\s+/g, " ").trim().toLowerCase() : "";
  if (actual !== cmd) return "没有收到本人明确的操作命令，未执行变更。";
  const guard = options.memoryGuard || createAgentWriteCommandGuard(options);
  if (guard.stopReason()) return "当前功能未开放或隐私状态已变化，未执行变更。";
  const coordinator = options.writeCoordinator || agentWriteCoordinator;
  const runtime = { scope, task: "group_chat", mentioned: true, messageId: String(options.messageId),
    userMessage: options.currentUserText, actualUserCommand: cmd, signal: new AbortController().signal,
    acceptCommit: guard.acceptCommit,
    assertCurrent() { const reason = guard.stopReason(); if (reason) throw new Error(reason); } };
  try {
    const result = await executeCommand(cmd, coordinator, runtime);
    return renderResult(result);
  } catch { return "操作结果未能确认。请查看待确认项或我的提醒；没有自动重试。"; }
}

function scopeFromOptions(options) {
  const userId = String(options.userId ?? "");
  const groupId = String(options.groupId ?? "");
  return options.surface === "group" && /^[1-9]\d{0,19}$/.test(userId) && /^[1-9]\d{0,19}$/.test(groupId)
    ? Object.freeze({ surface: "group", userId, groupId }) : null;
}

function hasMessageId(value) {
  return (typeof value === "string" || Number.isSafeInteger(value)) && /^(?:0|-?[1-9]\d{0,19})$/.test(String(value));
}

async function executeCommand(cmd, coordinator, runtime) {
  if (["待确认", "my-actions"].includes(cmd)) return coordinator.read({ kind: "confirmations" }, runtime);
  if (["我的提醒", "my-reminders"].includes(cmd)) return coordinator.read({ kind: "reminders" }, runtime);
  const [head, ref, ...extra] = cmd.split(/\s+/);
  if (extra.length) return { status: "invalid" };
  if (head === "确认" && CF.test(ref || "")) return await coordinator.confirm(ref, runtime);
  if (head === "取消确认" && CF.test(ref || "")) return coordinator.revoke(ref, runtime);
  if (head === "取消提醒" && REM.test(ref || "")) return coordinator.cancelReminder(ref, runtime);
  return { status: "invalid" };
}

function renderResult(result) {
  if (result.status === "applied") return result.text || "这项变更已完成。";
  if (["revoked", "cancelled"].includes(result.status)) return "已取消这项待确认操作或提醒。";
  if (result.status === "unknown") return "结果未知，可能已执行或发送。没有自动重试，请查看当前状态。";
  if (["ok", "empty"].includes(result.status)) return result.text;
  if (result.status === "not_applied") return result.text || "这项变更未执行，请重新提出请求。";
  if (result.status === "expired") return "确认已过期，请重新提出请求。";
  if (["terminal", "not_found"].includes(result.status)) return "这项操作已结束或当前群没有对应记录。";
  if (result.status === "invalid") return GUIDE;
  return "当前无法执行或读取这项操作。请核对编号、本人会话和功能开放状态。";
}
