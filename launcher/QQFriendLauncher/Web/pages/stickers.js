import { $, escapeHtml, fmt, splitList } from "../ui/dom.js";
import { groupIsBusy } from "../ui/activity.js";
import { host, uiState } from "../ui/state.js";

const settingsValueIds = ["stickerChance", "stickerStrongChance", "stickerCooldown", "stickerGroups",
  "stickerCaptureDailyLimit", "stickerCaptureCatalogLimit", "stickerCaptureConfidence", "stickerCaptureSenders"];
const settingsCheckIds = ["stickerGroupEnabled", "stickerPrivateEnabled"];
const entryValueIds = ["stickerId", "stickerDescription", "stickerTags", "stickerAllowedGroups"];
const entryCheckIds = ["stickerEntryEnabled"];
const stickerActions = ["analyzeStickers", "syncStickers", "setStickerCaptureMode", "saveStickerSettings",
  "setStickerMode", "saveSticker", "removeCapturedSticker", "simulateSticker", "refreshStickerCapabilities", "cleanupStickerTemp"];
let settingsBaseline = null;
let entryBaseline = null;
let settingsExpected = null;
let entryExpected = null;
let entryId = "";
let settingsModes = {};
let readReady = false;
let blockedReason = "";
let selectionLost = false;
let accessDenied = false;

const previewSessions = new Map();
window.addEventListener("pagehide", disposeStickerPreviews);

export function validStickerSettings(settings) {
  return ["steady", "shadow", "off"].includes(settings?.mode) && ["off", "observe", "auto"].includes(settings?.captureMode) &&
    typeof settings.groupEnabled === "boolean" && typeof settings.privateEnabled === "boolean" &&
    ["chance", "strongChance", "captureMinConfidence"].every(key => Number.isFinite(settings[key]) && settings[key] >= 0 && settings[key] <= 1) &&
    [["cooldownMs", 0, 86400000], ["captureDailyLimit", 0, 200], ["captureCatalogLimit", 1, 2000], ["captureMinDistinctSenders", 1, 20]]
      .every(([key, min, max]) => Number.isSafeInteger(settings[key]) && settings[key] >= min && settings[key] <= max) &&
    Array.isArray(settings.allowedGroups) && settings.allowedGroups.every(group => Number.isSafeInteger(group) && group > 0);
}

function formFingerprint(valueIds, checkIds) {
  return JSON.stringify([valueIds.map(id => String($(id)?.value ?? "")), checkIds.map(id => Boolean($(id)?.checked))]);
}

function copyExpected(value) {
  return JSON.parse(JSON.stringify(value));
}

function stickerDrafts() {
  return {
    settings: host.mode === "browser" && settingsBaseline !== null && formFingerprint(settingsValueIds, settingsCheckIds) !== settingsBaseline,
    entry: host.mode === "browser" && entryBaseline !== null && formFingerprint(entryValueIds, entryCheckIds) !== entryBaseline,
  };
}

export function stickerHasDrafts() {
  const drafts = stickerDrafts();
  return drafts.settings || drafts.entry;
}

export function canDiscardStickerDrafts({ section } = {}) {
  const drafts = stickerDrafts();
  const dirty = section === "settings" ? drafts.settings : section === "entry" ? drafts.entry : drafts.settings || drafts.entry;
  return !dirty || window.confirm("表情有未保存修改。确定放弃这些修改吗？");
}

function stickerReadIsWritable() {
  return readReady && uiState.stickersLoaded && !blockedReason && !selectionLost && uiState.stickerSnapshot?.available !== false &&
    (entryBaseline === null || $("stickerId")?.value === entryId && uiState.selectedStickerId === entryId);
}

export function canWriteStickers(action) {
  if (host.mode !== "browser") return uiState.stickerSnapshot?.available !== false;
  if (!stickerReadIsWritable() || groupIsBusy("saveSticker")) return false;
  return !["saveSticker", "removeCapturedSticker", "update", "remove"].includes(action) || Boolean(entryId &&
    uiState.stickerSnapshot.entries.some(entry => entry.id === entryId));
}

