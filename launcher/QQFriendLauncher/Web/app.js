import { applyApiPreset, applyGlobalReasoningPreset, renderApiProviders, syncGlobalReasoningState, updateApiRouteReasoningAvailability } from "./pages/api.js";
import { applyCapabilityFilter } from "./pages/capabilities.js";
import { commitListEditor, removeListEditorValue, renderConfigEditor, renderListEditors, updateConfigDirty } from "./pages/configuration.js";
import { applyLogFilter } from "./pages/logs.js";
import { confirmDiscardMemeChanges, fillMemeForm, updateMemeDirty, updateMemeScopeInput } from "./pages/memes.js";
import { markStatusStale, renderSnapshot, renderStatus } from "./pages/overview.js";
import { renderStickers } from "./pages/stickers.js";
import { configureRuntimeUi, runAction, showActionError } from "./ui/actions.js";
import { beginAction, endAction, groupIsBusy, toast } from "./ui/activity.js";
import { applyBackground, applyUiPreferences, saveUiPreferences } from "./ui/appearance.js";
import { $ } from "./ui/dom.js";
import { CONFIG_FIELDS, MEME_FIELD_IDS, PAGE_META } from "./ui/metadata.js";
import { host, uiState } from "./ui/state.js";
import { resumeManagedTasks } from "./ui/tasks.js";
import { installTaskFeedback } from "./ui/background-feedback.js";

installTaskFeedback();

export function canLeaveCurrentView(nextView) {
  if (nextView === uiState.currentView) return true;
  if (uiState.currentView === "configuration" && uiState.configDirty) {
    const leave = window.confirm("配置有未保存修改。确定离开并放弃这些修改吗？");
    if (leave) renderConfigEditor(uiState.lastConfigSnapshot, { force: true });
    return leave;
  }
  if (uiState.currentView === "memes" && uiState.memeDirty) {
    const leave = confirmDiscardMemeChanges();
    if (leave) {
      const selected = (uiState.memeSnapshot.entries || []).find((item) => item.name === uiState.lastEntrySelection);
      if (selected) fillMemeForm(selected);
    }
    return leave;
  }
  return true;
}

export function showView(view) {
  if (!PAGE_META[view]) return;
  if (!canLeaveCurrentView(view)) return;
  uiState.currentView = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll(".view-tab").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("pageEyebrow").textContent = PAGE_META[view][0];
  $("pageTitle").textContent = PAGE_META[view][1];
  $("topServiceButton").hidden = view === "services";
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (view === "memes" && !uiState.memesLoaded) runAction("refreshMemes", null, { silent: true });
  if (view === "stickers" && !uiState.stickersLoaded) runAction("refreshStickers", null, { silent: true });
  if (view === "capabilities" && !uiState.capabilitiesLoaded) runAction("refreshCapabilities", null, { silent: true });
  if (view === "api-center" && !uiState.apiProvidersLoaded) runAction("refreshApiProviders", null, { silent: true });
  if (view === "configuration" && !uiState.lastConfigSnapshot.editable) runAction("refreshConfig", null, { silent: true });
  if (view === "logs" && !uiState.logsLoaded) runAction("refreshLogs", null, { silent: true });
}

host.onEvent((message) => {
  if (message.action === "snapshot" && message.ok && message.data) renderSnapshot(message.data);
});

document.addEventListener("click", (event) => {
  const reasoningPreset = event.target.closest("[data-reasoning-preset]");
  if (reasoningPreset) {
    applyGlobalReasoningPreset(reasoningPreset.dataset.reasoningPreset || "auto");
    return;
  }
  const sourceRemove = event.target.closest("[data-remove-meme-source]");
  if (sourceRemove) {
    sourceRemove.closest(".meme-source-row")?.remove();
    updateMemeDirty();
    return;
  }
  const stickerTile = event.target.closest("[data-sticker-id]");
  if (stickerTile) {
    uiState.selectedStickerId = stickerTile.dataset.stickerId;
    renderStickers(uiState.stickerSnapshot, { selectId: uiState.selectedStickerId });
    return;
  }
  const apiProvider = event.target.closest("[data-api-provider]");
  if (apiProvider) {
    uiState.selectedApiProviderId = apiProvider.dataset.apiProvider;
    renderApiProviders(uiState.apiSnapshot, { selectId: uiState.selectedApiProviderId });
    return;
  }
  const listRemove = event.target.closest("[data-list-remove]");
  if (listRemove) {
    removeListEditorValue(listRemove.closest("[data-list-editor-for]"), listRemove.dataset.listRemove);
    return;
  }
  const listAdd = event.target.closest("[data-list-add]");
  if (listAdd) {
    commitListEditor(listAdd.closest("[data-list-editor-for]"));
    return;
  }
  const themeButton = event.target.closest("[data-ui-theme]");
  if (themeButton) {
    saveUiPreferences({ theme: themeButton.dataset.uiTheme });
    return;
  }
  const densityButton = event.target.closest("[data-ui-density]");
  if (densityButton) {
    saveUiPreferences({ density: densityButton.dataset.uiDensity });
    return;
  }
  const logAction = event.target.closest("[data-log-action]");
  if (logAction) {
    uiState.logFollow = !uiState.logFollow;
    logAction.classList.toggle("active", uiState.logFollow);
    logAction.textContent = uiState.logFollow ? "停止跟随" : "跟随最新";
    if (uiState.logFollow) $("logsOutput").scrollTop = $("logsOutput").scrollHeight;
    return;
  }
  const menuToggle = event.target.closest("[data-menu-toggle]");
  if (menuToggle) {
    const menu = $(menuToggle.dataset.menuToggle);
    menu.hidden = !menu.hidden;
    menuToggle.classList.toggle("active", !menu.hidden);
    return;
  }
  const nativePage = event.target.closest("[data-native-page]");
  if (nativePage) {
    if (!canLeaveCurrentView("native")) return;
    host.call("openNativePage", { page: nativePage.dataset.nativePage }).catch((error) => toast(error.message || "高级页面打开失败", "error"));
    return;
  }
  const viewButton = event.target.closest("button[data-view]");
  if (viewButton) {
    showView(viewButton.dataset.view);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button) {
    const menu = button.closest(".action-menu");
    if (menu) menu.hidden = true;
    runAction(button.dataset.action, button);
  }
});

