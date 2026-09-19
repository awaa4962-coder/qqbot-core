import { host, state } from "./state.js";
import { $ } from "./dom.js";
import { beginAction, endAction, finishActivity, showActivity } from "./activity.js";
import { ACTION_LABELS } from "./metadata.js";
import { taskPhaseLabel, retainTaskResult } from "./tasks.js";
import { applyMemeResearch, clearMemeForm, fillMemeForm, memeFormFingerprint, renderMemes } from "../pages/memes.js";
import { renderStickers } from "../pages/stickers.js";

const ACTIONS = { "run-web-update": "runMemeWebUpdate", "research-web": "researchMemeWeb", sync: "syncStickers", analyze: "analyzeStickers", capabilities: "refreshStickerCapabilities", cleanup: "cleanupStickerTemp" };
const researchEditors = new Map();

export function installTaskFeedback() {
  window.addEventListener("qqfriend:task", event => {
    handle(event.detail).catch(() => finishActivity("读取任务结果失败，请刷新对应页面", "error"));
  });
}

async function handle({ type, task }) {
  const action = ACTIONS[task.action];
  if (!action) return;
  const status = $(task.module === "memes" ? "memeStatus" : "stickerStatus");
  if (type === "started") {
    beginAction(action, null, true);
    if (task.action === "research-web") researchEditors.set(task.id, memeFormFingerprint());
  }
  if (type === "started" || type === "progress") {
    status.textContent = taskPhaseLabel(task.phase);
    showActivity(ACTION_LABELS[action], "working", taskPhaseLabel(task.phase)); return;
  }
  try {
    if (task.taskStateUnknown) {
      status.textContent = task.error;
      finishActivity("任务结果尚未确认", "error", task.error);
      return;
    }
    if (type === "error" || task.phase !== "done") throw new Error(task.error || taskPhaseLabel(task.phase));
    if (task.module === "stickers") renderStickers(await host.call("getStickers"));
    if (task.module === "memes") {
      const snapshot = await host.call("getMemes");
      const unchanged = researchEditors.get(task.id) === memeFormFingerprint();
      renderMemes(snapshot);
      if (task.action === "research-web") {
        if (task.resultAvailable) restoreResearch(task, unchanged);
        else status.textContent = "查证已完成，但结果缓存已过期；未回填正文。";
        finishActivity("查证任务已完成", "success", status.textContent);
        return;
      }
    }
    finishActivity("后台任务已完成，页面已同步");
  } catch (error) { status.textContent = error.message; finishActivity(error.message, "error"); }
  finally { researchEditors.delete(task.id); endAction(action); }
}

function restoreResearch(task, unchanged) {
  if (state.memeDirty || !unchanged) {
    retainTaskResult(task.id);
    $("memeStatus").textContent = "查证已完成；当前编辑已变化，未覆盖正文。"; return;
  }
  if (!task.result?.ok || !task.result.entry) throw new Error("查证结果不可用，未回填正文");
  const existing = state.memeSnapshot.entries.find(entry => entry.name === task.result?.query);
  if (existing) fillMemeForm(existing); else clearMemeForm();
  applyMemeResearch(task.result);
}
