"use strict";

const host = window.QQFriendHost;
const activeActions = new Map();
let activityHideTimer = null;
let currentView = "overview";
let lastStatus = {};
let lastConfigSnapshot = {};
let latestStatusTime = 0;
let logLines = [];
let logsLoaded = false;
let configBaseline = "";
let configDirty = false;
let memesLoaded = false;
let memeSnapshot = { entries: [], candidates: [] };
let memeSelectionMode = "entry";
let memeBaseline = "";
let memeDirty = false;
let lastEntrySelection = "";
let memeEditingOriginalName = "";
let stickersLoaded = false;
let stickerSnapshot = { entries: [], settings: {}, counts: {}, stats: {} };
let selectedStickerId = "";
let stickerFilter = "all";
let logFollow = false;
let lastBridgeOnline = null;
let bridgeIntentionallyStopped = false;
let capabilitiesLoaded = false;
let capabilitySnapshot = { categories: [], capabilities: [] };
let apiProvidersLoaded = false;
let apiSnapshot = { providers: [], presets: [], protocols: [], routes: {}, tasks: [] };
let selectedApiProviderId = "";
let apiEditorMode = "edit";

const UI_PREFS_KEY = "qqfriend-launcher-ui-v2";
const PAGE_META = Object.freeze({
  overview: ["运行中心", "总览"],
  capabilities: ["功能发现", "能力"],
  "api-center": ["模型快拆", "API 中心"],
  services: ["运行控制", "服务"],
  configuration: ["常用设置", "配置"],
  memes: ["内容管理", "梗库"],
  stickers: ["回复素材", "表情"],
  diagnostics: ["排查工具", "诊断"],
  logs: ["运行记录", "日志"],
  maintenance: ["本地管理", "维护与外观"],
});

const ACTION_LABELS = {
  refreshStickerCapabilities: "正在检查 NapCat 表情能力",
  cleanupStickerTemp: "正在清理表情临时文件",
  setStickerCaptureMode: "正在切换群聊采集模式",
  removeCapturedSticker: "正在移除机器人采集的表情",
  refresh: "正在刷新控制台数据",
  refreshLogs: "正在读取最新日志",
  refreshConfig: "正在读取当前配置",
  refreshMemes: "正在刷新梗库",
  refreshStickers: "正在刷新收藏表情",
  syncStickers: "正在同步 QQ 收藏表情",
  analyzeStickers: "正在分析待处理表情",
  saveStickerSettings: "正在保存表情设置",
  setStickerMode: "正在切换表情模式",
  saveSticker: "正在保存表情标签",
  simulateSticker: "正在预演表情选择",
  refreshCapabilities: "正在读取能力目录",
  refreshApiProviders: "正在读取 API 预设和插槽",
  saveApiProvider: "正在保存 API 实例",
  testApiProvider: "正在测试 API 连接",
  deleteApiProvider: "正在删除 API 实例",
  saveApiRoutes: "正在切换功能插槽",
  rollbackApiProviders: "正在回滚 API 配置",
  startAll: "正在启动全部服务",
  health: "正在检查运行状态",
  restartBridge: "正在重启 Bridge",
  stopBridge: "正在停止 Bridge",
  stopAll: "正在停止全部服务",
  diagnose: "正在模拟消息链路",
  createBackup: "正在创建安全备份",
  openLogs: "正在打开日志目录",
  saveMeme: "正在保存词条",
  saveConfig: "正在保存配置",
  enableMeme: "正在启用词条",
  disableMeme: "正在禁用词条",
  activateMeme: "正在恢复词条",
  quarantineMeme: "正在隔离词条",
  setMemeMode: "正在切换梗库模式",
  deleteMeme: "正在删除词条",
  runMemeWebUpdate: "正在联网更新梗库",
  researchMemeWeb: "正在联网查证当前词条",
  rollbackMemeWebUpdate: "正在回退上次联网更新",
  restoreMemeHistory: "正在恢复词条历史版本",
  setBuiltInBackground: "正在切换背景",
  setDesktopBackground: "正在读取桌面壁纸",
  chooseBackgroundImage: "正在选择背景图片",
};

const ACTION_DONE = {
  refreshStickerCapabilities: "NapCat 表情能力已刷新",
  cleanupStickerTemp: "表情临时文件已清理",
  setStickerCaptureMode: "群聊采集模式已切换",
  removeCapturedSticker: "机器人采集表情已移除",
  refresh: "控制台数据已刷新",
  refreshLogs: "日志已刷新",
  refreshConfig: "配置已重新读取",
  refreshMemes: "梗库已刷新",
  refreshStickers: "收藏表情已刷新",
  syncStickers: "收藏表情同步完成",
  analyzeStickers: "待处理表情分析完成",
  saveStickerSettings: "表情设置已保存",
  setStickerMode: "表情模式已切换",
  saveSticker: "表情标签已保存",
  simulateSticker: "表情预演完成",
  refreshCapabilities: "能力状态已刷新",
  refreshApiProviders: "API 状态已刷新",
  saveApiProvider: "API 实例已保存",
  testApiProvider: "API 连接测试完成",
  deleteApiProvider: "API 实例已删除",
  saveApiRoutes: "功能插槽已应用",
  rollbackApiProviders: "API 配置已回滚",
  startAll: "服务启动完成",
  health: "健康检查完成",
  restartBridge: "Bridge 已重启",
  stopBridge: "Bridge 已停止",
  stopAll: "全部服务已停止",
  diagnose: "诊断完成",
  createBackup: "备份创建完成",
  openLogs: "日志目录已打开",
  saveMeme: "词条已保存",
  saveConfig: "配置已保存",
  enableMeme: "词条已启用",
  disableMeme: "词条已禁用",
  activateMeme: "词条已恢复",
  quarantineMeme: "词条已隔离",
  setMemeMode: "梗库模式已切换",
  deleteMeme: "词条已删除",
  runMemeWebUpdate: "联网梗库更新完成",
  researchMemeWeb: "联网查证完成",
  rollbackMemeWebUpdate: "上次联网更新已回退",
  restoreMemeHistory: "词条历史版本已恢复",
  setBuiltInBackground: "已使用内置背景",
  setDesktopBackground: "已使用桌面壁纸",
  chooseBackgroundImage: "背景图片已应用",
};

const ACTION_GROUPS = {
  refreshStickerCapabilities: "stickers",
  cleanupStickerTemp: "stickers",
  setStickerCaptureMode: "stickers",
  removeCapturedSticker: "stickers",
  startAll: "runtime",
  health: "runtime",
  restartBridge: "runtime",
  stopBridge: "runtime",
  stopAll: "runtime",
  refresh: "snapshot",
  refreshStatus: "snapshot",
  refreshLogs: "logs",
  refreshConfig: "config",
  saveConfig: "config",
  refreshMemes: "memes",
  refreshStickers: "stickers",
  syncStickers: "stickers",
  analyzeStickers: "stickers",
  saveStickerSettings: "stickers",
  setStickerMode: "stickers",
  saveSticker: "stickers",
  simulateSticker: "stickers",
  refreshCapabilities: "capabilities",
  refreshApiProviders: "api-providers",
  saveApiProvider: "api-providers",
  testApiProvider: "api-providers",
  deleteApiProvider: "api-providers",
  saveApiRoutes: "api-providers",
  rollbackApiProviders: "api-providers",
  saveMeme: "memes",
  enableMeme: "memes",
  disableMeme: "memes",
  activateMeme: "memes",
  quarantineMeme: "memes",
  setMemeMode: "memes",
  deleteMeme: "memes",
  runMemeWebUpdate: "memes",
  researchMemeWeb: "memes",
  rollbackMemeWebUpdate: "memes",
  restoreMemeHistory: "memes",
};

const MEME_FIELD_IDS = [
  "memeName",
  "memeLevel",
  "memeConfidence",
  "memeEntryStatus",
  "memeScopeType",
  "memeScopeGroups",
  "memeAliases",
  "memeTriggers",
  "memeMeaning",
  "memeUsage",
  "memeExamples",
];

const STICKER_ACTIONS = [
  "refreshStickerCapabilities",
  "cleanupStickerTemp",
  "setStickerCaptureMode",
  "removeCapturedSticker",
  "syncStickers",
  "analyzeStickers",
  "saveStickerSettings",
  "setStickerMode",
  "saveSticker",
  "simulateSticker",
];

const CONFIG_FIELDS = Object.freeze({
  cfgBotNames: "botNames",
  cfgAdminUins: "adminUins",
  cfgGroupWhitelist: "groupWhitelist",
  cfgSummaryGroups: "summaryGroupWhitelist",
  cfgResourceGroups: "resourceGroupWhitelist",
  cfgFeatureGroups: "featureGroupWhitelist",
  cfgLongGroups: "longGroups",
  cfgFriendWhitelist: "friendWhitelist",
  cfgJmUsers: "jmUserWhitelist",
  cfgBotBlacklist: "botBlacklist",
});

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("zh-CN");

function readUiPreferences() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) || "{}");
    return {
      theme: ["auto", "light", "dark"].includes(parsed.theme) ? parsed.theme : "auto",
      density: ["comfortable", "compact"].includes(parsed.density) ? parsed.density : "comfortable",
      blur: Math.min(52, Math.max(12, Number(parsed.blur || 28))),
    };
  } catch {
    return { theme: "auto", density: "comfortable", blur: 28 };
  }
}

function applyUiPreferences(next = readUiPreferences()) {
  document.documentElement.dataset.theme = next.theme;
  document.documentElement.dataset.density = next.density;
  document.documentElement.style.setProperty("--backdrop-blur", `${next.blur}px`);
  if ($("blurStrength")) $("blurStrength").value = String(next.blur);
  document.querySelectorAll("[data-ui-theme]").forEach((button) => button.classList.toggle("active", button.dataset.uiTheme === next.theme));
  document.querySelectorAll("[data-ui-density]").forEach((button) => button.classList.toggle("active", button.dataset.uiDensity === next.density));
}

function saveUiPreferences(changes) {
  const next = { ...readUiPreferences(), ...changes };
  window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
  applyUiPreferences(next);
}

function actionGroup(action) {
  return ACTION_GROUPS[action] || action;
}

function groupIsBusy(action) {
  const group = actionGroup(action);
  return [...activeActions.keys()].some((active) => actionGroup(active) === group);
}

