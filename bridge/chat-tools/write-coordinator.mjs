import path from "node:path";
import { createHash } from "node:crypto";
import { CFG } from "../config.mjs";
import { getMemoryPrivacyGeneration, getUserMemoryGeneration } from "../memory-profile/generation.mjs";
import { summaryPrivacy } from "../group-summary/state.mjs";
import { sendMsg } from "../napcat.mjs";
import { classifyOutboundDelivery } from "../cognition/outcome.mjs";
import { createPersonalChangeAdapter } from "./personal-changes.mjs";
import { createConfirmationStore } from "./confirmations.mjs";
import { createReminderService } from "../agent-reminders/service.mjs";
import { agentPersonalAllowed, agentRemindersAllowed, authorizedReminderArguments } from "./policy.mjs";
import { registerAgentOwnedStateCleaner } from "./owned-state.mjs";
import { autonomousPreparationAllowed, autonomousPreparationArgumentsSafe } from "./preparation-policy.mjs";

const activeOptions = { task: "group_chat", mentioned: true };
const denied = () => ({ status: "denied", reason: "not_allowed" });
const personalActions = new Set(["set_name", "set_style", "memory_create", "memory_update", "memory_remove"]);

export function agentWriteBinding(scope, cfg = CFG) {
  return { privacyRevision: getMemoryPrivacyGeneration(), userRevision: getUserMemoryGeneration(scope.userId),
    sourceIdentity: createHash("sha256").update(JSON.stringify([cfg.dataRoot, cfg.memoryFile, cfg.memoryProfileFile,
      cfg.groupWhitelist || [], cfg.botBlacklist || [], cfg.agentGroupWhitelist || [],
      cfg.agentWriteGroupWhitelist || [], cfg.agentReminderGroupWhitelist || []])).digest("hex") };
}