function renderStickerDraftState() {
  const drafts = stickerDrafts();
  const node = $("stickerDraftState");
  if (node && host.mode === "browser") {
    const sections = [drafts.settings ? "设置未保存" : "", drafts.entry ? "表情未保存" : ""].filter(Boolean);
    node.textContent = selectionLost
      ? "当前表情已移除或选择不匹配；草稿已保留，请明确重新读取。"
      : blockedReason
        ? `状态未确认：${blockedReason}；草稿已保留，请重新读取。`
        : !readReady || !uiState.stickersLoaded
          ? "表情目录尚未读取，暂不能修改。"
          : [...sections, groupIsBusy("saveSticker") ? "正在处理，暂不能修改" : ""].filter(Boolean).join(" · ") || "已读取";
    node.dataset.state = selectionLost || blockedReason ? "error" : !readReady || !uiState.stickersLoaded || groupIsBusy("saveSticker")
      ? "loading" : sections.length ? "dirty" : "ready";
  }
  return drafts;
}

export function updateStickerDirty() {
  syncStickerControls();
  return stickerDrafts();
}

export function stickerReadFailed(error) {
  if (host.mode !== "browser") return;
  readReady = false;
  blockedReason = error?.message || "读取失败或写入结果未确认";
  uiState.stickersLoaded = false;
  if ([401, 403].includes(error?.status)) {
    accessDenied = true;
    renderUnavailableStickerCatalog();
  }
  syncStickerControls();
}

export function syncStickerControls() {
  if (host.mode !== "browser") return;
  if (entryBaseline !== null && ($("stickerId")?.value !== entryId || uiState.selectedStickerId !== entryId)) selectionLost = true;
  const locked = !canWriteStickers();
  for (const id of [...settingsValueIds, ...settingsCheckIds, ...entryValueIds, ...entryCheckIds,
    "stickerSimGroup", "stickerSimUser", "stickerSimAssistant", "stickerFilter"]) {
    const node = $(id);
    if (node) node.disabled = locked;
  }
  for (const action of stickerActions) {
    document.querySelectorAll(`[data-action='${action}']`).forEach(node => { node.disabled = !canWriteStickers(action); });
  }
  document.querySelectorAll("[data-sticker-id]").forEach(node => { node.disabled = locked; });
  renderStickerDraftState();
}

export function disposeStickerPreviews() {
  for (const session of previewSessions.values()) session.dispose();
  previewSessions.clear();
}

const STICKER_REPLY_STAGE_LABELS = Object.freeze({"skipped":"跳过","selected":"已选中","shadow":"影子","cancelled":"取消","knownfailed":"已知失败","unknown":"结果未知","partial":"部分已发","sent":"已确认发送"});
const STICKER_REPLY_REASON_LABELS = Object.freeze({"unknown_reason":"未知原因","sticker_off":"表情功能已关闭","mode_off":"表情模式已关闭","catalog_unavailable":"表情目录暂不可读","no_text_reply":"没有文字回复","serious_context":"严肃或系统场景","private_disabled":"私聊表情已关闭","group_disabled":"群聊表情已关闭","group_not_allowed":"群不在表情白名单","cooldown":"冷却中","chance_miss":"概率未命中","no_candidates":"没有可靠候选","no_match":"没有可靠匹配","model_no_match":"模型没有可靠匹配","selected":"已选中表情","shadow":"影子模式，仅选择未发送","shadow_mode":"已切换影子模式","sent":"发送已确认","send_failed":"发送明确失败","send_unknown":"发送结果未确认","send_partial":"部分发送已确认","send_cancelled":"发送已取消","invalid_sticker":"表情发送材料无效","sticker_unavailable":"当前表情不可发送","sticker_changed":"表情内容或发送材料已改变","policy_changed":"表情准入已改变","policy_guard_unavailable":"发送准入检查未接好","selection_failed":"选择步骤失败","reply_failed":"后置表情步骤失败","privacy_changed":"资料已更新，旧任务已停止","task_cancelled":"任务已取消","permission_changed":"权限已改变","preferences_changed":"偏好已改变","memory_expired":"资料已过期","memory_unavailable":"资料暂不可用","reply_superseded":"回复已被替换","reply_expired":"回复已过期","reply_capacity":"回复容量限制","bridge_stopping":"桥接服务正在停止","reply_duplicate":"重复回复已拦截","delivery_state_unavailable":"投递状态暂不可确认","recipient_mismatch":"发送目标不匹配","no_reply":"没有文字回复","chance_missed":"概率未命中","chance_disabled":"发送概率已关闭","chance_selected":"概率已命中","eligible":"满足发送条件","entry_group_only":"这张表情仅限群聊","selection_none":"选图未匹配","selection_invalid":"选图结果格式无效","selection_selected":"选图已匹配"});

function stickerReplyCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "未统计";
}

function stickerReplyReasonLabel(value) {
  return typeof value === "string" && Object.hasOwn(STICKER_REPLY_REASON_LABELS, value)
    ? STICKER_REPLY_REASON_LABELS[value] : "未知原因";
}

export function stickerReplyStatusText(snapshot = {}) {
  const status = snapshot.replyStatus;
  const last = status?.last;
  const stage = typeof last?.stage === "string" && Object.hasOwn(STICKER_REPLY_STAGE_LABELS, last.stage)
    ? STICKER_REPLY_STAGE_LABELS[last.stage] : "未知阶段";
  const receipts = { sent: "已确认发送", partial: "部分发送已确认", unknown: "投递未确认", none: "未发生发送" };
  const receipt = typeof last?.physicalReceipt === "string" && Object.hasOwn(receipts, last.physicalReceipt)
    ? receipts[last.physicalReceipt] : "";
  return [
    last ? `最近后置表情：${stage} · ${stickerReplyReasonLabel(last.reasonCode)}${receipt ? " · " + receipt : ""}` : "最近后置表情：未统计",
    `本进程：跳过 ${stickerReplyCount(status?.counts?.skipped)} · 已选 ${stickerReplyCount(status?.counts?.selected)} · 影子 ${stickerReplyCount(status?.counts?.shadow)} · 取消 ${stickerReplyCount(status?.counts?.cancelled)}`,
    `投递：已知失败 ${stickerReplyCount(status?.counts?.knownfailed)} · 结果未知 ${stickerReplyCount(status?.counts?.unknown)} · 部分已发 ${stickerReplyCount(status?.counts?.partial)} · 已发 ${stickerReplyCount(status?.counts?.sent)}`,
  ].join("\n");
}

