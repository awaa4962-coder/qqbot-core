import { host, state } from "./state.js";
import { $ } from "./dom.js";
import { beginAction, endAction, finishActivity, showActivity } from "./activity.js";
import { ACTION_LABELS } from "./metadata.js";
import { taskPhaseLabel, retainTaskResult } from "./tasks.js";
import { applyMemeResearch, clearMemeForm, fillMemeForm, renderMemes } from "../pages/memes.js";
import { renderStickers } from "../pages/stickers.js";

const ACTIONS = { "run-web-update": "runMemeWebUpdate", "research-web": "researchMemeWeb", sync: "syncStickers", analyze: "analyzeStickers", capabilities: "refreshStickerCapabilities", cleanup: "cleanupStickerTemp" };

export function installTaskFeedback() {
  window.addEventListener("qqfriend:task", event => {
    handle(event.detail).catch(() => finishActivity("读取任务结果失败，请刷新对应页面", "error"));
  });
}

async function handle({ type, task }) {
  const action = ACTIONS[task.action];
  if (!action) return;
  const status = $(task.module === "memes" ? "memeStatus" : "stickerStatus");
  if (type === "started") beginAction(action, null, true);
  if (type === "started" || type === "progress") {
    status.textContent = taskPhaseLabel(task.phase);
    showActivity(ACTION_LABELS[action], "working", taskPhaseLabel(task.phase)); return;
  }
  try {
    if (type === "error" || task.phase !== "done") throw new Error(task.error || taskPhaseLabel(task.phase));
    if (task.module === "stickers") renderStickers(await host.call("getStickers"));
    if (task.module === "memes") {
      renderMemes(await host.call("getMemes"));
      if (task.action === "research-web" && task.resultAvailable) restoreResearch(task);
    }
    finishActivity("后台任务已完成，页面已同步");
  } catch (error) { status.textContent = error.message; finishActivity(error.message, "error"); }
  finally { endAction(action); }
}

function restoreResearch(task) {
  if (state.memeDirty) {
    retainTaskResult(task.id);
    $("memeStatus").textContent = "查证已完成；当前有未保存修改，未覆盖正文。"; return;
  }
  const existing = state.memeSnapshot.entries.find(entry => entry.name === task.result?.query);
  if (existing) fillMemeForm(existing); else clearMemeForm();
  applyMemeResearch(task.result);
}