export function createAgentWriteCoordinator(options = {}) {
  const cfg = options.cfg || CFG;
  const root = path.join(cfg.dataRoot, ".qqfriend", "agent");
  const confirmations = options.confirmations || createConfirmationStore({ filename: path.join(root, "confirmations.json"), now: options.now });
  const personal = options.personal || createPersonalChangeAdapter(options.personalOptions);
  const allowed = (scope, domain) => domain === "personal" ? agentPersonalAllowed(scope, cfg, activeOptions)
    : domain === "reminder" && agentRemindersAllowed(scope, cfg, activeOptions);
  const privacyCutoff = scope => {
    const privacy = summaryPrivacy({ root: path.join(cfg.dataRoot, ".qqfriend", "summaries") });
    if (!privacy.users || typeof privacy.users !== "object" || Array.isArray(privacy.users)) throw new Error("privacy_unavailable");
    const value = privacy.users[String(scope.userId)] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("privacy_unavailable");
    return value;
  };
  const reminders = options.reminders || createReminderService({ filename: path.join(root, "reminders.json"), now: options.now,
    isPermitted: scope => allowed(scope, "reminder"), readPrivacyCutoff: privacyCutoff,
    deliver: options.deliver || ((job, settings) => deliverReminder(job, settings, allowed, privacyCutoff)) });

  async function prepare(domain, args, runtime) {
    const admission = admitPreparation(domain, args, runtime);
    if (admission.error) return admission.error;
    runtime = admission.runtime;
    if (!preparationIsCurrent(runtime) || !ownedReminderProposal(domain, args, runtime)) return denied();
    const prepared = domain === "personal" ? await personal.prepare(args, personalRuntime(runtime)) : await reminders.prepare(runtime.scope, args);
    if (!preparationIsCurrent(runtime) || !allowed(runtime.scope, domain)) return denied();
    if (prepared?.status !== "ready" || !prepared.operation) return prepared || { status: "unavailable" };
    const result = confirmations.create(runtime.scope, prepared.operation, { messageId: runtime.messageId, binding: agentWriteBinding(runtime.scope, cfg) });
    if (!preparationIsCurrent(runtime)) return denied();
    return pendingToolResult(result);
  }

  function admitPreparation(domain, args, runtime) {
    if (runtime?.scope?.currentMessageId !== undefined && String(runtime.scope.currentMessageId) !== runtime.messageId) return { error: denied() };
    runtime = normalizeRuntime(runtime);
    if (!runtime || !allowed(runtime.scope, domain)) return { error: denied() };
    const permitted = runtime.autonomous === true ? autonomousPreparationAllowed(runtime.userMessage, domain, args)
      : domain !== "reminder" || authorizedReminderArguments(args, runtime.userMessage);
    if (!permitted) return { error: denied() };
    if (runtime.autonomous === true && !autonomousPreparationArgumentsSafe(args)) return { error: { status: "invalid_arguments" } };
    return { runtime };
  }

  function ownedReminderProposal(domain, args, runtime) {
    if (runtime.autonomous !== true || domain !== "reminder" || args.action !== "cancel") return true;
    const view = reminders.list(runtime.scope);
    return view?.status === "ready" && view.items.some(item => item.ref === args.ref);
  }

  function personalRuntime(runtime) {
    return { ...runtime, cfg, isPermitted: scope => allowed(scope, "personal") };
  }

  async function confirm(ref, runtime) {
    runtime = normalizeRuntime(runtime);
    if (!runtime || runtime.actualUserCommand !== "确认 " + ref) return denied();
    runtime.assertCurrent();
    const inspected = confirmations.inspect(runtime.scope, ref);
    const action = inspected?.item?.action;
    const domain = personalActions.has(action) ? "personal" : ["create", "cancel"].includes(action) ? "reminder" : "";
    if (!allowed(runtime.scope, domain)) return denied();
    return await confirmations.execute(runtime.scope, ref, {
      binding: agentWriteBinding(runtime.scope, cfg), assertCurrent: runtime.assertCurrent,
      apply: async operation => {
        runtime.assertCurrent();
        if (!allowed(runtime.scope, operation.domain)) return { status: "not_applied", text: "当前权限不允许这项变更。" };
        const result = operation.domain === "personal" ? personal.commit(operation, personalRuntime(runtime))
          : reminders.commit(runtime.scope, operation, { idempotencyKey: ref });
        if (["applied", "unknown"].includes(result?.status)) runtime.acceptCommit?.();
        return result;
      },
    });
  }

  function read(args, runtime) {
    runtime = normalizeRuntime(runtime);
    if (!runtime) return denied();
    runtime.assertCurrent();
    const domain = args.kind === "confirmations" ? "personal" : args.kind === "reminders" ? "reminder" : "";
    if (args.kind === "confirmations") {
      if (!allowed(runtime.scope, "personal") && !allowed(runtime.scope, "reminder")) return denied();
      return boundedRead(args.ref ? confirmations.inspect(runtime.scope, args.ref) : confirmations.list(runtime.scope));
    }
    if (!allowed(runtime.scope, domain)) return denied();
    const view = reminders.list(runtime.scope);
    return boundedRead(args.ref ? { ...view, items: view.items?.filter(item => item.ref === args.ref) } : view);
  }

  function revoke(ref, runtime) {
    runtime = normalizeRuntime(runtime);
    if (!runtime || (!allowed(runtime.scope, "personal") && !allowed(runtime.scope, "reminder"))) return denied();
    runtime.assertCurrent();
    return confirmations.revoke(runtime.scope, ref);
  }

  function cancelReminder(ref, runtime) {
    runtime = normalizeRuntime(runtime);
    if (!runtime || !allowed(runtime.scope, "reminder")) return denied();
    runtime.assertCurrent();
    return reminders.cancel(runtime.scope, ref);
  }

  function snapshot() {
    const confirmationsView = metadataList(safeList(confirmations), "confirmation");
    const remindersView = metadataList(safeList(reminders), "reminder");
    return { status: confirmationsView.status === "ready" && remindersView.status === "ready" ? "ready" : "unavailable",
      enabled: [...(cfg.agentWriteGroupWhitelist || []), ...(cfg.agentReminderGroupWhitelist || [])]
        .some(group => (cfg.agentGroupWhitelist || []).some(base => String(group) === String(base))),
      confirmations: confirmationsView, reminders: remindersView };
  }

  const forget = (uid, settings) => {
    const a = revokeUser(confirmations, uid, settings);
    const b = revokeUser(reminders, uid, settings);
    return a === true && b === true;
  };
  return { preparePersonal: (args, runtime) => prepare("personal", args, runtime),
    prepareReminder: (args, runtime) => prepare("reminder", args, runtime), confirm, read, revoke, cancelReminder, snapshot, forget,
    start: () => (cfg.agentReminderGroupWhitelist || []).length ? reminders.start() : false,
    stop: settings => reminders.stop(settings) };
}