function beginAction(action, button, silent) {
  if (groupIsBusy(action)) {
    if (!silent) toast("同类操作正在执行，请稍等。", "error");
    return false;
  }

  activeActions.set(action, button || null);
  document.body.setAttribute("aria-busy", String(activeActions.size > 0));
  if (button) {
    button.dataset.idleText = button.textContent;
    button.textContent = shortWorkingLabel(action);
    button.classList.add("is-loading");
    button.disabled = true;
  }
  if (!silent) showActivity(ACTION_LABELS[action] || "正在处理请求");
  return true;
}

function endAction(action) {
  const button = activeActions.get(action);
  if (button) {
    button.textContent = button.dataset.idleText || button.textContent;
    button.classList.remove("is-loading");
    button.disabled = false;
    delete button.dataset.idleText;
  }
  activeActions.delete(action);
  document.body.setAttribute("aria-busy", String(activeActions.size > 0));
}

function shortWorkingLabel(action) {
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

function showActivity(title, state = "working", detail = "完成后会自动更新当前页面。") {
  const bar = $("activityBar");
  window.clearTimeout(activityHideTimer);
  bar.classList.remove("success", "error");
  if (state !== "working") bar.classList.add(state);
  bar.classList.add("visible");
  $("activityTitle").textContent = title;
  $("activityDetail").textContent = detail;
}

function finishActivity(title, state = "success") {
  const detail = state === "success" ? "当前页面已同步。" : "没有完成这次操作，请按页面提示检查。";
  showActivity(title, state, detail);
  activityHideTimer = window.setTimeout(() => $("activityBar").classList.remove("visible"), 2800);
}

function toast(message, tone = "success") {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("success", "error");
  node.classList.add(tone, "show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("show"), 2600);
}

function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = number;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value || 0));
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} 天`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)} 分钟`;
  return `${seconds.toFixed(0)} 秒`;
}

function setMetric(id, value, detail, tone = "") {
  const card = $(id).closest(".metric");
  card.classList.remove("ok", "warn", "bad", "stale");
  if (tone) card.classList.add(tone);
  $(id).textContent = value;
  const detailNode = card.querySelector("small");
  if (detailNode) detailNode.textContent = detail;
  card.classList.remove("updated");
  void card.offsetWidth;
  card.classList.add("updated");
}

function renderStatus(status) {
  if (!status || typeof status !== "object") return false;
  const statusTime = Date.parse(status.generatedAt || "") || Date.now();
  if (latestStatusTime && statusTime < latestStatusTime) return false;
  latestStatusTime = statusTime;
  const previousBridgeOnline = lastBridgeOnline;
  lastStatus = status;

  const config = status.config || {};
  const storage = status.storage || {};
  const process = status.process || {};
  const storm = status.storm || {};
  const cognition = status.modules?.cognition || {};
  const ok = status.status === "ok";
  const stopped = !ok && bridgeIntentionallyStopped;
  lastBridgeOnline = ok;
  if (ok) bridgeIntentionallyStopped = false;

  $("sidebarVersion").textContent = text(status.version, "QQFriend");
  $("sidebarStatus").textContent = ok ? "运行正常" : stopped ? "已停止" : "需要检查";
  $("sidebarStatusDetail").textContent = ok ? `PID ${text(process.pid)}` : stopped ? "等待启动" : text(status.status, "Bridge 离线");
  $("sidebarStatusDot").classList.remove("ok", "bad");
  $("sidebarStatusDot").classList.add(ok ? "ok" : "bad");
  $("subtitle").textContent = ok
    ? `Bridge 正常，版本 ${text(status.version)}，管理端口 ${text(config.listenPort)}。`
    : stopped
      ? "Bridge 已停止，需要时点启动全部。"
      : "Bridge 暂不可用，可以先点启动全部或重启 Bridge。";
  $("lastUpdated").classList.remove("error");
  $("lastUpdated").textContent = `刚刚刷新 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

  setMetric("bridgeState", ok ? "在线" : text(status.status, "离线"), `PID ${text(process.pid)}`, ok ? "ok" : "bad");
  setMetric(
    "storageState",
    `${fmt.format(storage.groups || 0)} 群 / ${fmt.format(storage.users || 0)} 人`,
    ok ? "记忆库可读" : "等待 Bridge 恢复",
    ok ? "ok" : "warn",
  );
  setMetric("memoryState", formatBytes(process.rss), `运行 ${formatSeconds(process.uptime)}`, ok ? "ok" : "warn");
  const dropped = Number(storm.eventDropped || 0);
  setMetric("stormState", dropped > 0 ? `丢弃 ${dropped}` : "正常", `队列 ${text(storm.processingCount, 0)}`, dropped > 0 ? "warn" : ok ? "ok" : "warn");
  const activeThreads = Number(cognition.groupThreads || 0) + Number(cognition.privateThreads || 0);
  setMetric(
    "cognitionState",
    activeThreads > 0 ? `${activeThreads} 条线程` : "空闲",
    `群回合 ${Number(cognition.completedTurns || 0)} · 私聊${cognition.privatePersistence ? "会保存" : "不落盘"}`,
    cognition.enabled === false ? "warn" : ok ? "ok" : "warn",
  );

  const notice = $("systemNotice");
  notice.classList.remove("ok", "warn", "bad");
  if (!ok) {
    notice.classList.add("bad");
    notice.innerHTML = stopped
      ? "<strong>Bridge 已停止</strong><span>启动全部后会自动恢复状态。</span>"
      : "<strong>Bridge 当前不可用</strong><span>前往服务页启动或重启，再运行一次健康检查。</span>";
  } else if (dropped > 0) {
    notice.classList.add("warn");
    notice.innerHTML = `<strong>消息保护已介入</strong><span>本轮丢弃 ${fmt.format(dropped)} 个事件，可到日志页查看原因。</span>`;
  } else {
    notice.classList.add("ok");
    notice.innerHTML = "<strong>所有核心服务正常</strong><span>没有需要立即处理的问题。</span>";
  }

  renderConfig(status, lastConfigSnapshot);
  syncRuntimeTransition(previousBridgeOnline, ok, status);
  return true;
}

function renderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (snapshot.config) {
    lastConfigSnapshot = snapshot.config;
    renderConfigEditor(snapshot.config);
  }
  if (snapshot.status) renderStatus(snapshot.status);
  if (snapshot.logs) {
    renderLogs(snapshot.logs);
    logsLoaded = true;
  }
}

function markStatusStale(message) {
  if (bridgeIntentionallyStopped) {
    $("lastUpdated").textContent = "Bridge 已停止";
    $("lastUpdated").classList.remove("error");
    return;
  }
  $("lastUpdated").textContent = message;
  $("lastUpdated").classList.add("error");
  $("sidebarStatus").textContent = "状态过期";
  $("sidebarStatusDetail").textContent = "等待重新连接";
  $("sidebarStatusDot").classList.remove("ok");
  $("sidebarStatusDot").classList.add("bad");
  document.querySelectorAll(".metric").forEach((card) => card.classList.add("stale"));
}

function renderStoppedStatus(generatedAt = new Date().toISOString()) {
  bridgeIntentionallyStopped = true;
  const status = {
    ...lastStatus,
    status: "offline",
    generatedAt,
    process: {
      ...(lastStatus.process || {}),
      pid: null,
      uptime: 0,
      rss: 0,
    },
    storm: {
      ...(lastStatus.storm || {}),
      processingCount: 0,
    },
  };
  renderStatus(status);
  bridgeIntentionallyStopped = true;
  $("lastUpdated").textContent = `已停止 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function syncRuntimeTransition(previousOnline, online, status) {
  if (previousOnline === null || previousOnline === online || groupIsBusy("runtime")) return;
  const process = status.process || {};
  setOutput(
    "serviceOutput",
    online
      ? `Bridge 已恢复在线\n版本：${text(status.version)}\nPID：${text(process.pid)}`
      : "Bridge 已离线\n请运行启动全部或健康检查。",
    true,
  );
}

function applyBackground(state) {
  const root = document.documentElement;
  const mode = state && state.mode ? state.mode : "built-in";
  const uri = state && state.uri ? state.uri : "";
  root.dataset.backgroundMode = mode;
  root.style.setProperty("--custom-bg", uri ? `url("${uri.replaceAll('"', "%22")}")` : "none");
  document.querySelectorAll(".background-actions button").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  const activeAction = mode === "desktop"
    ? "setDesktopBackground"
    : mode === "image"
      ? "chooseBackgroundImage"
      : "setBuiltInBackground";
  const active = document.querySelector(`button[data-action="${activeAction}"]`);
  if (active) {
    active.classList.add("active");
    active.setAttribute("aria-pressed", "true");
  }
}

function renderConfig(status, configSnapshot) {
  const config = status.config || {};
  const modules = status.modules || {};
  const modelKeys = status.modelKeys || {};
  const linkPreview = modules.linkPreview || {};
  const wordcloud = modules.wordcloud || {};
  const memeKnowledge = modules.memeKnowledge || {};
  const cognition = modules.cognition || {};
  const imageContext = modules.imageContext || {};
  const files = configSnapshot.files && typeof configSnapshot.files === "object"
    ? Object.values(configSnapshot.files)
    : [];
  const editableFiles = files.filter((file) => file.status === "editable").length;
  const createOnSaveFiles = files.filter((file) => file.status === "editable-create-on-save").length;

  const rows = [
    ["机器人名称", config.botNames || [], "configuration"],
    ["群白名单", config.groupWhitelist || [], "configuration"],
    ["日报群", config.summaryGroupWhitelist || [], "configuration"],
    ["资源 / JM 群", config.resourceGroupWhitelist || [], "configuration"],
    ["管理员", config.adminUins || [], "configuration"],
    ["功能模块", Object.entries(modules).filter(([, item]) => item && item.enabled).map(([name]) => moduleLabel(name)), "services"],
    ["短期上下文", [
      cognition.enabled === false ? "未启用" : "已启用",
      `${Number(cognition.groupThreads || 0)} 个群线程`,
      `${Number(cognition.privateThreads || 0)} 个私聊线程`,
      cognition.privatePersistence ? "私聊会保存" : "私聊不落盘",
    ], "services"],
    ["链接预览", [linkPreview.enabled ? "已启用" : "已关闭", `成功 ${linkPreview.hits || 0}`, `失败 ${linkPreview.errors || 0}`], "logs"],
    ["群词云", [wordcloud.enabled ? "已启用" : "已关闭", `${Array.isArray(wordcloud.groups) ? wordcloud.groups.length : 0} 个群`, `最多 ${wordcloud.maxMessages || 0} 条消息`], "configuration"],
    ["梗库", [
      memeKnowledge.enabled ? "已启用" : "已关闭",
      memeKnowledge.mode === "shadow" ? "仅人工" : memeKnowledge.mode === "off" ? "已关闭" : "人工 + 联网",
      `${memeKnowledge.entries || 0} 个词条`,
      `${memeKnowledge.webVerified || 0} 个联网查证`,
    ], "memes"],
    ["图片语境", [imageContext.enabled ? "已启用" : "未启用", `${Number(imageContext.entries || 0)} 个表情包指纹`, `${Number(imageContext.hits || 0)} 次复用`, imageContext.storesImages ? "保存图片" : "不存图片"], "services"],
    ["模型服务", Object.entries(modelKeys).filter(([, enabled]) => enabled).map(([name]) => modelLabel(name)), "services"],
    ["配置文件", files.length > 0 ? [`${editableFiles} 个可直接编辑`, `${createOnSaveFiles} 个保存时创建`] : ["等待配置状态"], "maintenance"],
  ];

  $("configList").innerHTML = rows.map(([label, values, target]) => {
    const list = Array.isArray(values) && values.length > 0 ? values : ["-"];
    return `<div class="config-item"><b>${escapeHtml(label)}</b><div class="chips">${list.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div><button type="button" class="row-link" data-view="${target}">管理</button></div>`;
  }).join("");
}

function renderCapabilities(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  capabilitySnapshot = snapshot;
  capabilitiesLoaded = true;
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
  $("capabilityNavCount").textContent = String(capabilities.length);

  const categorySelect = $("capabilityCategory");
  const selected = categorySelect.value || "all";
  categorySelect.innerHTML = [
    '<option value="all">全部分类</option>',
    ...categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.number}. ${item.name}`)}</option>`),
  ].join("");
  categorySelect.value = categories.some((item) => item.id === selected) ? selected : "all";

  const counts = countCapabilityStatuses(capabilities);
  $("capabilitySummary").innerHTML = [
    `<b>${fmt.format(capabilities.length)} 项能力</b>`,
    `<span class="available">${fmt.format(counts.available)} 可用</span>`,
    `<span class="limited">${fmt.format(counts.limited)} 受限</span>`,
    `<span class="unavailable">${fmt.format(counts.unavailable)} 不可用</span>`,
    `<span class="reserved">${fmt.format(counts.reserved)} 预留</span>`,
  ].join("");
  applyCapabilityFilter();
}