export function renderStickers(snapshot, options = {}) {
  const browser = host.mode === "browser";
  const forceReload = options.force === true && !options.section;
  if (browser && accessDenied && !forceReload) return updateStickerDirty();
  if (browser && snapshot?.available !== false && (!snapshot || snapshot.ok === false || !Array.isArray(snapshot.entries) ||
      !validStickerSettings(snapshot.settings) ||
      snapshot.entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id) ||
      new Set(snapshot.entries.map(entry => entry.id)).size !== snapshot.entries.length)) {
    const error = new Error("表情目录响应不完整");
    stickerReadFailed(error);
    throw error;
  }
  const drafts = stickerDrafts();
  if (!browser || snapshot?.available === false) setStickerCatalogAvailability(snapshot?.available !== false);
  if (snapshot?.available === false) { renderUnavailableStickerCatalog(); return updateStickerDirty(); }
  // Only a full, authoritative reload releases a failed-read/write or lost-target block.
  if (browser && forceReload) {
    blockedReason = "";
    selectionLost = false;
    readReady = true;
    accessDenied = false;
  } else if (browser && !blockedReason) readReady = true;
  const requestedId = options.selectId || uiState.selectedStickerId;
  const confirmedEntry = options.confirmed === "entry" && (!options.selectId || options.selectId === entryId);
  const replaceEntry = !browser || forceReload || !blockedReason && !selectionLost &&
    (confirmedEntry || options.discard === "entry" || options.force === true && options.section === "entry");
  if (browser && !replaceEntry && entryId && (!snapshot.entries.some(entry => entry.id === entryId) ||
      drafts.entry && requestedId !== entryId || options.confirmed === "entry" && !confirmedEntry)) selectionLost = true;
  const preserveEntry = browser && !replaceEntry && (drafts.entry || selectionLost || options.confirmed === "settings");
  const preserveSettings = browser && !forceReload && (options.confirmed === "entry" ||
    options.force === true && options.section === "entry" || options.discard === "entry" ||
    drafts.settings && (options.confirmed !== "settings" || blockedReason));
  uiState.stickerSnapshot = snapshot || { entries: [], settings: {}, counts: {}, stats: {} };
  const allEntries = Array.isArray(uiState.stickerSnapshot.entries) ? uiState.stickerSnapshot.entries : [];
  const counts = uiState.stickerSnapshot.counts || {};
  const settings = uiState.stickerSnapshot.settings || {};
  uiState.stickerFilter = $("stickerFilter")?.value || uiState.stickerFilter;
  const entries = filterStickerEntries(allEntries, uiState.stickerFilter);
  uiState.selectedStickerId = preserveEntry ? entryId : entries.some((entry) => entry.id === requestedId)
    ? requestedId
    : entries[0]?.id || "";
  document.querySelector(".sticker-workbench")?.classList.toggle("empty", !uiState.selectedStickerId);
  $("stickerDetailPanel").hidden = !uiState.selectedStickerId;

  $("stickerNavCount").textContent = String(counts.sendable ?? entries.filter((entry) => entry.sendable).length);
  $("stickerListCount").textContent = entries.length === allEntries.length
    ? `${entries.length} 张`
    : `${entries.length} / ${allEntries.length} 张`;
  $("stickerSummary").innerHTML = [
    ["目录记录", counts.total || 0],
    ["可发送", counts.sendable || 0],
    ["候选", counts.candidates || 0],
    ["已发送", uiState.stickerSnapshot.stats?.sent || 0],
  ].map(([label, value]) => `<div><span>${label}</span><b>${fmt.format(value)}</b></div>`).join("");

  if (!preserveSettings) fillStickerSettings(settings);
  $("stickerGrid").innerHTML = entries.length
    ? entries.map((entry) => `
      <button type="button" class="sticker-tile${entry.id === uiState.selectedStickerId ? " active" : ""}${entry.enabled ? "" : " disabled"}" data-sticker-id="${escapeHtml(entry.id)}" title="${escapeHtml(entry.description || "待分析")}">
        <span class="sticker-tile-media">${stickerImageMarkup(entry, "")}</span>
        <span class="sticker-tile-label">${entry.indexed ? escapeHtml(entry.tags?.[0] || "已分析") : "待分析"}</span>
      </button>`).join("")
    : '<div class="empty-state"><b>还没有同步收藏表情</b><span>点右上角“同步收藏”。</span></div>';
  bindStickerImageFallbacks($("stickerGrid"));

  if (!preserveEntry) writeStickerDetail(entries.find((entry) => entry.id === uiState.selectedStickerId));
  else renderStickerDetailPreview(readReady ? allEntries.find(entry => entry.id === entryId) : undefined);
  const syncLabel = uiState.stickerSnapshot.sync?.syncing
    ? "正在同步"
    : uiState.stickerSnapshot.sync?.lastSyncAt
      ? new Date(uiState.stickerSnapshot.sync.lastSyncAt).toLocaleString("zh-CN")
      : "尚未同步";
  $("stickerStatus").textContent = [
    `模式：${stickerModeLabel(settings.mode)}`,
    `同步：${syncLabel}`,
    `发送成功 ${stickerReplyCount(uiState.stickerSnapshot.stats?.sent)} · 失败 ${stickerReplyCount(uiState.stickerSnapshot.stats?.sendFailures)}`,
    stickerReplyStatusText(uiState.stickerSnapshot),
    uiState.stickerSnapshot.sync?.lastError ? `最近同步问题：${stickerReplyReasonLabel(uiState.stickerSnapshot.sync.lastError)}` : "图片文件不会保存到本地",
  ].join("\n");
  renderStickerCaptureStatus(uiState.stickerSnapshot);
  uiState.stickersLoaded = !browser || readReady && !blockedReason;
  return updateStickerDirty();
}