document.addEventListener("keydown", (event) => {
  const input = event.target.closest?.("[data-list-editor-for] input:not([type=hidden])");
  if (!input || event.key !== "Enter") return;
  event.preventDefault();
  commitListEditor(input.closest("[data-list-editor-for]"));
});

document.addEventListener("input", (event) => {
  if (event.target && event.target.id === "logFilter") applyLogFilter();
  if (event.target && event.target.id === "capabilitySearch") applyCapabilityFilter();
  if (event.target && event.target.id === "blurStrength") {
    document.documentElement.style.setProperty("--backdrop-blur", `${event.target.value}px`);
  }
  if (event.target && MEME_FIELD_IDS.includes(event.target.id)) updateMemeDirty();
  if (event.target?.closest?.(".meme-source-list")) updateMemeDirty();
  if (event.target && Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, event.target.id)) updateConfigDirty();
});

document.addEventListener("focusout", (event) => {
  const input = event.target.closest?.("[data-list-editor-for] input:not([type=hidden])");
  if (input && input.value.trim()) commitListEditor(input.closest("[data-list-editor-for]"));
});

document.addEventListener("change", (event) => {
  if (!event.target) return;
  if (event.target.matches("[data-route-primary]")) {
    updateApiRouteReasoningAvailability(event.target.closest("[data-api-task]"));
    syncGlobalReasoningState();
    $("apiRouteOutput").textContent = "插槽尚未保存，点击“应用插槽”后生效";
    return;
  }
  if (event.target.matches("[data-route-reasoning]")) {
    syncGlobalReasoningState();
    $("apiRouteOutput").textContent = "思考强度尚未保存，点击“应用插槽”后生效";
    return;
  }
  if (event.target.id === "stickerFilter") {
    uiState.stickerFilter = event.target.value;
    uiState.selectedStickerId = "";
    renderStickers(uiState.stickerSnapshot);
    return;
  }
  if (event.target.id === "apiPreset") {
    applyApiPreset(event.target.value);
    return;
  }
  if (event.target.id === "capabilityCategory" || event.target.id === "capabilityStatus") {
    applyCapabilityFilter();
    return;
  }
  if (event.target.id === "logLevel" || event.target.id === "logModule") {
    applyLogFilter();
    return;
  }
  if (event.target.id === "diagType") {
    const privateMode = event.target.value === "private";
    $("diagGroupField").hidden = privateMode;
    $("diagText").value = privateMode ? "help" : `@${uiState.lastStatus.config?.botNames?.[0] || "夜星"} help`;
    return;
  }
  if (event.target.id === "blurStrength") {
    saveUiPreferences({ blur: Number(event.target.value) });
    return;
  }
  if (event.target.id === "memeSelect") {
    if (!confirmDiscardMemeChanges()) {
      event.target.value = uiState.lastEntrySelection;
      return;
    }
    uiState.memeSelectionMode = "entry";
    uiState.lastEntrySelection = event.target.value;
    const entry = (uiState.memeSnapshot.entries || []).find((item) => item.name === event.target.value);
    fillMemeForm(entry);
    return;
  }
  if (event.target.id === "memeScopeType") updateMemeScopeInput();
  if (event.target.matches("[data-meme-lock]")) updateMemeDirty();
  if (MEME_FIELD_IDS.includes(event.target.id)) updateMemeDirty();
  if (Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, event.target.id)) updateConfigDirty();
});

document.addEventListener("DOMContentLoaded", async () => {
  applyUiPreferences();
  renderListEditors();
  configureRuntimeUi();
  try {
    await host.call("ready");
    const [background, snapshot] = await Promise.all([
      host.call("getBackground"),
      host.call("refresh"),
    ]);
    applyBackground(background);
    renderSnapshot(snapshot);
    resumeManagedTasks().catch(() => toast("后台任务状态暂不可读，请稍后刷新", "error"));
  } catch (error) {
    $("subtitle").textContent = "主页已打开，但 Bridge 暂不可用。";
    markStatusStale("首次刷新失败，点总览中的刷新重试");
    toast(error.message || "Bridge 暂不可用", "error");
  }
});

export async function quietRefresh() {
  if (groupIsBusy("refreshStatus") || document.visibilityState !== "visible") return;
  if (!beginAction("refreshStatus", null, true)) return;
  try {
    renderStatus(await host.call("refreshStatus"));
  } catch (error) {
    showActionError("refreshStatus", error);
  } finally {
    endAction("refreshStatus");
  }
}

window.setInterval(quietRefresh, 15_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") quietRefresh();
});