function applyCapabilityFilter() {
  const query = ($("capabilitySearch")?.value || "").trim().toLowerCase();
  const category = $("capabilityCategory")?.value || "all";
  const status = $("capabilityStatus")?.value || "all";
  const categoryMap = new Map((capabilitySnapshot.categories || []).map((item) => [item.id, item]));
  const matches = (capabilitySnapshot.capabilities || []).filter((item) => {
    if (category !== "all" && item.category !== category) return false;
    if (status !== "all" && item.status !== status) return false;
    if (!query) return true;
    const haystack = [item.name, item.summary, ...(item.keywords || []), ...(item.examples || [])].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (!matches.length) {
    $("capabilityList").innerHTML = '<div class="empty-state"><b>没有匹配的能力</b><span>换个关键词或清除筛选后再试。</span></div>';
    return;
  }
  $("capabilityList").innerHTML = matches.map((item) => {
    const meta = categoryMap.get(item.category) || {};
    const scope = (item.scopes || []).map(capabilityScopeLabel).join(" · ");
    const examples = (item.examples || []).map((example) => `<code>${escapeHtml(example)}</code>`).join("");
    return [
      `<article class="capability-row" data-status="${escapeHtml(item.status)}">`,
      '<div class="capability-index">',
      `<span>${escapeHtml(String(meta.number || "-"))}</span>`,
      `<small>${escapeHtml(meta.name || item.category)}</small>`,
      "</div>",
      '<div class="capability-copy">',
      `<div class="capability-title"><h3>${escapeHtml(item.name)}</h3><span class="capability-badge">${escapeHtml(item.statusLabel)}</span></div>`,
      `<p>${escapeHtml(item.summary)}</p>`,
      `<small>${escapeHtml(scope)} · ${escapeHtml(item.statusDetail)}</small>`,
      examples ? `<div class="capability-examples">${examples}</div>` : "",
      "</div>",
      "</article>",
    ].join("");
  }).join("");
}

function countCapabilityStatuses(capabilities) {
  return capabilities.reduce((counts, item) => {
    const key = Object.prototype.hasOwnProperty.call(counts, item.status) ? item.status : "unavailable";
    counts[key] += 1;
    return counts;
  }, { available: 0, limited: 0, unavailable: 0, reserved: 0 });
}

function capabilityScopeLabel(scope) {
  return ({ group: "群聊", private: "私聊", console: "控制台" })[scope] || scope;
}

function renderApiProviders(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return;
  apiSnapshot = snapshot;
  apiProvidersLoaded = true;
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const presets = Array.isArray(snapshot.presets) ? snapshot.presets : [];
  const protocols = Array.isArray(snapshot.protocols) ? snapshot.protocols : [];
  const requestedId = options.selectId || selectedApiProviderId;
  selectedApiProviderId = providers.some(item => item.id === requestedId)
    ? requestedId
    : providers[0]?.id || "";

  $("apiNavCount").textContent = String(providers.length);
  $("apiProviderCount").textContent = String(providers.length);
  $("apiKeyCount").textContent = String(providers.filter(item => item.keyConfigured).length);
  $("apiPresetCount").textContent = String(presets.length);
  $("apiGroupRoute").textContent = formatApiRoute(snapshot.routes?.group_chat);
  $("apiSummary").dataset.ready = "true";

  $("apiPreset").innerHTML = presets.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
  ).join("");
  $("apiProtocol").innerHTML = protocols.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
  ).join("");

  $("apiProviderList").innerHTML = providers.map(item => {
    const active = item.id === selectedApiProviderId;
    const status = item.keyConfigured ? "已配置" : "缺少 Key";
    return [
      `<button type="button" class="provider-card${active ? " active" : ""}" data-api-provider="${escapeHtml(item.id)}">`,
      `<span class="provider-card-title"><b>${escapeHtml(item.name)}</b><i class="${item.keyConfigured ? "ok" : "warn"}">${status}</i></span>`,
      `<small>${escapeHtml(item.model || "未填写模型")}</small>`,
      `<em>${escapeHtml(protocolLabel(item.protocol))}</em>`,
      "</button>",
    ].join("");
  }).join("") || '<div class="empty-state"><b>还没有 API</b><span>点“新增”创建第一个实例。</span></div>';

  renderApiRouteList(snapshot);
  fillApiProviderForm(providers.find(item => item.id === selectedApiProviderId));
}

