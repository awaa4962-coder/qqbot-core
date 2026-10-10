import { apiHasDrafts, applyApiPreset, applyGlobalReasoningPreset, canDiscardApiDrafts, renderApiProviders, selectApiProvider, syncApiControls, syncGlobalReasoningState, updateApiRouteReasoningAvailability } from "./pages/api.js";
import { applyCapabilityFilter } from "./pages/capabilities.js";
import { mcpHasDrafts, canDiscardMcpDrafts } from "./pages/mcp.js";
import { toolSettingsHasDrafts, canDiscardToolSettingsDrafts } from "./pages/tool-settings.js";
import { commitListEditor, removeListEditorValue, renderConfigEditor, renderListEditors, setConfigDirty, syncConfigControls, updateConfigDirty } from "./pages/configuration.js";
import { applyLogFilter } from "./pages/logs.js";
import { filterMemeArchive, showMemeArchiveEntry } from "./pages/memes.js";
import { markStatusStale, renderSnapshot, renderStatus } from "./pages/overview.js";
import { canDiscardStickerDrafts, disposeStickerPreviews, renderStickers, stickerHasDrafts, updateStickerDirty } from "./pages/stickers.js";
import { configureRuntimeUi, runAction, showActionError } from "./ui/actions.js";
import { beginAction, endAction, groupIsBusy, toast } from "./ui/activity.js";
import { applyBackground, applyUiPreferences, saveUiPreferences } from "./ui/appearance.js";
import { $ } from "./ui/dom.js";
import { CONFIG_FIELDS, PAGE_META } from "./ui/metadata.js";
import { host, uiState } from "./ui/state.js";
import { initializeManagedTaskPanel, resumeManagedTasks } from "./ui/tasks.js";
import { installTaskFeedback } from "./ui/background-feedback.js";

installTaskFeedback();
initializeManagedTaskPanel();

let memoryController;
let memoryModule;
if (host.mode === "browser") $("memoryNav").hidden = false;

async function openMemory() {
  try {
    memoryModule ||= import("./memory.js");
    const { initializeMemory } = await memoryModule;
    memoryController ||= initializeMemory(host);
  } catch (error) {
    memoryModule = null;
    $("memoryNotice").textContent = error.message || "记忆页面加载失败，请重新进入。";
    $("memoryNotice").dataset.error = "true";
  }
}

export function canLeaveCurrentView(nextView) {
  if (nextView === uiState.currentView) return true;
  if (uiState.currentView === "memory" && memoryController && !memoryController.canLeave()) return false;
  if (uiState.currentView === "capabilities" && (!canDiscardMcpDrafts() || !canDiscardToolSettingsDrafts())) return false;
  if (host.mode === "browser" && uiState.currentView === "stickers" && stickerHasDrafts() &&
      !window.confirm("表情有未保存修改。仍然离开吗？草稿会留在本页，尚未保存。")) return false;
  if (["configuration", "api-center"].includes(uiState.currentView) && groupIsBusy(uiState.currentView === "configuration" ? "saveConfig" : "saveApiProvider")) {
    toast("正在提交或读取配置，请等待结果后再离开。", "error");
    return false;
  }
  if (uiState.currentView === "configuration" && uiState.configDirty) {
    const leave = window.confirm("配置有未保存修改。确定离开并放弃这些修改吗？");
    if (leave) {
      const blocked = uiState.configBlocked;
      renderConfigEditor(uiState.lastConfigSnapshot, { force: true });
      if (blocked) { uiState.configBlocked = true; uiState.configLoaded = false; syncConfigControls(); }
    }
    return leave;
  }
  if (uiState.currentView === "api-center" && apiHasDrafts()) {
    if (!canDiscardApiDrafts()) return false;
    const blocked = uiState.apiBlocked;
    renderApiProviders(uiState.apiSnapshot, { force: true });
    if (blocked) { uiState.apiBlocked = true; uiState.apiProvidersLoaded = false; syncApiControls(); }
  }
  return true;
}

export function showView(view) {
  if (!PAGE_META[view]) return;
  if (view === "memory" && host.mode !== "browser") return;
  if (!canLeaveCurrentView(view)) return;
  if (uiState.currentView === "stickers" && view !== "stickers") {
    disposeStickerPreviews();
    uiState.stickersLoaded = false;
  }
  uiState.currentView = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll(".view-tab").forEach((button) => {
    const active = button.dataset.view === view || (view === "memes" && button.dataset.view === "maintenance");
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
  if (view === "configuration" && !uiState.configLoaded) runAction("refreshConfig", null, { silent: true });
  if (view === "logs" && !uiState.logsLoaded) runAction("refreshLogs", null, { silent: true });
  if (view === "memory") openMemory();
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
  const stickerTile = event.target.closest("[data-sticker-id]");
  if (stickerTile) {
    if (!canDiscardStickerDrafts({ section: "entry" })) return;
    uiState.selectedStickerId = stickerTile.dataset.stickerId;
    renderStickers(uiState.stickerSnapshot, { selectId: uiState.selectedStickerId, force: true, section: "entry" });
    return;
  }
  const apiProvider = event.target.closest("[data-api-provider]");
  if (apiProvider) {
    selectApiProvider(apiProvider.dataset.apiProvider);
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
  if (event.target?.id?.startsWith("sticker")) updateStickerDirty();
  if (event.target && event.target.id === "logFilter") applyLogFilter();
  if (event.target && event.target.id === "capabilitySearch") applyCapabilityFilter();
  if (event.target && event.target.id === "blurStrength") {
    document.documentElement.style.setProperty("--backdrop-blur", `${event.target.value}px`);
  }
  if (event.target?.id === "memeArchiveSearch") filterMemeArchive();
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
    if (!canDiscardStickerDrafts({ section: "entry" })) {
      event.target.value = uiState.stickerFilter;
      return;
    }
    uiState.stickerFilter = event.target.value;
    uiState.selectedStickerId = "";
    renderStickers(uiState.stickerSnapshot, { force: true, section: "entry" });
    return;
  }
  if (event.target.id.startsWith("sticker")) updateStickerDirty();
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
    showMemeArchiveEntry();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, event.target.id)) updateConfigDirty();
});

document.addEventListener("DOMContentLoaded", async () => {
  applyUiPreferences();
  renderListEditors();
  configureRuntimeUi();
  setConfigDirty(false);
  syncApiControls();
  try {
    await host.call("ready");
    const [background, snapshot] = await Promise.allSettled([
      host.call("getBackground"),
      host.call("refresh"),
    ]);
    if (background.status === "fulfilled") applyBackground(background.value);
    if (snapshot.status !== "fulfilled") throw snapshot.reason;
    renderSnapshot(snapshot.value);
    resumeManagedTasks().catch(() => toast("后台任务状态暂不可读，请稍后刷新", "error"));
  } catch (error) {
    $("subtitle").textContent = "主页已打开，但 Bridge 暂不可用。";
    markStatusStale("首次刷新失败，点总览中的刷新重试");
    toast(error.message || "Bridge 暂不可用", "error");
  }
});

window.addEventListener("beforeunload", event => {
  if (!uiState.configDirty && !apiHasDrafts() && !stickerHasDrafts() && !mcpHasDrafts() && !toolSettingsHasDrafts() && !groupIsBusy("saveConfig") && !groupIsBusy("saveApiProvider") && !groupIsBusy("saveSticker")) return;
  event.preventDefault(); event.returnValue = "";
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
    syncConfigControls();
  }
}

window.setInterval(quietRefresh, 15_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") quietRefresh();
});