export function setStickerCatalogAvailability(available = uiState.stickerSnapshot?.available !== false) {
  if (host.mode === "browser") {
    if (!available) stickerReadFailed(new Error("表情目录暂不可读"));
    else syncStickerControls();
    return;
  }
  const actions = ["analyzeStickers", "syncStickers", "setStickerCaptureMode", "saveStickerSettings", "setStickerMode", "saveSticker", "removeCapturedSticker", "simulateSticker"];
  for (const action of actions) for (const button of document.querySelectorAll(`[data-action='${action}']`)) {
    if (!available) {
      if (button.dataset.stickerUnavailable === undefined) button.dataset.stickerUnavailable = String(button.disabled);
      button.disabled = true;
    } else if (button.dataset.stickerUnavailable !== undefined) {
      button.disabled = button.dataset.stickerUnavailable === "true";
      delete button.dataset.stickerUnavailable;
    }
  }
}

function renderUnavailableStickerCatalog() {
  disposeStickerPreviews();
  uiState.stickerSnapshot = { available: false, entries: [], settings: {}, counts: {}, stats: {} };
  const browser = host.mode === "browser";
  uiState.selectedStickerId = browser ? entryId : "";
  uiState.stickersLoaded = !browser;
  $("stickerDetailPanel").hidden = !browser || !entryId;
  if (browser) {
    $("stickerPreview").textContent = "预览暂不可用";
    $("stickerEntryMeta").textContent = "目录状态未知，请重新读取";
    $("removeCapturedStickerButton").hidden = true;
  }
  $("stickerNavCount").textContent = "?";
  $("stickerListCount").textContent = "未知";
  $("stickerSummary").textContent = "表情目录暂不可读";
  $("stickerGrid").innerHTML = '<div class="empty-state" role="alert"><b>表情目录读取失败</b><span>原文件已保留，写入操作已停止。</span></div>';
  $("stickerStatus").textContent = "表情目录暂不可读；未按空目录处理。";
  $("stickerCaptureCapability").textContent = "目录状态未知";
  $("stickerCaptureStatus").textContent = "目录不可用，采集统计暂不可确认。";
}

export function fillStickerDetail(entry) {
  if (host.mode === "browser" && (stickerDrafts().entry || blockedReason || selectionLost)) {
    if (entry?.id !== entryId) selectionLost = true;
    syncStickerControls();
    return;
  }
  writeStickerDetail(entry);
  if (host.mode === "browser") uiState.selectedStickerId = entryId;
  syncStickerControls();
}

function fillStickerSettings(settings) {
  document.querySelectorAll("[data-action='setStickerMode']").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === settings.mode);
  });
  document.querySelectorAll("[data-action='setStickerCaptureMode']").forEach((button) => {
    button.classList.toggle("active", button.dataset.captureMode === settings.captureMode);
  });
  $("stickerGroupEnabled").checked = settings.groupEnabled !== false;
  $("stickerPrivateEnabled").checked = settings.privateEnabled !== false;
  $("stickerChance").value = Math.round(Number(settings.chance || 0) * 100);
  $("stickerStrongChance").value = Math.round(Number(settings.strongChance || 0) * 100);
  $("stickerCooldown").value = Math.round(Number(settings.cooldownMs || 0) / 60000);
  $("stickerGroups").value = Array.isArray(settings.allowedGroups) ? settings.allowedGroups.join(" ") : "";
  $("stickerCaptureDailyLimit").value = Number(settings.captureDailyLimit ?? 20);
  $("stickerCaptureCatalogLimit").value = Number(settings.captureCatalogLimit ?? 300);
  $("stickerCaptureConfidence").value = Math.round(Number(settings.captureMinConfidence ?? 0.82) * 100);
  $("stickerCaptureSenders").value = Number(settings.captureMinDistinctSenders ?? 2);
  if (host.mode === "browser") {
    settingsModes = { mode: settings.mode, captureMode: settings.captureMode };
    settingsExpected = copyExpected(settings);
    settingsBaseline = formFingerprint(settingsValueIds, settingsCheckIds);
  }
}