function renderApiRouteList(snapshot) {
  const providers = (snapshot.providers || []).filter(item => item.enabled !== false);
  const options = providers.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.model || "未选模型")}</option>`
  ).join("");
  const reasoningOptions = (snapshot.reasoningModes || [
    { id: "economy", name: "省额度" },
    { id: "auto", name: "智能" },
    { id: "deep", name: "深度" },
  ]).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  $("apiRouteList").innerHTML = (snapshot.tasks || []).map(task => {
    const fallbackProtected = task.protectedFallback === "deepseek";
    return [
      `<article class="api-route-row" data-api-task="${escapeHtml(task.id)}">`,
      `<div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.id)}</small></div>`,
      `<label>主力<select data-route-primary>${options}</select></label>`,
      `<span class="route-arrow">→</span>`,
      `<label>兜底<select data-route-fallback${fallbackProtected ? " disabled" : ""}><option value="">无</option>${options}</select></label>`,
      `<label class="route-reasoning">思考<select data-route-reasoning>${reasoningOptions}</select></label>`,
      fallbackProtected ? '<span class="route-lock">固定 DS</span>' : "",
      "</article>",
    ].join("");
  }).join("");
  document.querySelectorAll("[data-api-task]").forEach(row => {
    const task = row.dataset.apiTask;
    const route = snapshot.routes?.[task] || {};
    row.querySelector("[data-route-primary]").value = route.primary || "";
    row.querySelector("[data-route-fallback]").value = route.fallback || "";
    row.querySelector("[data-route-reasoning]").value = route.reasoning || "auto";
    updateApiRouteReasoningAvailability(row);
  });
  syncGlobalReasoningState();
  $("apiRouteOutput").textContent = `配置版本 ${snapshot.revision || 1} · API 与思考设置只影响后续请求`;
}

function updateApiRouteReasoningAvailability(row) {
  const providerId = row.querySelector("[data-route-primary]")?.value;
  const provider = (apiSnapshot.providers || []).find(item => item.id === providerId);
  const select = row.querySelector("[data-route-reasoning]");
  const configurable = provider?.reasoningControl?.configurable === true;
  select.disabled = !configurable;
  select.title = configurable ? "设置这个功能的思考强度" : "当前主力 API 不提供可控思考档位";
  row.classList.toggle("reasoning-unavailable", !configurable);
}

function applyGlobalReasoningPreset(mode) {
  let changed = 0;
  document.querySelectorAll("[data-api-task]").forEach(row => {
    const select = row.querySelector("[data-route-reasoning]");
    if (select.disabled) return;
    select.value = mode;
    changed++;
  });
  syncGlobalReasoningState();
  $("apiRouteOutput").textContent = changed
    ? `已选择“${reasoningModeLabel(mode)}”，点击“应用插槽”后生效`
    : "当前 API 没有可调思考档位";
}

function syncGlobalReasoningState() {
  const selects = [...document.querySelectorAll("[data-route-reasoning]:not(:disabled)")];
  const modes = [...new Set(selects.map(select => select.value))];
  const activeMode = modes.length === 1 ? modes[0] : "";
  document.querySelectorAll("[data-reasoning-preset]").forEach(button => {
    button.classList.toggle("active", button.dataset.reasoningPreset === activeMode);
  });
  if (!$("apiReasoningState")) return;
  $("apiReasoningState").textContent = !selects.length
    ? "跟随模型"
    : activeMode
      ? reasoningModeLabel(activeMode)
      : "按功能细调";
}

function reasoningModeLabel(mode) {
  return ({ economy: "省额度", auto: "智能", deep: "深度" })[mode] || "智能";
}

function fillApiProviderForm(provider) {
  const item = provider || {};
  apiEditorMode = item.id ? "edit" : "create";
  selectedApiProviderId = item.id || "";
  $("apiEditorTitle").textContent = item.id ? item.name : "新增 API";
  $("apiEditorHint").textContent = item.id ? "修改 Key 时重新填写；留空不会覆盖" : "先选预设，再填写模型名和 Key";
  $("apiSaveButton").textContent = item.id ? "保存修改" : "创建实例";
  $("apiId").value = item.id || "";
  $("apiId").disabled = Boolean(item.id);
  $("apiName").value = item.name || "";
  $("apiPreset").value = item.presetId || "custom-openai-chat";
  $("apiProtocol").value = item.protocol || "openai-chat";
  $("apiEndpoint").value = item.endpoint || "";
  $("apiModel").value = item.model || "";
  $("apiAuth").value = item.auth || "bearer";
  $("apiTokenField").value = item.tokenField || "max_tokens";
  $("apiKey").value = "";
  $("apiAllowLocal").checked = item.allowLocal === true;
  $("apiKeyState").textContent = item.keyConfigured ? "Key 已配置" : "未配置 Key";
  $("apiKeyState").classList.toggle("dirty", !item.keyConfigured);
  document.querySelectorAll("#apiCapabilityChecks input").forEach(input => {
    input.checked = (item.capabilities || ["text"]).includes(input.value);
  });
}

function startNewApiProvider() {
  selectedApiProviderId = "";
  document.querySelectorAll(".provider-card").forEach(card => card.classList.remove("active"));
  fillApiProviderForm(null);
  applyApiPreset("custom-openai-chat");
  $("apiId").focus();
  $("apiTestOutput").textContent = "填写并保存后可以测试连接";
}

function applyApiPreset(presetId) {
  const preset = (apiSnapshot.presets || []).find(item => item.id === presetId);
  if (!preset) return;
  $("apiPreset").value = preset.id;
  $("apiProtocol").value = preset.protocol;
  $("apiEndpoint").value = preset.endpoint || "";
  $("apiEndpoint").placeholder = preset.endpointHint || "https://.../chat/completions";
  $("apiModel").value = preset.model || "";
  $("apiAuth").value = preset.auth || "bearer";
  $("apiTokenField").value = preset.tokenField || "max_tokens";
  $("apiAllowLocal").checked = preset.allowLocal === true;
  document.querySelectorAll("#apiCapabilityChecks input").forEach(input => {
    input.checked = (preset.capabilities || []).includes(input.value);
  });
  if (!$("apiName").value.trim()) $("apiName").value = preset.name;
}

function apiProviderPayload() {
  return {
    action: "save-provider",
    mode: apiEditorMode,
    provider: {
      id: $("apiId").value.trim().toLowerCase(),
      name: $("apiName").value.trim(),
      presetId: $("apiPreset").value,
      protocol: $("apiProtocol").value,
      endpoint: $("apiEndpoint").value.trim(),
      model: $("apiModel").value.trim(),
      auth: $("apiAuth").value,
      tokenField: $("apiTokenField").value.trim(),
      allowLocal: $("apiAllowLocal").checked,
      capabilities: [...document.querySelectorAll("#apiCapabilityChecks input:checked")].map(input => input.value),
      key: $("apiKey").value.trim() || undefined,
    },
  };
}

function apiRoutesPayload() {
  const routes = {};
  document.querySelectorAll("[data-api-task]").forEach(row => {
    routes[row.dataset.apiTask] = {
      primary: row.querySelector("[data-route-primary]").value,
      fallback: row.querySelector("[data-route-fallback]").value || null,
      reasoning: row.querySelector("[data-route-reasoning]").value || "auto",
    };
  });
  return { action: "save-routes", routes };
}

function formatApiRoute(route) {
  if (!route) return "-";
  return `${route.primary || "未配置"} → ${route.fallback || "本地"}`;
}

function protocolLabel(protocol) {
  return ({
    "openai-chat": "OpenAI Chat",
    "openai-responses": "Responses",
    "anthropic-messages": "Anthropic",
    "gemini-native": "Gemini",
  })[protocol] || protocol;
}

function renderConfigEditor(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (configDirty && !options.force) return;
  const editable = snapshot.editable || {};
  for (const [id, field] of Object.entries(CONFIG_FIELDS)) {
    const values = Array.isArray(editable[field]) ? editable[field] : [];
    $(id).value = field === "botNames" ? values.join(" ") : values.join("\n");
  }
  renderListEditors();
  configBaseline = configFingerprint();
  setConfigDirty(false);
  $("configStatus").textContent = snapshot.restartRequiredAfterSave
    ? "当前配置已载入，修改后保存并重启 Bridge 生效"
    : "当前配置已载入";
}

function configFingerprint() {
  return JSON.stringify(Object.keys(CONFIG_FIELDS).map((id) => [id, $(id).value]));
}

function setConfigDirty(value) {
  configDirty = Boolean(value);
  const state = $("configDirtyState");
  state.textContent = configDirty ? "未保存" : "已保存";
  state.classList.toggle("dirty", configDirty);
  if ($("configSaveHint")) $("configSaveHint").textContent = configDirty ? "配置有未保存修改" : "没有未保存修改";
  if ($("configSaveBar")) $("configSaveBar").classList.toggle("dirty", configDirty);
}

function updateConfigDirty() {
  setConfigDirty(configFingerprint() !== configBaseline);
}

function configPayload() {
  return {
    editable: Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([id, field]) => [field, splitList($(id).value)])),
  };
}

function renderListEditors() {
  document.querySelectorAll("[data-list-editor-for]").forEach((editor) => {
    const source = $(editor.dataset.listEditorFor);
    if (!source) return;
    const values = splitList(source.value);
    const chips = editor.querySelector(".list-editor-chips");
    chips.innerHTML = values.map((value) => `<span class="list-chip">${escapeHtml(value)}<button type="button" data-list-remove="${escapeHtml(value)}" title="移除 ${escapeHtml(value)}" aria-label="移除 ${escapeHtml(value)}">×</button></span>`).join("");
  });
}

function commitListEditor(editor) {
  const source = $(editor.dataset.listEditorFor);
  const input = editor.querySelector("input:not([type=hidden])");
  const additions = splitList(input.value);
  if (!additions.length) return;
  if (editor.dataset.numeric === "true" && additions.some((value) => !/^\d{5,12}$/.test(value))) {
    toast("QQ 或群号只能填写 5 到 12 位数字。", "error");
    input.focus();
    return;
  }
  source.value = [...new Set([...splitList(source.value), ...additions])].join("\n");
  input.value = "";
  renderListEditors();
  updateConfigDirty();
}

function removeListEditorValue(editor, value) {
  const source = $(editor.dataset.listEditorFor);
  source.value = splitList(source.value).filter((item) => item !== value).join("\n");
  renderListEditors();
  updateConfigDirty();
}

function moduleLabel(name) {
  return ({
    cognition: "短期上下文",
    groupSummary: "每日群报",
    jm: "JM 下载",
    linkPreview: "链接预览",
    imageContext: "图片语境",
    memeKnowledge: "梗库理解",
    stickers: "收藏表情",
    memory: "用户画像",
    relationship: "互动熟悉度",
    wordcloud: "群词云",
  })[name] || name;
}

function modelLabel(name) {
  return ({ mimo: "MiMo 主模型", deepseek: "DeepSeek 兜底", doubao: "豆包视觉", tavily: "联网搜索" })[name] || name;
}

function setOutput(id, value, expanded = true) {
  const node = $(id);
  node.textContent = value;
  node.classList.toggle("has-content", expanded);
}

function renderLogs(logs) {
  logLines = logs.current && Array.isArray(logs.current.lines) ? logs.current.lines : [];
  applyLogFilter();
}

function applyLogFilter() {
  const query = $("logFilter").value.trim().toLocaleLowerCase("zh-CN");
  const level = $("logLevel")?.value || "all";
  const module = $("logModule")?.value || "all";
  const filtered = logLines.filter((line) => {
    const normalized = String(line).toLocaleLowerCase("zh-CN");
    if (query && !normalized.includes(query)) return false;
    if (level === "error" && !/(\[e\]|error|failed|失败|异常)/i.test(normalized)) return false;
    if (level === "warn" && !/(\[w\]|warn|warning|警告|降级)/i.test(normalized)) return false;
    if (level === "info" && /(\[e\]|error|failed|失败|异常|\[w\]|warn|warning|警告)/i.test(normalized)) return false;
    if (module === "model" && !/(mimo|deepseek|model|模型|output packet)/i.test(normalized)) return false;
    if (module === "message" && !/(sendmsg|sendprivate|reply|message|消息|回复)/i.test(normalized)) return false;
    if (module === "network" && !/(fetch|http|websocket|network|url|网络)/i.test(normalized)) return false;
    if (module === "summary" && !/(summary|日报|群报)/i.test(normalized)) return false;
    if (module === "jm" && !/(jmcomic|\bjm\b)/i.test(normalized)) return false;
    return true;
  });
  $("logsOutput").textContent = filtered.length > 0 ? filtered.join("\n") : query ? "没有匹配的日志" : "暂无日志";
  if ($("logCount")) $("logCount").textContent = `${fmt.format(filtered.length)} 条`;
  if (logFollow) $("logsOutput").scrollTop = $("logsOutput").scrollHeight;
}

function renderStickers(snapshot, options = {}) {
  stickerSnapshot = snapshot || { entries: [], settings: {}, counts: {}, stats: {} };
  const allEntries = Array.isArray(stickerSnapshot.entries) ? stickerSnapshot.entries : [];
  const counts = stickerSnapshot.counts || {};
  const settings = stickerSnapshot.settings || {};
  stickerFilter = $("stickerFilter")?.value || stickerFilter;
  const entries = filterStickerEntries(allEntries, stickerFilter);
  const requestedId = options.selectId || selectedStickerId;
  selectedStickerId = entries.some((entry) => entry.id === requestedId)
    ? requestedId
    : entries[0]?.id || "";
  document.querySelector(".sticker-workbench")?.classList.toggle("empty", !selectedStickerId);
  $("stickerDetailPanel").hidden = !selectedStickerId;

  $("stickerNavCount").textContent = String(counts.indexed ?? entries.filter((entry) => entry.indexed).length);
  $("stickerListCount").textContent = entries.length === allEntries.length
    ? `${entries.length} 张`
    : `${entries.length} / ${allEntries.length} 张`;
  $("stickerSummary").innerHTML = [
    ["已同步", counts.total || 0],
    ["可发送", counts.indexed || 0],
    ["待分析", counts.pending || 0],
    ["已发送", stickerSnapshot.stats?.sent || 0],
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
      <button type="button" class="sticker-tile${entry.id === selectedStickerId ? " active" : ""}${entry.enabled ? "" : " disabled"}" data-sticker-id="${escapeHtml(entry.id)}" title="${escapeHtml(entry.description || "待分析")}">
        <img src="${escapeHtml(entry.url)}" alt="">
        <span>${entry.indexed ? escapeHtml(entry.tags?.[0] || "已分析") : "待分析"}</span>
      </button>`).join("")
    : '<div class="empty-state"><b>还没有同步收藏表情</b><span>点右上角“同步收藏”。</span></div>';

  fillStickerDetail(entries.find((entry) => entry.id === selectedStickerId));
  const syncLabel = stickerSnapshot.sync?.syncing
    ? "正在同步"
    : stickerSnapshot.sync?.lastSyncAt
      ? new Date(stickerSnapshot.sync.lastSyncAt).toLocaleString("zh-CN")
      : "尚未同步";
  $("stickerStatus").textContent = [
    `模式：${stickerModeLabel(settings.mode)}`,
    `同步：${syncLabel}`,
    `发送成功 ${stickerSnapshot.stats?.sent || 0} · 失败 ${stickerSnapshot.stats?.sendFailures || 0}`,
    stickerSnapshot.sync?.lastError ? `最近错误：${stickerSnapshot.sync.lastError}` : "图片文件不会保存到本地",
  ].join("\n");
  renderStickerCaptureStatus(stickerSnapshot);
  stickersLoaded = true;
}

