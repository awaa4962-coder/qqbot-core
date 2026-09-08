import { moduleLabel, renderConfig, renderConfigEditor } from "./configuration.js";
import { renderLogs } from "./logs.js";
import { groupIsBusy } from "../ui/activity.js";
import { $, escapeHtml, fmt, formatBytes, formatSeconds, setOutput, text } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function setMetric(id, value, detail, tone = "") {
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

export function renderStatus(status) {
  if (!status || typeof status !== "object") return false;
  const statusTime = Date.parse(status.generatedAt || "") || Date.now();
  if (uiState.latestStatusTime && statusTime < uiState.latestStatusTime) return false;
  uiState.latestStatusTime = statusTime;
  const previousBridgeOnline = uiState.lastBridgeOnline;
  uiState.lastStatus = status;

  const config = status.config || {};
  const storage = status.storage || {};
  const process = status.process || {};
  const storm = status.storm || {};
  const cognition = status.modules?.cognition || {};
  const moduleHealth = status.moduleHealth || {};
  const degradedModules = Array.isArray(moduleHealth.degraded) ? moduleHealth.degraded : [];
  const ok = status.status === "ok";
  const stopped = !ok && uiState.bridgeIntentionallyStopped;
  uiState.lastBridgeOnline = ok;
  if (ok) uiState.bridgeIntentionallyStopped = false;

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
  } else if (degradedModules.length > 0) {
    const names = degradedModules.map(moduleLabel).join("、");
    notice.classList.add("warn");
    notice.innerHTML = `<strong>部分模块需要处理</strong><span>${escapeHtml(names)} 当前处于降级状态，可到“服务”或“诊断”页查看详情。</span>`;
  } else if (dropped > 0) {
    notice.classList.add("warn");
    notice.innerHTML = `<strong>消息保护已介入</strong><span>本轮丢弃 ${fmt.format(dropped)} 个事件，可到日志页查看原因。</span>`;
  } else {
    notice.classList.add("ok");
    notice.innerHTML = "<strong>所有核心服务正常</strong><span>没有需要立即处理的问题。</span>";
  }

  renderConfig(status, uiState.lastConfigSnapshot);
  syncRuntimeTransition(previousBridgeOnline, ok, status);
  return true;
}

export function renderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (snapshot.config) {
    uiState.lastConfigSnapshot = snapshot.config;
    renderConfigEditor(snapshot.config);
  }
  if (snapshot.status) renderStatus(snapshot.status);
  if (snapshot.logs) {
    renderLogs(snapshot.logs);
    uiState.logsLoaded = true;
  }
}

export function markStatusStale(message) {
  if (uiState.bridgeIntentionallyStopped) {
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

export function renderStoppedStatus(generatedAt = new Date().toISOString()) {
  uiState.bridgeIntentionallyStopped = true;
  const status = {
    ...uiState.lastStatus,
    status: "offline",
    generatedAt,
    process: {
      ...(uiState.lastStatus.process || {}),
      pid: null,
      uptime: 0,
      rss: 0,
    },
    storm: {
      ...(uiState.lastStatus.storm || {}),
      processingCount: 0,
    },
  };
  renderStatus(status);
  uiState.bridgeIntentionallyStopped = true;
  $("lastUpdated").textContent = `已停止 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export function syncRuntimeTransition(previousOnline, online, status) {
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