function writeStickerDetail(entry) {
  $("stickerId").value = entry?.id || "";
  $("stickerDescription").value = entry?.description || "";
  $("stickerTags").value = Array.isArray(entry?.tags) ? entry.tags.join(" ") : "";
  $("stickerAllowedGroups").value = Array.isArray(entry?.allowedGroups) ? entry.allowedGroups.join(" ") : "";
  $("stickerEntryEnabled").checked = entry?.enabled !== false;
  if (host.mode === "browser") entryId = entry?.id || "";
  renderStickerDetailPreview(entry);
  if (host.mode === "browser") {
    entryExpected = entry ? copyExpected({ id: entry.id, description: entry.description, tags: entry.tags,
      allowedGroups: entry.allowedGroups, enabled: entry.enabled }) : null;
    entryBaseline = formFingerprint(entryValueIds, entryCheckIds);
  }
}

function renderStickerDetailPreview(entry) {
  $("stickerPreview").innerHTML = entry?.id
    ? stickerImageMarkup(entry, "选中的收藏表情", false)
    : host.mode === "browser" && entryId ? "<span>当前表情预览暂不可用，请重新读取</span>" : "<span>选择一张表情</span>";
  bindStickerImageFallbacks($("stickerPreview"));
  $("stickerEntryMeta").textContent = !entry && host.mode === "browser" && entryId
    ? "当前表情不可确认，请重新读取" : stickerEntryMeta(entry);
  $("removeCapturedStickerButton").hidden = entry?.source !== "group-capture";
}

export function stickerSettingsPayload(mode, captureMode) {
  if (host.mode === "browser" && !stickerReadIsWritable()) throw new Error("表情状态未确认，请重新读取后再修改。");
  const modes = host.mode === "browser" ? settingsModes : uiState.stickerSnapshot.settings || {};
  return {
    action: "settings",
    ...(host.mode === "browser" ? { expected: copyExpected(settingsExpected) } : {}),
    settings: {
      mode: mode || modes.mode || "steady",
      groupEnabled: $("stickerGroupEnabled").checked,
      privateEnabled: $("stickerPrivateEnabled").checked,
      chance: Number($("stickerChance").value || 0) / 100,
      strongChance: Number($("stickerStrongChance").value || 0) / 100,
      cooldownMs: Number($("stickerCooldown").value || 0) * 60000,
      allowedGroups: splitList($("stickerGroups").value),
      captureMode: captureMode || modes.captureMode || "observe",
      captureDailyLimit: Number($("stickerCaptureDailyLimit").value || 0),
      captureCatalogLimit: Number($("stickerCaptureCatalogLimit").value || 300),
      captureMinConfidence: Number($("stickerCaptureConfidence").value || 0) / 100,
      captureMinDistinctSenders: Number($("stickerCaptureSenders").value || 2),
    },
  };
}

export function stickerEntryPayload() {
  assertStickerEntryWritable();
  return {
    action: "update",
    id: $("stickerId").value,
    ...(host.mode === "browser" ? { expected: copyExpected(entryExpected) } : {}),
    patch: {
      description: $("stickerDescription").value.trim(),
      tags: splitList($("stickerTags").value),
      allowedGroups: splitList($("stickerAllowedGroups").value),
      enabled: $("stickerEntryEnabled").checked,
    },
  };
}

function assertStickerEntryWritable() {
  if (host.mode === "browser" && (!stickerReadIsWritable() || !entryId || !entryExpected ||
      !uiState.stickerSnapshot.entries.some(entry => entry.id === entryId))) throw new Error("当前表情未确认，请重新读取后再修改。");
}

export function stickerRemovalPayload() {
  assertStickerEntryWritable();
  return { action: "remove", id: $("stickerId").value,
    ...(host.mode === "browser" ? { expected: copyExpected(entryExpected) } : {}) };
}

export function stickerSimulationPayload() {
  if (host.mode === "browser" && !stickerReadIsWritable()) throw new Error("表情状态未确认，请重新读取后再预演。");
  return {
    action: "simulate",
    groupId: Number($("stickerSimGroup").value || 0),
    userMessage: $("stickerSimUser").value.trim(),
    assistantText: $("stickerSimAssistant").value.trim(),
  };
}

