import { $ } from "./dom.js";
import { ACTION_GROUPS, ACTION_LABELS } from "./metadata.js";
import { uiState } from "./state.js";

export function actionGroup(action) {
  return ACTION_GROUPS[action] || action;
}

export function groupIsBusy(action) {
  const group = actionGroup(action);
  return [...uiState.activeActions.keys()].some((active) => actionGroup(active) === group);
}

export function beginAction(action, button, silent) {
  if (groupIsBusy(action)) {
    if (!silent) toast("同类操作正在执行，请稍等。", "error");
    return false;
  }

  uiState.activeActions.set(action, button || null);
  document.body.setAttribute("aria-busy", String(uiState.activeActions.size > 0));
  if (button) {
    button.dataset.idleText = button.textContent;
    button.textContent = shortWorkingLabel(action);
    button.classList.add("is-loading");
    button.disabled = true;
  }
  if (!silent) showActivity(ACTION_LABELS[action] || "正在处理请求");
  return true;
}

export function endAction(action) {
  const button = uiState.activeActions.get(action);
  if (button) {
    button.textContent = button.dataset.idleText || button.textContent;
    button.classList.remove("is-loading");
    button.disabled = false;
    delete button.dataset.idleText;
  }
  uiState.activeActions.delete(action);
  document.body.setAttribute("aria-busy", String(uiState.activeActions.size > 0));
}

export function shortWorkingLabel(action) {
  return ({
    refresh: "刷新中",
    refreshLogs: "刷新中",
    refreshConfig: "读取中",
    refreshMemes: "刷新中",
    startAll: "启动中",
    health: "检查中",
    restartBridge: "重启中",
    stopBridge: "停止中",
    stopAll: "停止中",
    diagnose: "诊断中",
    createBackup: "备份中",
    saveMeme: "保存中",
    saveConfig: "保存中",
    researchMemeWeb: "查证中",
    runMemeWebUpdate: "更新中",
    rollbackMemeWebUpdate: "回退中",
    restoreMemeHistory: "恢复中",
  })[action] || "处理中";
}

export function showActivity(title, state = "working", detail = "完成后会自动更新当前页面。") {
  const bar = $("activityBar");
  window.clearTimeout(uiState.activityHideTimer);
  bar.classList.remove("success", "error");
  if (state !== "working") bar.classList.add(state);
  bar.classList.add("visible");
  $("activityTitle").textContent = title;
  $("activityDetail").textContent = detail;
}

export function finishActivity(title, state = "success") {
  const detail = state === "success" ? "当前页面已同步。" : "没有完成这次操作，请按页面提示检查。";
  showActivity(title, state, detail);
  uiState.activityHideTimer = window.setTimeout(() => $("activityBar").classList.remove("visible"), 2800);
}

export function toast(message, tone = "success") {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("success", "error");
  node.classList.add(tone, "show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("show"), 2600);
}