function fillStickerDetail(entry) {
  $("stickerId").value = entry?.id || "";
  $("stickerDescription").value = entry?.description || "";
  $("stickerTags").value = Array.isArray(entry?.tags) ? entry.tags.join(" ") : "";
  $("stickerAllowedGroups").value = Array.isArray(entry?.allowedGroups) ? entry.allowedGroups.join(" ") : "";
  $("stickerEntryEnabled").checked = entry?.enabled !== false;
  $("stickerPreview").innerHTML = entry?.url
    ? `<img src="${escapeHtml(entry.url)}" alt="选中的收藏表情">`
    : "<span>选择一张表情</span>";
  $("stickerEntryMeta").textContent = stickerEntryMeta(entry);
  $("removeCapturedStickerButton").hidden = entry?.source !== "group-capture";
}

function stickerSettingsPayload(mode, captureMode) {
  return {
    action: "settings",
    settings: {
      mode: mode || stickerSnapshot.settings?.mode || "steady",
      groupEnabled: $("stickerGroupEnabled").checked,
      privateEnabled: $("stickerPrivateEnabled").checked,
      chance: Number($("stickerChance").value || 0) / 100,
      strongChance: Number($("stickerStrongChance").value || 0) / 100,
      cooldownMs: Number($("stickerCooldown").value || 0) * 60000,
      allowedGroups: splitList($("stickerGroups").value),
      captureMode: captureMode || stickerSnapshot.settings?.captureMode || "observe",
      captureDailyLimit: Number($("stickerCaptureDailyLimit").value || 0),
      captureCatalogLimit: Number($("stickerCaptureCatalogLimit").value || 300),
      captureMinConfidence: Number($("stickerCaptureConfidence").value || 0) / 100,
      captureMinDistinctSenders: Number($("stickerCaptureSenders").value || 2),
    },
  };
}

