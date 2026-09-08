import { $, escapeHtml, fmt, splitList } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function renderStickers(snapshot, options = {}) {
  uiState.stickerSnapshot = snapshot || { entries: [], settings: {}, counts: {}, stats: {} };
  const allEntries = Array.isArray(uiState.stickerSnapshot.entries) ? uiState.stickerSnapshot.entries : [];
  const counts = uiState.stickerSnapshot.counts || {};
  const settings = uiState.stickerSnapshot.settings || {};
  uiState.stickerFilter = $("stickerFilter")?.value || uiState.stickerFilter;
  const entries = filterStickerEntries(allEntries, uiState.stickerFilter);
  const requestedId = options.selectId || uiState.selectedStickerId;
  uiState.selectedStickerId = entries.some((entry) => entry.id === requestedId)
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
  $("stickerGrid").innerHTML = entries.length
    ? entries.map((entry) => `
      <button type="button" class="sticker-tile${entry.id === uiState.selectedStickerId ? " active" : ""}${entry.enabled ? "" : " disabled"}" data-sticker-id="${escapeHtml(entry.id)}" title="${escapeHtml(entry.description || "待分析")}">
        <span class="sticker-tile-media">${stickerImageMarkup(entry, "")}</span>
        <span class="sticker-tile-label">${entry.indexed ? escapeHtml(entry.tags?.[0] || "已分析") : "待分析"}</span>
      </button>`).join("")
    : '<div class="empty-state"><b>还没有同步收藏表情</b><span>点右上角“同步收藏”。</span></div>';
  bindStickerImageFallbacks($("stickerGrid"));

  fillStickerDetail(entries.find((entry) => entry.id === uiState.selectedStickerId));
  const syncLabel = uiState.stickerSnapshot.sync?.syncing
    ? "正在同步"
    : uiState.stickerSnapshot.sync?.lastSyncAt
      ? new Date(uiState.stickerSnapshot.sync.lastSyncAt).toLocaleString("zh-CN")
      : "尚未同步";
  $("stickerStatus").textContent = [
    `模式：${stickerModeLabel(settings.mode)}`,
    `同步：${syncLabel}`,
    `发送成功 ${uiState.stickerSnapshot.stats?.sent || 0} · 失败 ${uiState.stickerSnapshot.stats?.sendFailures || 0}`,
    uiState.stickerSnapshot.sync?.lastError ? `最近错误：${uiState.stickerSnapshot.sync.lastError}` : "图片文件不会保存到本地",
  ].join("\n");
  renderStickerCaptureStatus(uiState.stickerSnapshot);
  uiState.stickersLoaded = true;
}

export function fillStickerDetail(entry) {
  $("stickerId").value = entry?.id || "";
  $("stickerDescription").value = entry?.description || "";
  $("stickerTags").value = Array.isArray(entry?.tags) ? entry.tags.join(" ") : "";
  $("stickerAllowedGroups").value = Array.isArray(entry?.allowedGroups) ? entry.allowedGroups.join(" ") : "";
  $("stickerEntryEnabled").checked = entry?.enabled !== false;
  $("stickerPreview").innerHTML = entry?.id
    ? stickerImageMarkup(entry, "选中的收藏表情", false)
    : "<span>选择一张表情</span>";
  bindStickerImageFallbacks($("stickerPreview"));
  $("stickerEntryMeta").textContent = stickerEntryMeta(entry);
  $("removeCapturedStickerButton").hidden = entry?.source !== "group-capture";
}

export function stickerSettingsPayload(mode, captureMode) {
  return {
    action: "settings",
    settings: {
      mode: mode || uiState.stickerSnapshot.settings?.mode || "steady",
      groupEnabled: $("stickerGroupEnabled").checked,
      privateEnabled: $("stickerPrivateEnabled").checked,
      chance: Number($("stickerChance").value || 0) / 100,
      strongChance: Number($("stickerStrongChance").value || 0) / 100,
      cooldownMs: Number($("stickerCooldown").value || 0) * 60000,
      allowedGroups: splitList($("stickerGroups").value),
      captureMode: captureMode || uiState.stickerSnapshot.settings?.captureMode || "observe",
      captureDailyLimit: Number($("stickerCaptureDailyLimit").value || 0),
      captureCatalogLimit: Number($("stickerCaptureCatalogLimit").value || 300),
      captureMinConfidence: Number($("stickerCaptureConfidence").value || 0) / 100,
      captureMinDistinctSenders: Number($("stickerCaptureSenders").value || 2),
    },
  };
}

export function stickerEntryPayload() {
  return {
    action: "update",
    id: $("stickerId").value,
    patch: {
      description: $("stickerDescription").value.trim(),
      tags: splitList($("stickerTags").value),
      allowedGroups: splitList($("stickerAllowedGroups").value),
      enabled: $("stickerEntryEnabled").checked,
    },
  };
}

export function stickerSimulationPayload() {
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
  uiState.selectedStickerId = decision.stickerId;
  renderStickers(result.snapshot || uiState.stickerSnapshot, { selectId: uiState.selectedStickerId });
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
    `<img data-sticker-preview data-state="loading" data-src="${escapeHtml(stickerPreviewUrl(entry))}" alt="${escapeHtml(alt)}" decoding="async" referrerpolicy="no-referrer"${lazyAttribute}>`,
    '<span class="sticker-image-fallback">加载中</span>',
  ].join("");
}

export function stickerPreviewUrl(entry) {
  const configuredPort = Number(uiState.lastStatus?.config?.listenPort || 16789);
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 16789;
  const version = Number(entry?.lastSeenAt || entry?.analyzedAt || 0);
  return `http://127.0.0.1:${port}/admin/stickers/image?id=${encodeURIComponent(entry?.id || "")}&v=${version}`;
}

export function bindStickerImageFallbacks(root) {
  if (!root) return;
  uiState.stickerImageObservers.get(root)?.disconnect();
  const images = [...root.querySelectorAll("img[data-sticker-preview]")];
  const loadImage = (image) => {
    if (!image.src && image.dataset.src) image.src = image.dataset.src;
  };
  images.forEach((image) => {
    const fallback = image.nextElementSibling;
    image.addEventListener("load", () => {
      image.dataset.state = "ready";
      image.hidden = false;
      fallback?.setAttribute("hidden", "");
    }, { once: true });
    const showFallback = () => {
      image.dataset.state = "failed";
      image.hidden = true;
      if (fallback) {
        fallback.textContent = "预览暂不可用";
        fallback.removeAttribute("hidden");
      }
    };
    image.addEventListener("error", showFallback, { once: true });
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
    capture.lastError ? `最近问题：${capture.lastError}` : "发送者 QQ 只做不可逆哈希去重，图片上传后不留本地文件",
  ].join("\n");
}

export function captureModeLabel(mode) {
  return ({ auto: "自动收录", observe: "只观察", off: "关闭" })[mode] || "只观察";
}