export function renderStickerSimulation(result) {
  const decision = result?.result || {};
  if (decision.action !== "send") {
    $("stickerStatus").textContent = `预演结果：不发送\n原因：${decision.reason || "没有可靠匹配"}`;
    return;
  }
  if (host.mode !== "browser") uiState.selectedStickerId = decision.stickerId;
  renderStickers(result.snapshot || uiState.stickerSnapshot, { selectId: host.mode === "browser" && stickerDrafts().entry ? entryId : decision.stickerId });
  $("stickerStatus").textContent = [
    "预演结果：会发送",
    `表情：${decision.sticker?.description || decision.stickerId}`,
    `标签：${(decision.sticker?.tags || []).join("、") || "-"}`,
    "预演不会真的向 QQ 发送消息",
  ].join("\n");
}

export function stickerModeLabel(mode) {
  return ({ steady: "正常发送", shadow: "只观察不发送", off: "关闭" })[mode] || mode || "正常发送";
}

export function filterStickerEntries(entries, filter) {
  if (filter === "sendable") return entries.filter((entry) => entry.sendable === true);
  if (filter === "qq-favorite") return entries.filter((entry) => entry.source === "qq-favorite");
  if (filter === "group-capture") return entries.filter((entry) => entry.source === "group-capture");
  if (filter === "candidate") {
    return entries.filter((entry) =>
      entry.source === "group-capture" &&
      ["candidate", "cloud-failed", "pending-cloud"].includes(entry.captureState));
  }
  return entries;
}

export function stickerImageMarkup(entry, alt, lazy = true) {
  const lazyAttribute = lazy ? ' data-lazy="true"' : "";
  return [
    `<img data-sticker-preview data-state="loading" data-preview-id="${escapeHtml(entry?.id || "")}" data-preview-version="${Number(entry?.lastSeenAt || entry?.analyzedAt || 0)}" data-src="${escapeHtml(stickerPreviewUrl(entry))}" alt="${escapeHtml(alt)}" decoding="async" referrerpolicy="no-referrer"${lazyAttribute}>`,
    '<span class="sticker-image-fallback">加载中</span>',
  ].join("");
}

export function stickerPreviewUrl(entry) {
  const configuredPort = Number(uiState.lastStatus?.config?.listenPort || 16789);
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 16789;
  const version = Number(entry?.lastSeenAt || entry?.analyzedAt || 0);
  const origin = host.mode === "browser" ? "" : `http://127.0.0.1:${port}`;
  return `${origin}/admin/stickers/image?id=${encodeURIComponent(entry?.id || "")}&v=${version}`;
}