function stickerEntryPayload() {
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

function stickerSimulationPayload() {
  return {
    action: "simulate",
    groupId: Number($("stickerSimGroup").value || 0),
    userMessage: $("stickerSimUser").value.trim(),
    assistantText: $("stickerSimAssistant").value.trim(),
  };
}

function renderStickerSimulation(result) {
  const decision = result?.result || {};
  if (decision.action !== "send") {
    $("stickerStatus").textContent = `预演结果：不发送\n原因：${decision.reason || "没有可靠匹配"}`;
    return;
  }
  selectedStickerId = decision.stickerId;
  renderStickers(result.snapshot || stickerSnapshot, { selectId: selectedStickerId });
  $("stickerStatus").textContent = [
    "预演结果：会发送",
    `表情：${decision.sticker?.description || decision.stickerId}`,
    `标签：${(decision.sticker?.tags || []).join("、") || "-"}`,
    "预演不会真的向 QQ 发送消息",
  ].join("\n");
}

function stickerModeLabel(mode) {
  return ({ steady: "正常发送", shadow: "只观察不发送", off: "关闭" })[mode] || mode || "正常发送";
}

function filterStickerEntries(entries, filter) {
  if (filter === "qq-favorite") return entries.filter((entry) => entry.source === "qq-favorite");
  if (filter === "group-capture") return entries.filter((entry) => entry.source === "group-capture");
  if (filter === "candidate") {
    return entries.filter((entry) =>
      entry.source === "group-capture" &&
      ["candidate", "cloud-failed", "pending-cloud"].includes(entry.captureState));
  }
  return entries;
}

function stickerEntryMeta(entry) {
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

function renderStickerCaptureStatus(snapshot) {
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

function captureModeLabel(mode) {
  return ({ auto: "自动收录", observe: "只观察", off: "关闭" })[mode] || "只观察";
}

function renderMemes(snapshot, options = {}) {
  memeSnapshot = snapshot || { entries: [], candidates: [] };
  const entries = Array.isArray(memeSnapshot.entries) ? memeSnapshot.entries : [];
  const desiredEntry = options.selectName || lastEntrySelection || entries[0]?.name || "";
  if ($("memeNavCount")) $("memeNavCount").textContent = String(entries.length);

  $("memeSelect").innerHTML = entries
    .map((entry) => `<option value="${escapeHtml(entry.name)}">${escapeHtml(entry.name)} · ${escapeHtml(entry.level || "B")} · ${memeStatusLabel(entry.status, entry.enabled)}</option>`)
    .join("");
  $("memeHistorySelect").innerHTML = (memeSnapshot.history || [])
    .map((item) => {
      const date = item.at ? new Date(item.at).toLocaleString("zh-CN") : "未知时间";
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.term)} · ${historyActionLabel(item.action)} · ${escapeHtml(date)}</option>`;
    })
    .join("");

  if (entries.some((entry) => entry.name === desiredEntry)) $("memeSelect").value = desiredEntry;
  lastEntrySelection = $("memeSelect").value;
  document.querySelectorAll("[data-action='setMemeMode']").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === memeSnapshot.mode);
  });
  const counts = memeSnapshot.counts || {};
  const sync = memeSnapshot.sync || {};
  const lastSync = sync.lastSuccessAt ? new Date(sync.lastSuccessAt).toLocaleString("zh-CN") : "尚未成功";
  const sourceStates = Object.entries(sync.sources || {});
  const sourceOk = sourceStates.filter(([, item]) => item?.ok).length;
  const sourceFailed = sourceStates.length - sourceOk;
  const latestRun = Array.isArray(sync.runs) ? sync.runs.at(-1) : null;
  const rolledBack = latestRun?.status === "rolled-back";
  $("memeUpdateState").textContent = sync.error
    ? "更新失败"
    : rolledBack
      ? "已回退"
      : sync.lastSuccessAt
        ? "已联网"
        : "等待更新";
  $("memeUpdateState").classList.toggle("dirty", Boolean(sync.error));
  $("memeStatus").textContent = [
    `模式：${memeModeLabel(memeSnapshot.mode)}`,
    `启用 ${counts.active ?? entries.filter((item) => item.enabled).length} · 隔离 ${counts.quarantined || 0} · 停用 ${counts.disabled || 0} · 过期 ${counts.stale || 0}`,
    `最近联网：${lastSync}`,
    rolledBack
      ? "最近一次联网批次已回退"
      : `本轮新增 ${sync.accepted || 0} · 更新 ${sync.updated || 0} · 审核 ${sync.review || 0}`,
    sourceStates.length ? `来源：可用 ${sourceOk} · 失败 ${sourceFailed}` : "来源：等待首次更新",
    sync.error ? `问题：${sync.error}` : "群聊不会自动造词；人工字段不会被联网更新覆盖。",
    `删除防复活：${memeSnapshot.tombstoneCount || 0}`,
  ].join("\n");

  if (options.forceFill || (!memeDirty && !$("memeName").value.trim())) {
    const selected = entries.find((entry) => entry.name === $("memeSelect").value);
    if (selected) fillMemeForm(selected);
    else clearMemeForm();
  }
  memesLoaded = true;
}

function memeFormFingerprint() {
  return JSON.stringify({
    fields: Object.fromEntries(MEME_FIELD_IDS.map((id) => [id, $(id).value])),
    sources: readMemeSources(),
    locks: selectedMemeLocks(),
  });
}

function setMemeSavedState() {
  memeBaseline = memeFormFingerprint();
  setMemeDirty(false);
}

function setMemeDirty(value) {
  memeDirty = Boolean(value);
  const state = $("memeDirtyState");
  state.textContent = memeDirty ? "未保存" : "已保存";
  state.classList.toggle("dirty", memeDirty);
}

function updateMemeDirty() {
  setMemeDirty(memeFormFingerprint() !== memeBaseline);
}

function confirmDiscardMemeChanges() {
  return !memeDirty || window.confirm("当前词条有未保存修改。确定放弃这些修改吗？");
}

function fillMemeForm(entry) {
  if (!entry) return;
  memeEditingOriginalName = entry.name || "";
  $("memeName").value = entry.name || "";
  $("memeLevel").value = entry.level || "B";
  $("memeConfidence").value = Math.round(Number(entry.confidence || 0) * 100);
  $("memeEntryStatus").value = entry.status || (entry.enabled === false ? "disabled" : "active");
  $("memeScopeType").value = entry.scope?.type === "groups" ? "groups" : "global";
  $("memeScopeGroups").value = Array.isArray(entry.scope?.groupIds) ? entry.scope.groupIds.join(" ") : "";
  updateMemeScopeInput();
  $("memeAliases").value = Array.isArray(entry.aliases) ? entry.aliases.join(" ") : "";
  $("memeTriggers").value = Array.isArray(entry.triggers) ? entry.triggers.join(" ") : "";
  $("memeMeaning").value = entry.meaning || "";
  $("memeUsage").value = entry.usage || "";
  $("memeExamples").value = Array.isArray(entry.examples) ? entry.examples.join("\n") : "";
  renderMemeSources(entry.sources || []);
  setMemeLocks(entry.manualFields || []);
  $("memeEntryMeta").textContent = formatMemeEntryMeta(entry);
  setMemeSavedState();
}

function clearMemeForm() {
  memeEditingOriginalName = "";
  MEME_FIELD_IDS.forEach((id) => {
    const node = $(id);
    if (node.tagName === "SELECT") return;
    node.value = "";
  });
  $("memeLevel").value = "B";
  $("memeConfidence").value = "70";
  $("memeEntryStatus").value = "active";
  $("memeScopeType").value = "global";
  $("memeScopeGroups").value = "";
  updateMemeScopeInput();
  renderMemeSources([]);
  setMemeLocks(memeSnapshot.editableFields || []);
  $("memeEntryMeta").textContent = "新词条将作为人工词条保存。";
  setMemeSavedState();
}

function applyMemeResearch(result) {
  if (!result?.ok || !result.entry) return false;
  const entry = result.entry;
  $("memeName").value = entry.name || result.query || "";
  $("memeLevel").value = entry.level || "A";
  $("memeConfidence").value = Math.round(Number(entry.confidence || 0.8) * 100);
  $("memeEntryStatus").value = "active";
  $("memeAliases").value = splitList(entry.aliases || []).join(" ");
  $("memeTriggers").value = splitList(entry.triggers || [entry.name]).join(" ");
  $("memeMeaning").value = entry.meaning || "";
  $("memeUsage").value = entry.usage || "";
  $("memeExamples").value = (entry.examples || []).join("\n");
  renderMemeSources(entry.sources || result.evidence || []);
  setMemeLocks(memeSnapshot.editableFields || []);
  $("memeStatus").textContent = [
    `联网查证已回填：${entry.name || result.query}`,
    `证据：${(result.evidence || []).length} 条 · 审核模型 ${result.review?.provider || "已兜底"}`,
    memeEditingOriginalName ? "保存会更新当前词条。" : "保存后会新增人工确认词条。",
  ].join("\n");
  memeBaseline = "";
  setMemeDirty(true);
  return true;
}

function memeFormPayload() {
  const status = $("memeEntryStatus").value;
  return {
    action: "save",
    entry: {
      originalName: memeEditingOriginalName,
      name: $("memeName").value.trim(),
      level: $("memeLevel").value,
      confidence: Number($("memeConfidence").value || 0) / 100,
      enabled: status === "active",
      status,
      scope: {
        type: $("memeScopeType").value,
        groupIds: splitList($("memeScopeGroups").value),
      },
      aliases: splitList($("memeAliases").value),
      triggers: splitList($("memeTriggers").value),
      meaning: $("memeMeaning").value.trim(),
      usage: $("memeUsage").value.trim(),
      examples: $("memeExamples").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      sources: readMemeSources(),
      manualFields: selectedMemeLocks(),
    },
  };
}

function selectedMemeName() {
  return $("memeName").value.trim() || $("memeSelect").value;
}

function selectedMemeQuery() {
  return $("memeName").value.trim() || $("memeSelect").value;
}

function renderMemeSources(sources) {
  $("memeSourceList").innerHTML = "";
  for (const source of Array.isArray(sources) ? sources : []) addMemeSourceRow(source);
}

function addMemeSourceRow(source = {}) {
  $("memeSourceList").insertAdjacentHTML("beforeend", `
    <div class="meme-source-row">
      <input data-source-field="platform" aria-label="来源平台" placeholder="平台" value="${escapeHtml(source.platform || "manual")}">
      <input data-source-field="title" aria-label="来源标题" placeholder="标题" value="${escapeHtml(source.title || "")}">
      <input data-source-field="url" aria-label="来源链接" placeholder="https://" value="${escapeHtml(source.url || "")}">
      <button type="button" class="icon-button danger-quiet" data-remove-meme-source title="删除来源" aria-label="删除来源">×</button>
    </div>
  `);
  updateMemeDirty();
}

function readMemeSources() {
  return [...document.querySelectorAll(".meme-source-row")]
    .map((row) => ({
      platform: row.querySelector('[data-source-field="platform"]').value.trim() || "manual",
      title: row.querySelector('[data-source-field="title"]').value.trim(),
      url: row.querySelector('[data-source-field="url"]').value.trim(),
      kind: "manual",
    }))
    .filter((item) => item.title || item.url);
}

function selectedMemeLocks() {
  const fields = [...document.querySelectorAll("[data-meme-lock]:checked")]
    .map((input) => input.dataset.memeLock);
  if (fields.includes("confidence")) fields.push("semanticConfidence");
  if (fields.includes("status")) fields.push("enabled");
  return [...new Set(fields)];
}

function setMemeLocks(fields) {
  const selected = new Set(Array.isArray(fields) ? fields : []);
  if (selected.has("semanticConfidence")) selected.add("confidence");
  if (selected.has("enabled")) selected.add("status");
  document.querySelectorAll("[data-meme-lock]").forEach((input) => {
    input.checked = selected.has(input.dataset.memeLock);
  });
}

function historyActionLabel(action) {
  return ({
    create: "新建前",
    edit: "编辑前",
    enable: "启用前",
    disable: "停用前",
    active: "恢复前",
    quarantined: "隔离前",
    delete: "删除前",
  })[action] || action || "修改前";
}

function updateMemeScopeInput() {
  const globalScope = $("memeScopeType").value !== "groups";
  $("memeScopeGroups").disabled = globalScope;
  if (globalScope) $("memeScopeGroups").value = "";
}

function splitList(value) {
  const raw = Array.isArray(value) ? value.join(" ") : String(value || "");
  return raw.split(/[\s,;，；、]+/).map((item) => item.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripConfiguredMention(raw) {
  const names = Array.isArray(lastStatus.config?.botNames) && lastStatus.config.botNames.length
    ? lastStatus.config.botNames
    : ["夜星"];
  let clean = raw.trim();
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clean = clean.replace(new RegExp(`^@?${escaped}\\s*`, "i"), "").trim();
  }
  return clean || raw.trim();
}

function diagnosePayload() {
  const messageType = $("diagType")?.value === "private" ? "private" : "group";
  const groupId = Number($("diagGroup").value.trim());
  const userId = Number($("diagUser").value.trim());
  if (messageType === "group" && (!Number.isSafeInteger(groupId) || groupId <= 0)) throw new Error("群号格式不正确。");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("QQ 号格式不正确。");
  const clean = stripConfiguredMention($("diagText").value);
  const selfUin = String(lastStatus.config?.selfUin || "1000000001");
  if (messageType === "private") {
    return {
      message_type: "private",
      user_id: userId,
      message: [{ type: "text", data: { text: clean } }],
      raw_message: clean,
    };
  }
  return {
    message_type: "group",
    group_id: groupId,
    user_id: userId,
    message: [
      { type: "at", data: { qq: selfUin } },
      { type: "text", data: { text: ` ${clean}` } },
    ],
    raw_message: `[CQ:at,qq=${selfUin}] ${clean}`,
  };
}

function validateAction(action) {
  if (action === "refreshConfig" && configDirty) {
    return window.confirm("当前配置有未保存修改。确定重新读取并放弃这些修改吗？");
  }
  if (action === "saveConfig") {
    if (!splitList($("cfgBotNames").value).length) {
      toast("机器人名不能为空。", "error");
      document.querySelector('[data-list-editor-for="cfgBotNames"] input')?.focus();
      return false;
    }
    return window.confirm("将保存非密钥配置并重启 Bridge。确定继续吗？");
  }
  if (action === "stopBridge") {
    return window.confirm("停止后机器人将不再回复，并同时关闭守护进程。确定停止 Bridge 吗？");
  }
  if (action === "stopAll") {
    return window.confirm("将停止 Bridge、守护进程、NapCat 和该运行目录下的 QQ。确定停止全部吗？");
  }
  if (action === "saveApiProvider") {
    if (!$("apiId").value.trim()) {
      toast("请填写实例 ID。", "error");
      $("apiId").focus();
      return false;
    }
    const id = $("apiId").value.trim().toLowerCase();
    const idExists = (apiSnapshot.providers || []).some(item => item.id === id);
    if (apiEditorMode === "create" && idExists) {
      toast("这个实例 ID 已存在。新增不会覆盖原实例，请换一个 ID。", "error");
      $("apiId").focus();
      return false;
    }
    const required = [
      ["apiName", "显示名称"],
      ["apiEndpoint", "Endpoint"],
      ["apiModel", "模型名"],
    ];
    for (const [id, label] of required) {
      if (!$(id).value.trim()) {
        toast(`请填写${label}。`, "error");
        $(id).focus();
        return false;
      }
    }
  }
  if (action === "testApiProvider" && !selectedApiProviderId) {
    toast("先保存 API 实例，再测试连接。", "error");
    return false;
  }
  if (action === "deleteApiProvider") {
    if (!selectedApiProviderId) return false;
    return window.confirm(`确定删除 API 实例“${selectedApiProviderId}”吗？`);
  }
  if (action === "saveApiRoutes") {
    return window.confirm("确定应用当前 API 分配和思考强度吗？");
  }
  if (action === "rollbackApiProviders") {
    if (!apiSnapshot.rollbackAvailable) {
      toast("目前没有可回滚的 API 配置。", "error");
      return false;
    }
    return window.confirm("确定恢复上一版 API 实例和插槽配置吗？Key 不会被改动。");
  }
  if (action === "saveMeme" && !$("memeName").value.trim()) {
    toast("先填写梗名再保存。", "error");
    $("memeName").focus();
    return false;
  }
  if (action === "saveSticker" && !$("stickerId").value) {
    toast("先从左侧选择一张表情。", "error");
    return false;
  }
  if (action === "simulateSticker" && (!$("stickerSimUser").value.trim() || !$("stickerSimAssistant").value.trim())) {
    toast("请把用户消息和夜星回复都填上。", "error");
    return false;
  }
  if (action === "deleteMeme") {
    const name = selectedMemeName();
    return Boolean(name) && window.confirm(`确定删除词条“${name}”吗？需要时可从修改记录恢复。`);
  }
  if (action === "researchMemeWeb" && !selectedMemeQuery()) {
    toast("先填写或选择一个词条。", "error");
    return false;
  }
  if (action === "rollbackMemeWebUpdate") {
    if (!memeSnapshot.sync?.rollbackAvailable) {
      toast("目前没有可以回退的联网更新。", "error");
      return false;
    }
    return window.confirm("确定回退上一次联网更新吗？人工保存的内容不会被联网回退覆盖。");
  }
  if (action === "restoreMemeHistory") {
    if (!$("memeHistorySelect").value) {
      toast("目前没有可恢复的修改记录。", "error");
      return false;
    }
    return window.confirm("确定恢复这次修改之前的词条内容吗？");
  }
  if (action === "refreshMemes" && !confirmDiscardMemeChanges()) return false;
  return true;
}

function operationOutputId(action) {
  return ["startAll", "health", "restartBridge", "stopBridge", "stopAll"].includes(action) ? "serviceOutput" : "actionOutput";
}

async function runAction(action, button = null, options = {}) {
  const silent = options.silent === true;
  if (action === "newMeme") {
    if (!confirmDiscardMemeChanges()) return;
    memeSelectionMode = "entry";
    clearMemeForm();
    $("memeName").focus();
    toast("已打开空白词条。", "success");
    return;
  }
  if (action === "addMemeSource") {
    addMemeSourceRow();
    return;
  }
  if (action === "newApiProvider") {
    startNewApiProvider();
    return;
  }
  if (action === "removeCapturedSticker" &&
      !window.confirm("只会移除机器人从群聊采集的这张表情。继续吗？")) {
    return;
  }
  if (!validateAction(action) || !beginAction(action, button, silent)) return;
  let failure = null;

  if (action === "diagnose") {
    setOutput("diagnoseOutput", "正在检查消息格式、白名单、@目标和命令路由...", true);
    $("diagnoseDetails").open = false;
  }
  if (["startAll", "health", "restartBridge", "stopBridge", "stopAll", "createBackup"].includes(action)) {
    setOutput(operationOutputId(action), `${ACTION_LABELS[action] || "正在处理"}...`, true);
  }

  try {
    let payload = {};
    if (action === "refreshMemes") {
      renderMemes(await host.call("getMemes"), { forceFill: true });
      if (!silent) toast("梗库已刷新", "success");
      return;
    }
    if (action === "refreshStickers") {
      renderStickers(await host.call("getStickers"));
      if (!silent) toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "refreshCapabilities") {
      renderCapabilities(await host.call("getCapabilities"));
      if (!silent) toast("能力状态已刷新", "success");
      return;
    }
    if (action === "refreshApiProviders") {
      renderApiProviders(await host.call("getApiProviders"));
      if (!silent) toast("API 状态已刷新", "success");
      return;
    }
    if (action === "saveMeme") payload = memeFormPayload();
    if (action === "saveConfig") payload = configPayload();
    if (action === "saveApiProvider") payload = apiProviderPayload();
    if (action === "testApiProvider") payload = { action: "test-provider", providerId: selectedApiProviderId };
    if (action === "deleteApiProvider") payload = { action: "delete-provider", providerId: selectedApiProviderId };
    if (action === "saveApiRoutes") payload = apiRoutesPayload();
    if (action === "rollbackApiProviders") payload = { action: "rollback" };
    if (action === "enableMeme") payload = { action: "enable", name: selectedMemeName() };
    if (action === "disableMeme") payload = { action: "disable", name: selectedMemeName() };
    if (action === "activateMeme") payload = { action: "activate", name: selectedMemeName() };
    if (action === "quarantineMeme") payload = { action: "quarantine", name: selectedMemeName() };
    if (action === "setMemeMode") payload = { action: "set-mode", mode: button?.dataset.mode || "steady" };
    if (action === "deleteMeme") payload = { action: "delete", name: selectedMemeName() };
    if (action === "runMemeWebUpdate") payload = { action: "run-web-update" };
    if (action === "researchMemeWeb") payload = { action: "research-web", query: selectedMemeQuery() };
    if (action === "rollbackMemeWebUpdate") payload = { action: "rollback-web-update" };
    if (action === "restoreMemeHistory") payload = { action: "restore-history", revisionId: $("memeHistorySelect").value };
    if (action === "syncStickers") payload = { action: "sync", analyze: true, analysisLimit: 4 };
    if (action === "analyzeStickers") payload = { action: "analyze", limit: 4 };
    if (action === "saveStickerSettings") payload = stickerSettingsPayload();
    if (action === "setStickerMode") payload = stickerSettingsPayload(button?.dataset.mode || "steady");
    if (action === "setStickerCaptureMode") {
      payload = stickerSettingsPayload(undefined, button?.dataset.captureMode || "observe");
    }
    if (action === "refreshStickerCapabilities") payload = { action: "capabilities" };
    if (action === "cleanupStickerTemp") payload = { action: "cleanup" };
    if (action === "removeCapturedSticker") {
      payload = { action: "remove", id: $("stickerId").value };
    }
    if (action === "saveSticker") payload = stickerEntryPayload();
    if (action === "simulateSticker") payload = stickerSimulationPayload();
    if (action === "diagnose") payload = diagnosePayload();

    if (action === "setBuiltInBackground") {
      const background = await host.call("setBackground", { mode: "built-in" });
      applyBackground(background);
      toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "setDesktopBackground") {
      const background = await host.call("setBackground", { mode: "desktop" });
      applyBackground(background);
      if (!background.uri) throw new Error("没有找到可用的桌面壁纸。");
      toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "chooseBackgroundImage") {
      const background = await host.call("chooseBackgroundImage");
      if (!background.uri) {
        toast("未选择图片", "error");
        return;
      }
      applyBackground(background);
      toast(ACTION_DONE[action], "success");
      return;
    }

    const apiActions = ["saveApiProvider", "testApiProvider", "deleteApiProvider", "saveApiRoutes", "rollbackApiProviders"];
    const memeActions = [
      "saveMeme",
      "enableMeme",
      "disableMeme",
      "activateMeme",
      "quarantineMeme",
      "setMemeMode",
      "deleteMeme",
      "runMemeWebUpdate",
      "researchMemeWeb",
      "rollbackMemeWebUpdate",
      "restoreMemeHistory",
    ];
    const hostAction = STICKER_ACTIONS.includes(action)
      ? "manageStickers"
      : apiActions.includes(action)
      ? "manageApiProviders"
      : memeActions.includes(action)
        ? action === "saveMeme"
          ? "saveMeme"
          : action === "deleteMeme"
            ? "deleteMeme"
            : ["enableMeme", "disableMeme", "activateMeme", "quarantineMeme", "setMemeMode"].includes(action)
              ? "toggleMeme"
              : action
        : action;
    const result = await host.call(hostAction, payload);

    if (action === "refresh") {
      renderSnapshot(result);
    } else if (STICKER_ACTIONS.includes(action)) {
      if (action === "simulateSticker") {
        renderStickerSimulation(result);
      } else {
        if (action === "removeCapturedSticker") selectedStickerId = "";
        renderStickers(result.snapshot || await host.call("getStickers"), {
          selectId: selectedStickerId,
        });
        const operation = result.result || {};
        $("stickerStatus").textContent = [
          ACTION_DONE[action],
          operation.items !== undefined ? `读取 ${operation.items} 张 · 新增 ${operation.added || 0} 张` : "",
          operation.analyzed !== undefined ? `分析 ${operation.analyzed} 张 · 复用 ${operation.reused || 0} 张 · 失败 ${operation.failed || 0} 张` : "",
        ].filter(Boolean).join("\n");
      }
    } else if (apiActions.includes(action)) {
      if (result.snapshot) {
        const keepId = action === "deleteApiProvider" ? "" : selectedApiProviderId || result.provider?.id;
        renderApiProviders(result.snapshot, { selectId: keepId });
      }
      if (action === "testApiProvider") {
        const message = result.ok
          ? `连接成功\n耗时：${result.durationMs} ms\n模型回复：${result.output || "OK"}`
          : `连接失败\n${result.error || "接口没有返回可用正文"}`;
        setOutput("apiTestOutput", message, true);
        if (!result.ok) throw new Error(result.error || "API 连接测试失败");
      } else {
        setOutput("apiRouteOutput", result.message || ACTION_DONE[action], true);
      }
    } else if (action === "refreshConfig") {
      lastConfigSnapshot = result;
      renderConfigEditor(result, { force: true });
      renderConfig(lastStatus, lastConfigSnapshot);
    } else if (action === "saveConfig") {
      const snapshot = await host.call("getConfig");
      lastConfigSnapshot = snapshot;
      renderConfigEditor(snapshot, { force: true });
      renderConfig(lastStatus, snapshot);
      setOutput("configStatus", `${result.message || "配置已保存"}\n正在重启 Bridge 使配置生效...`, true);
      try {
        const restartResult = await host.call("restartBridge");
        if (restartResult.snapshot) renderSnapshot(restartResult.snapshot);
        setOutput("configStatus", "配置已保存，Bridge 已重启并重新载入。", true);
      } catch (error) {
        setOutput("configStatus", `配置已经保存，但 Bridge 重启失败：${error.message || error}`, true);
        throw new Error(`配置已保存，Bridge 重启失败：${error.message || error}`);
      }
    } else if (action === "refreshLogs") {
      renderLogs(result);
      logsLoaded = true;
    } else if (["startAll", "health", "restartBridge"].includes(action)) {
      if (result.snapshot) renderSnapshot(result.snapshot);
      setOutput("serviceOutput", formatOperationResult(result), true);
    } else if (action === "diagnose") {
      const formatted = formatDiagnoseResult(result);
      renderDiagnoseSummary(formatted.summary);
      setOutput("diagnoseRaw", formatted.raw, true);
    } else if (action === "researchMemeWeb") {
      const applied = applyMemeResearch(result);
      if (!applied) {
        $("memeStatus").textContent = `联网证据不足：${result.reason || payload.query || "-"}`;
        throw new Error(result.reason || "联网证据不足");
      }
      toast("查证结果已回填，确认后保存", "success");
      return;
    } else if (memeActions.includes(action)) {
      const snapshot = result.snapshot || await host.call("getMemes");
      const forceFill = [
        "saveMeme",
        "enableMeme",
        "disableMeme",
        "deleteMeme",
        "rollbackMemeWebUpdate",
        "restoreMemeHistory",
      ].includes(action);
      renderMemes(snapshot, { selectName: action === "deleteMeme" ? "" : selectedMemeName(), forceFill });
      setOutput("actionOutput", formatMemeOperationResult(action, result), true);
    } else if (["createBackup", "openLogs", "stopBridge", "stopAll"].includes(action)) {
      setOutput(operationOutputId(action), formatOperationResult(result), true);
      if (action === "stopBridge" || action === "stopAll") {
        renderStoppedStatus(result.generatedAt);
      }
    }

    if (!silent) toast(ACTION_DONE[action] || "操作完成", "success");
  } catch (error) {
    failure = error;
    showActionError(action, error);
    if (!silent) toast(error.message || "操作失败", "error");
  } finally {
    endAction(action);
    if (!silent) finishActivity(failure ? `${ACTION_LABELS[action] || "操作"}失败` : ACTION_DONE[action] || "操作完成", failure ? "error" : "success");
  }
}

function memeStatusLabel(status, enabled) {
  if (status === "quarantined") return "隔离";
  if (status === "stale") return "过期";
  if (status === "disabled" || enabled === false) return "停用";
  if (status === "candidate") return "待审核";
  return "启用";
}

function memeModeLabel(mode) {
  return ({ steady: "全部词条", shadow: "仅人工词条", off: "关闭" })[mode] || mode || "全部词条";
}

function formatMemeEntryMeta(entry) {
  const scope = entry.scope?.type === "groups"
    ? `仅来源群（${entry.scope.groupCount || 0} 个）`
    : "全局";
  const evidence = entry.evidence || {};
  const verifiedAt = entry.lastVerifiedAt
    ? new Date(entry.lastVerifiedAt).toLocaleString("zh-CN")
    : "人工维护";
  return [
    `来源：${entry.source || "未知"} · 范围：${scope} · 状态：${memeStatusLabel(entry.status, entry.enabled)}`,
    `资料：${entry.sources?.length || 0} 条 · 查证：${verifiedAt} · 使用记录 ${entry.seenCount || 0} 次`,
    `证据：${evidence.count || 0} 条 · ${evidence.contexts || 0} 个来源域`,
    entry.manualProtected ? `人工保护：${entry.manualFields?.length || 0} 个字段` : "人工保护：未选择",
  ].join("\n");
}

function showActionError(action, error) {
  const message = error.message || String(error);
  if (action === "diagnose") {
    setOutput("diagnoseOutput", `诊断失败：${message}`, true);
    $("diagnoseDetails").open = false;
    return;
  }
  if (action === "refresh" || action === "refreshStatus") {
    markStatusStale(`数据刷新失败 · ${message}`);
    return;
  }
  if (actionGroup(action) === "config") {
    setOutput("configStatus", message.startsWith("配置已保存") ? message : `配置操作失败：${message}`, true);
    return;
  }
  if (actionGroup(action) === "api-providers") {
    const outputId = action === "testApiProvider" ? "apiTestOutput" : "apiRouteOutput";
    setOutput(outputId, `API 操作失败：${message}`, true);
    return;
  }
  if (actionGroup(action) === "memes") {
    $("memeStatus").textContent = `操作失败：${message}`;
    return;
  }
  if (actionGroup(action) === "stickers") {
    $("stickerStatus").textContent = `操作失败：${message}`;
    return;
  }
  setOutput(operationOutputId(action), `操作失败：${message}`, true);
}

function formatOperationResult(result) {
  const snapshot = result?.snapshot || {};
  const status = snapshot.status || {};
  const lines = [result?.message || "操作完成"];
  if (status.status) lines.push(`Bridge：${status.status === "ok" ? "在线" : status.status}`);
  if (status.version) lines.push(`版本：${status.version}`);
  if (status.process?.pid) lines.push(`PID：${status.process.pid}`);
  if (result?.path || result?.logsDir) lines.push(`位置：${result.path || result.logsDir}`);
  return lines.join("\n");
}

function formatMemeOperationResult(action, result) {
  const snapshot = result?.snapshot || {};
  const lines = [ACTION_DONE[action] || result?.message || "梗库操作完成"];
  if (Array.isArray(snapshot.entries)) lines.push(`当前词条：${snapshot.entries.length}`);
  if (action === "runMemeWebUpdate" && result.result) {
    lines.push(`新增 ${result.result.accepted || 0} · 更新 ${result.result.updated || 0} · 审核 ${result.result.reviewed || 0}`);
  }
  if (action === "rollbackMemeWebUpdate" && result.result) {
    lines.push(`已恢复 ${result.result.restored || 0} 个词条`);
  }
  return lines.join("\n");
}

function formatDiagnoseResult(result) {
  if (!result || typeof result !== "object") {
    return { summary: String(result || "诊断没有返回结果"), raw: String(result || "") };
  }
  const lines = [];
  const allowed = result.gates?.allowed ?? result.allowed ?? result.ok ?? result.shouldReply;
  if (allowed !== undefined) lines.push(`结果：${allowed ? "可以进入回复链路" : "不会触发回复"}`);
  if (result.mentions) lines.push(`@机器人：${result.mentions.isAtMe ? "已识别" : "未识别"}`);
  if (result.command?.known) lines.push(`识别命令：${result.command.normalized || "已识别"}`);
  if (result.replyPlan?.action) lines.push(`处理方式：${replyPlanLabel(result.replyPlan.action)}`);
  const blocked = result.gates?.blockedReasons || [];
  if (blocked.length) lines.push(`阻断原因：${blocked.join("、")}`);
  else if (result.reason || result.reasonText) lines.push(`原因：${result.reasonText || result.reason}`);
  if (result.route) lines.push(`处理路径：${result.route}`);
  if (result.suggestion) lines.push(`建议：${result.suggestion}`);
  return {
    summary: lines.length ? lines.join("\n") : "诊断已完成，技术详情中有完整结果。",
    raw: JSON.stringify(result, null, 2),
  };
}

function renderDiagnoseSummary(summary) {
  const lines = String(summary || "").split("\n").filter(Boolean);
  $("diagnoseOutput").innerHTML = lines.map((line) => {
    const splitAt = line.indexOf("：");
    const label = splitAt >= 0 ? line.slice(0, splitAt) : "检查";
    const value = splitAt >= 0 ? line.slice(splitAt + 1) : line;
    const bad = /(不会|未识别|拦截|阻断|失败|不可)/.test(value);
    const warn = !bad && /(忽略|等待|建议)/.test(value);
    return `<div class="diagnose-check${bad ? " bad" : warn ? " warn" : ""}"><i>${bad ? "!" : warn ? "·" : "✓"}</i><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`;
  }).join("");
}

function replyPlanLabel(action) {
  return ({
    command_reply: "直接返回命令结果",
    ai_reply: "进入模型回复",
    ignore: "忽略这条消息",
    blocked: "被规则拦截",
  })[action] || action;
}

function canLeaveCurrentView(nextView) {
  if (nextView === currentView) return true;
  if (currentView === "configuration" && configDirty) {
    const leave = window.confirm("配置有未保存修改。确定离开并放弃这些修改吗？");
    if (leave) renderConfigEditor(lastConfigSnapshot, { force: true });
    return leave;
  }
  if (currentView === "memes" && memeDirty) {
    const leave = confirmDiscardMemeChanges();
    if (leave) {
      const selected = (memeSnapshot.entries || []).find((item) => item.name === lastEntrySelection);
      if (selected) fillMemeForm(selected);
    }
    return leave;
  }
  return true;
}

function showView(view) {
  if (!PAGE_META[view]) return;
  if (!canLeaveCurrentView(view)) return;
  currentView = view;
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

  if (view === "memes" && !memesLoaded) runAction("refreshMemes", null, { silent: true });
  if (view === "stickers" && !stickersLoaded) runAction("refreshStickers", null, { silent: true });
  if (view === "capabilities" && !capabilitiesLoaded) runAction("refreshCapabilities", null, { silent: true });
  if (view === "api-center" && !apiProvidersLoaded) runAction("refreshApiProviders", null, { silent: true });
  if (view === "configuration" && !lastConfigSnapshot.editable) runAction("refreshConfig", null, { silent: true });
  if (view === "logs" && !logsLoaded) runAction("refreshLogs", null, { silent: true });
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
    selectedStickerId = stickerTile.dataset.stickerId;
    renderStickers(stickerSnapshot, { selectId: selectedStickerId });
    return;
  }
  const apiProvider = event.target.closest("[data-api-provider]");
  if (apiProvider) {
    selectedApiProviderId = apiProvider.dataset.apiProvider;
    renderApiProviders(apiSnapshot, { selectId: selectedApiProviderId });
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
    logFollow = !logFollow;
    logAction.classList.toggle("active", logFollow);
    logAction.textContent = logFollow ? "停止跟随" : "跟随最新";
    if (logFollow) $("logsOutput").scrollTop = $("logsOutput").scrollHeight;
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
    stickerFilter = event.target.value;
    selectedStickerId = "";
    renderStickers(stickerSnapshot);
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
    $("diagText").value = privateMode ? "help" : `@${lastStatus.config?.botNames?.[0] || "夜星"} help`;
    return;
  }
  if (event.target.id === "blurStrength") {
    saveUiPreferences({ blur: Number(event.target.value) });
    return;
  }
  if (event.target.id === "memeSelect") {
    if (!confirmDiscardMemeChanges()) {
      event.target.value = lastEntrySelection;
      return;
    }
    memeSelectionMode = "entry";
    lastEntrySelection = event.target.value;
    const entry = (memeSnapshot.entries || []).find((item) => item.name === event.target.value);
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
  try {
    await host.call("ready");
    const [background, snapshot] = await Promise.all([
      host.call("getBackground"),
      host.call("refresh"),
    ]);
    applyBackground(background);
    renderSnapshot(snapshot);
  } catch (error) {
    $("subtitle").textContent = "主页已打开，但 Bridge 暂不可用。";
    markStatusStale("首次刷新失败，点总览中的刷新重试");
    toast(error.message || "Bridge 暂不可用", "error");
  }
});

async function quietRefresh() {
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