function normalizeRuntime(runtime) {
  if (runtime?.task !== "group_chat" || runtime.mentioned !== true || runtime.scope?.surface !== "group" ||
      typeof runtime.assertCurrent !== "function" || typeof runtime.messageId !== "string" ||
      !/^-?(?:0|[1-9]\d{0,19})$/.test(runtime.messageId) || runtime.messageId === "-0") return null;
  const groupId = String(runtime.scope.groupId ?? "");
  const userId = String(runtime.scope.userId ?? "");
  if (!/^[1-9]\d{0,19}$/.test(groupId) || !/^[1-9]\d{0,19}$/.test(userId)) return null;
  return { ...runtime, scope: Object.freeze({ surface: "group", groupId, userId }) };
}

function preparationIsCurrent(runtime) {
  if (runtime.autonomous === true && (!(runtime.signal instanceof AbortSignal) || runtime.signal.aborted)) return false;
  return runtime.assertCurrent() !== false;
}

function safeList(service) {
  try { return service.list(); } catch { return { status: "unavailable", items: [] }; }
}

function revokeUser(service, uid, settings) {
  try { return service.revokeUser(uid, settings) === true; } catch { return false; }
}

function pendingToolResult(result) {
  if (result?.status !== "pending" || typeof result.ref !== "string" || typeof result.preview !== "string") return { status: "unavailable" };
  return { status: "ok", phase: "pending", confirmation_ref: result.ref, expiresAt: result.expiresAt,
    text: result.preview + "\n待确认，尚未保存或执行。由本人另发：@机器人 确认 " + result.ref, applied: false };
}

function boundedRead(snapshot) {
  if (snapshot?.status !== "ready") return { status: "unavailable", reason: "actions_not_available" };
  const items = snapshot.item ? [snapshot.item] : snapshot.items;
  if (!Array.isArray(items)) return { status: "unavailable" };
  const safe = items.slice(-6).map(item => ({ ref: item.ref, action: item.action, phase: item.phase,
    expiresAt: item.expiresAt, dueAt: item.dueAt,
    ...(item.phase === "pending" && typeof item.preview === "string" ? { preview: item.preview.slice(0, 120) } : {}) }));
  return { status: safe.length ? "ok" : "empty", text: safe.length ? safe.map(actionLine).join("\n") : "当前群没有可读取的本人待确认项或提醒。" };
}

function actionLine(item) {
  const labels = { pending: "待确认", executing: "正在执行", applied: "已执行", not_applied: "未执行", unknown: "结果未知，不会自动重试",
    revoked: "已撤销", expired: "已过期", invalidated: "已失效", armed: "等待提醒", sending: "正在发送", sent: "已发送", failed: "发送失败", cancelled: "已取消", partial: "部分发送，不会自动重试" };
  const time = typeof item.dueAt === "string" ? reminderTimestamp(item.dueAt) : item.expiresAt;
  const suffix = Number.isSafeInteger(time) ? " · " + new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + " 北京时间" : "";
  return item.ref + " · " + (labels[item.phase] || "状态未确认") + suffix + (item.preview ? "\n拟变更节选：" + item.preview : "");
}

function metadataList(snapshot, kind) {
  if (snapshot?.status !== "ready" || !Array.isArray(snapshot.items)) return { status: "unavailable", items: [] };
  return { status: "ready", items: snapshot.items.slice(-128).map(item => ({ ref: item.ref, phase: item.phase, createdAt: item.createdAt,
    ...(kind === "confirmation" ? { action: item.action, expiresAt: item.expiresAt } : { dueAt: reminderTimestamp(item.dueAt) }) })) };
}

function reminderTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 && new Date(timestamp).toISOString() === value ? timestamp : null;
}

async function deliverReminder(job, settings, allowed, cutoff) {
  const scope = job.scope;
  const stopReason = () => !allowed(scope, "reminder") || job.createdAt <= cutoff(scope) ? "permission_changed" : "";
  if (stopReason()) return { status: "failed" };
  const receipt = await sendMsg(scope.groupId, [{ type: "at", data: { qq: String(scope.userId) } },
    { type: "text", data: { text: "提醒：" + job.text } }], undefined, { signal: settings.signal, stopReason, safeRetry: false });
  return { status: classifyOutboundDelivery(receipt) };
}

export const agentWriteCoordinator = createAgentWriteCoordinator();
registerAgentOwnedStateCleaner(agentWriteCoordinator.forget);
