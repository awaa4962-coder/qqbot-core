import { host } from "./state.js";
import { $ } from "./dom.js";
import { beginAction, endAction, finishActivity, showActivity } from "./activity.js";
import { ACTION_LABELS } from "./metadata.js";
import { taskPhaseLabel } from "./tasks.js";
import { renderStickers } from "../pages/stickers.js";

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
    renderStickers(await host.call("getStickers"));
    finishActivity("后台任务已完成，页面已同步");
  } catch (error) {
    status.textContent = error.message;
    finishActivity(error.message, "error");
  } finally {
    endAction(action);
  }
}
