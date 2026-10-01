import { host } from "./state.js";
import { $, setOutput } from "./dom.js";
import { beginAction, endAction, finishActivity, toast } from "./activity.js";
import { isAgentDraftTaskId, isAgentDraftTerminalPhase, mountAgentDrafts, validateAgentDraftSnapshot } from "../agent-drafts.js";

const ACTIONS = new Set(["refreshAgentDrafts", "inspectAgentDraft", "cancelAgentDraft"]);
let viewGeneration = 0;
let loadedTask;

export function isAgentDraftAction(action) { return ACTIONS.has(action); }

export function invalidateAgentDraftView() {
  viewGeneration++;
  loadedTask = undefined;
  const panel = $("agentDraftsPanel");
  if (panel) mountAgentDrafts(panel, { status: "unavailable" });
  const status = $("agentDraftActionStatus");
  if (status) status.textContent = "草稿状态未确认，旧预览已清除。";
}

export function renderAgentDraftSnapshot(snapshot, { generation, preservePreview = true } = {}) {
  if (generation !== undefined && generation !== viewGeneration) return false;
  if (!validateAgentDraftSnapshot(snapshot)) {
    invalidateAgentDraftView();
    return false;
  }
  viewGeneration++;
  let next = snapshot;
  let retained = false;
  if (!snapshot.enabled) {
    loadedTask = undefined;
    next = { status: snapshot.status, enabled: false, tasks: snapshot.tasks };
  } else if (snapshot.task === undefined && preservePreview && loadedTask) {
    const candidate = { status: snapshot.status, enabled: snapshot.enabled, tasks: snapshot.tasks, task: loadedTask };
    if (validateAgentDraftSnapshot(candidate, { requireResult: true })) { next = candidate; retained = true; }
  }
  loadedTask = snapshot.enabled && validateAgentDraftSnapshot(next, { requireResult: true }) ? next.task : undefined;
  const panel = $("agentDraftsPanel");
  const previous = retained ? panel?.querySelector(".agent-drafts-text") : null;
  const scroll = previous ? [previous.scrollTop, previous.scrollLeft] : null;
  if (panel) {
    mountAgentDrafts(panel, next);
    const preview = scroll ? panel.querySelector(".agent-drafts-text") : null;
    if (preview) { preview.scrollTop = scroll[0]; preview.scrollLeft = scroll[1]; }
  }
  const status = $("agentDraftActionStatus");
  if (status) status.textContent = snapshot.enabled ? "草稿任务状态已更新。" : "草稿功能未开放。";
  return true;
}

function actionFeedback(action, snapshot, cancellation) {
  if (action === "cancelAgentDraft") {
    if (cancellation === "ended") return ["任务已结束，本次未取消。", "error"];
    if (snapshot.task.phase === "cancelled") return ["后台已确认任务取消。", "success"];
    return isAgentDraftTerminalPhase(snapshot.task.phase)
      ? ["取消请求已确认；任务已结束，但取消未获确认。", "error"]
      : ["取消请求已确认，后台尚未确认停止。", "success"];
  }
  if (action === "inspectAgentDraft") {
    if (!snapshot.enabled) return ["草稿功能未开放，正文未载入。", "error"];
    return validateAgentDraftSnapshot(snapshot, { requireResult: true })
      ? ["草稿已载入，未发送或保存。", "success"] : ["草稿未完成或不可读，请核对任务状态。", "error"];
  }
  return snapshot.enabled ? ["草稿任务已刷新。", "success"] : ["草稿功能未开放。", "error"];
}

function cancelFailure(cancellation) {
  if (cancellation === "requested") return "取消请求已确认，当前任务状态未读到；没有重新提交。";
  if (cancellation === "ended") return "任务已结束，本次未取消；当前状态读取失败，没有重新提交。";
  return "取消结果未确认，请刷新核实；没有自动重发。";
}

export async function runAgentDraftAction(action, button, options = {}) {
  const silent = options.silent === true;
  if (!isAgentDraftAction(action)) return;
  if (host.mode !== "browser") { if (!silent) toast("草稿任务只在 Linux 控制台开放。", "error"); return; }
  const id = action === "refreshAgentDrafts" ? undefined : button?.dataset.taskId;
  if (action !== "refreshAgentDrafts" && !isAgentDraftTaskId(id)) {
    toast("任务引用无效，请重新读取列表。", "error");
    return;
  }
  if (!beginAction(action, button, silent)) return;
  const generation = viewGeneration;
  let cancellation = "unknown";
  try {
    setOutput("agentDraftActionStatus", action === "cancelAgentDraft" ? "正在请求取消…" : "正在读取草稿任务…", true);
    if (action === "cancelAgentDraft") {
      const result = await host.call("cancelAgentDraft", { id });
      if (generation !== viewGeneration) return;
      if (result?.ok !== true || result.task?.jobId !== id || typeof result.task.cancelRequested !== "boolean") {
        throw new Error("cancel_unconfirmed");
      }
      if (result.task.cancelRequested === true && result.task.phase === "cancelling") cancellation = "requested";
      else if (result.task.cancelRequested === false && isAgentDraftTerminalPhase(result.task.phase)) cancellation = "ended";
      else throw new Error("cancel_unconfirmed");
    }
    const snapshot = await host.call("getAgentDrafts", action === "refreshAgentDrafts" ? {} : { id });
    if (generation !== viewGeneration) return;
    if (!validateAgentDraftSnapshot(snapshot, { id })) throw new Error("draft_state_unknown");
    if (!renderAgentDraftSnapshot(snapshot, { generation, preservePreview: action === "refreshAgentDrafts" })) return;
    const [message, tone] = actionFeedback(action, snapshot, cancellation);
    setOutput("agentDraftActionStatus", message);
    if (!silent) toast(message, tone);
    finishActivity(message, tone, message);
  } catch {
    if (generation !== viewGeneration) return;
    invalidateAgentDraftView();
    const message = action === "cancelAgentDraft"
      ? cancelFailure(cancellation)
      : "草稿任务读取失败，旧预览已清除。";
    setOutput("agentDraftActionStatus", message);
    if (!silent) toast(message, "error");
    finishActivity(message, "error", message);
  } finally { endAction(action); }
}
