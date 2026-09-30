import { host } from "./state.js";
import { $ } from "./dom.js";
import { beginAction, endAction, finishActivity, showActivity } from "./activity.js";
import { ACTION_LABELS } from "./metadata.js";
import { taskPhaseLabel, taskResultError } from "./tasks.js";
import { renderStickers, setStickerCatalogAvailability } from "../pages/stickers.js";
import { capabilityReadFailed, renderCapabilities, setCapabilityNotice } from "../pages/capabilities.js";
import { hasVerifiedNativeTools } from "../agent-tools.js";

const ACTIONS = { sync: "syncStickers", analyze: "analyzeStickers", capabilities: "refreshStickerCapabilities", cleanup: "cleanupStickerTemp" };

export function installTaskFeedback() {
  window.addEventListener("qqfriend:task", event => {
    handle(event.detail).catch(() => finishActivity("读取任务结果失败，请刷新对应页面", "error"));
  });
}

async function handle({ type, task }) {
  if (task.module === "memes") {
    $("memeStatus").textContent = "自动梗库已停用，旧任务不会恢复或回填归档。";
    return;
  }
  if (task.module === "agent_tools") { await handleAgentTools(type, task); return; }
  if (task.module !== "stickers") return;
  const action = ACTIONS[task.action];
  if (!action) return;
  const status = $("stickerStatus");
  if (type === "started") beginAction(action, null, true);
  if (type === "started" || type === "progress") {
    status.textContent = taskPhaseLabel(task.phase);
    showActivity(ACTION_LABELS[action], "working", taskPhaseLabel(task.phase));
    return;
  }
  try {
    if (task.taskStateUnknown) {
      status.textContent = task.error;
      finishActivity("任务结果尚未确认", "error", task.error);
      return;
    }
    if (type === "error" || task.phase !== "done") throw new Error(task.error || taskPhaseLabel(task.phase));
    const problem = taskResultError(task);
    const snapshot = await host.call("getStickers");
    renderStickers(snapshot);
    if (snapshot.available === false) throw new Error("表情目录暂不可读，原文件已保留");
    if (problem) throw new Error(problem);
    status.textContent = "后台任务已确认完成，目录已刷新。";
    finishActivity("后台任务已完成，页面已同步");
  } catch (error) {
    status.textContent = error.message;
    finishActivity(error.message, "error");
  } finally {
    endAction(action);
    setStickerCatalogAvailability();
  }
}

async function handleAgentTools(type, task) {
  if (task.action !== "probe") return;
  const action = "probeAgentTools";
  if (type === "started") beginAction(action, null, true);
  if (type === "started" || type === "progress") {
    const uncertain = ["unknown", "pending"].includes(task.phase);
    const terminal = ["done", "failed", "interrupted", "cancelled"].includes(task.phase);
    const message = terminal ? "验证任务已结束，正在读取任务记录…" : taskPhaseLabel(task.phase);
    setCapabilityNotice(message, uncertain ? "error" : "loading");
    showActivity(uncertain ? "验证任务状态尚未确认" : terminal ? "正在读取工具验证任务" : ACTION_LABELS[action], uncertain ? "error" : "working", message);
    return;
  }
  let refreshed = false;
  try {
    if (task.taskStateUnknown || task.phase === "unknown") {
      const message = task.error || "验证任务结果尚未确认，请刷新任务状态，勿重复提交。";
      setCapabilityNotice(message, "error");
      finishActivity("验证任务结果尚未确认", "error", message);
      return;
    }
    const problem = taskResultError(task) || (task.result?.ok === true ? "" : "验证任务结果尚未完整确认，请核对任务记录。");
    const snapshot = await host.call("getCapabilities");
    renderCapabilities(snapshot);
    refreshed = true;
    if (problem) throw new Error(problem);
    if (!hasVerifiedNativeTools(snapshot.agentTools?.compatibility)) throw new Error("验证任务已结束，主备模型证据尚未完整确认，请查看能力状态。");
    setCapabilityNotice("后台工具验证已确认完成，能力状态已刷新。", "ready");
    finishActivity("后台工具验证已确认完成，能力状态已刷新");
  } catch (error) {
    if (refreshed) setCapabilityNotice(error.message, "error");
    else capabilityReadFailed(error);
    finishActivity(error.message, "error");
  } finally { endAction(action); }
}