export function bindStickerImageFallbacks(root) {
  if (!root) return;
  uiState.stickerImageObservers.get(root)?.disconnect();
  previewSessions.get(root)?.dispose();
  const images = [...root.querySelectorAll("img[data-sticker-preview]")];
  const urls = new Set();
  const queue = [];
  const controller = window.AbortController ? new window.AbortController() : null;
  let disposed = false;
  let active = 0;
  const session = { dispose() {
    disposed = true;
    controller?.abort();
    queue.length = 0;
    uiState.stickerImageObservers.get(root)?.disconnect();
    for (const url of urls) window.URL.revokeObjectURL(url);
    urls.clear();
  } };
  previewSessions.set(root, session);
  const showFallback = image => {
    if (disposed) return;
    image.dataset.state = "failed";
    image.hidden = true;
    const fallback = image.nextElementSibling;
    if (fallback) { fallback.textContent = "预览暂不可用"; fallback.removeAttribute("hidden"); }
  };
  const pump = () => {
    while (!disposed && active < 4 && queue.length) {
      const image = queue.shift();
      active++;
      host.call("getStickerPreview", { id: image.dataset.previewId, version: image.dataset.previewVersion, signal: controller?.signal })
        .then(blob => {
          if (disposed) return;
          const url = window.URL.createObjectURL(blob);
          urls.add(url);
          image.src = url;
        })
        .catch(error => {
          if (disposed) return;
          if ([401, 403].includes(error?.status)) stickerReadFailed(error);
          else showFallback(image);
        })
        .finally(() => { active--; pump(); });
    }
  };
  const loadImage = (image) => {
    if (disposed || image.dataset.requested) return;
    image.dataset.requested = "true";
    if (host.mode !== "browser") { if (image.dataset.src) image.src = image.dataset.src; return; }
    queue.push(image);
    pump();
  };
  images.forEach((image) => {
    const fallback = image.nextElementSibling;
    image.addEventListener("load", () => {
      image.dataset.state = "ready";
      image.hidden = false;
      fallback?.setAttribute("hidden", "");
    }, { once: true });
    image.addEventListener("error", () => showFallback(image), { once: true });
    if (image.dataset.lazy !== "true") loadImage(image);
  });
  const lazyImages = images.filter((image) => image.dataset.lazy === "true");
  if (!lazyImages.length) return;
  if (!("IntersectionObserver" in window)) {
    lazyImages.forEach(loadImage);
    return;
  }
  const observer = new IntersectionObserver((records) => {
    records.filter(record => record.isIntersecting).forEach((record) => {
      observer.unobserve(record.target);
      loadImage(record.target);
    });
  }, {
    root: root.id === "stickerGrid" ? root : null,
    rootMargin: "180px 0px",
  });
  uiState.stickerImageObservers.set(root, observer);
  lazyImages.forEach(image => observer.observe(image));
}

export function stickerEntryMeta(entry) {
  if (!entry) return "选择一张表情查看来源";
  if (entry.source !== "group-capture") return "来源：我的 QQ 收藏 · 控制台不会删除个人收藏";
  const state = ({
    candidate: "候选",
    "pending-cloud": "等待上传",
    active: "已收录到 QQ 云收藏",
    "cloud-failed": "上传失败",
    retired: "已停用",
  })[entry.captureState] || entry.captureState || "候选";
  return [
    `来源：群聊采集 · ${state}`,
    `出现 ${entry.seenCount || 1} 次 · ${entry.distinctSenderCount || 0} 位不同发送者 · 可信度 ${Math.round(Number(entry.confidence || 0) * 100)}%`,
  ].join("\n");
}

export function renderStickerCaptureStatus(snapshot) {
  const capture = snapshot.capture || snapshot.sync?.capture || {};
  const queue = capture.queue || {};
  const quota = capture.quota || {};
  const capabilities = snapshot.capabilities || snapshot.sync?.capabilities || {};
  const version = capabilities.version?.appVersion || "未知版本";
  const cloudReady = capabilities.add && capabilities.detail && capabilities.delete;
  $("stickerCaptureCapability").textContent = cloudReady
    ? `NapCat ${version} · QQ 云收藏可用`
    : `NapCat ${version} · 仅观察，云收藏接口不可用`;
  $("stickerCaptureStatus").textContent = [
    `采集：${captureModeLabel(snapshot.settings?.captureMode)} · 队列 ${queue.queued || 0}/${queue.maxSize || 0}${queue.processing ? "，正在处理" : ""}`,
    `今日已收录 ${quota.todayAdded || 0}/${quota.dailyLimit ?? 0} · 采集库 ${quota.capturedTotal || 0}/${quota.catalogLimit ?? 0}`,
    `观察 ${capture.observed || 0} 张 · 已收录 ${capture.promoted || 0} 张 · 已拒绝 ${capture.rejected || 0} 张`,
    Number.isSafeInteger(capture.classificationReused) && capture.classificationReused >= 0
      ? `本进程分类复用 ${capture.classificationReused} 次` : "分类复用：未统计",
    capture.lastError ? `最近问题：${capture.lastError === "privacy_changed" ? "资料已更新，旧任务已停止" : capture.lastError}` : "发送者关联使用加盐哈希，忘记我可清除；共用云表情不自动删除",
  ].join("\n");
}

export function captureModeLabel(mode) {
  return ({ auto: "自动收录", observe: "只观察", off: "关闭" })[mode] || "只观察";
}
