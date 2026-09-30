import { $, fmt } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

// Match the log reader's tail limit; keep only one validated snapshot.
const MAX_LOG_LINES = 1000;
const logsState = { phase: "unread", hasSnapshot: false, error: "" };
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function setLogsLoading() {
  logsState.phase = "loading";
  uiState.logsLoaded = false;
  applyLogFilter();
}

export function logsReadFailed(error) {
  const denied = [401, 403].includes(Number(error?.status));
  logsState.phase = "error";
  uiState.logsLoaded = false;
  if (denied) {
    uiState.logLines = [];
    logsState.hasSnapshot = false;
  }
  logsState.error = denied
    ? "无权读取日志，请重新认证后刷新；已清除缓存日志。"
    : `日志读取失败：${error?.message || (typeof error === "string" ? error : "暂不可用")}；请刷新重试。`;
  applyLogFilter();
}

export function renderLogs(logs) {
  const current = isRecord(logs) ? logs.current : null;
  const lines = isRecord(current) && Array.isArray(current.lines) && current.lines.length <= MAX_LOG_LINES
    ? Array.from(current.lines) : null;
  // Older desktop/UI callers may omit metadata, but supplied metadata must be valid.
  if (!lines || lines.some(line => typeof line !== "string") ||
      Object.hasOwn(logs, "error") || (Object.hasOwn(logs, "ok") && logs.ok !== true) ||
      (Object.hasOwn(logs, "files") && !Array.isArray(logs.files)) ||
      (Object.hasOwn(current, "count") && (!Number.isSafeInteger(current.count) || current.count !== lines.length)) ||
      (Object.hasOwn(current, "truncated") && typeof current.truncated !== "boolean") ||
      (Object.hasOwn(current, "file") && !(current.file === null || (typeof current.file === "string" && current.file.length > 0))) ||
      (current.file === null && lines.length > 0)) {
    const error = Object.assign(new Error("日志响应不完整或格式错误，请刷新重试。"), { responseInvalid: true });
    logsReadFailed(error);
    throw error;
  }
  uiState.logLines = lines;
  uiState.logsLoaded = true;
  logsState.hasSnapshot = true;
  logsState.phase = "ready";
  logsState.error = "";
  applyLogFilter();
}

export function applyLogFilter() {
  const query = ($("logFilter")?.value || "").trim().toLocaleLowerCase("zh-CN");
  const level = $("logLevel")?.value || "all";
  const module = $("logModule")?.value || "all";
  const lines = logsState.hasSnapshot ? uiState.logLines : [];
  const filtered = lines.filter((line) => {
    const normalized = line.toLocaleLowerCase("zh-CN");
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
  const ready = logsState.phase === "ready";
  const stale = logsState.hasSnapshot && !ready;
  const state = ready ? (lines.length === 0 ? "empty" : filtered.length > 0 ? "ready" : "no-match") : logsState.phase;
  const notices = [];
  if (logsState.phase === "unread") notices.push("日志尚未读取，请刷新日志。");
  if (logsState.phase === "loading") {
    notices.push("正在读取日志…");
    if (logsState.error) notices.push(`上次${logsState.error}`);
  }
  if (logsState.phase === "error") notices.push(logsState.error);
  if (stale) notices.push("以下为上次快照（已过期），非最新日志。");
  if (logsState.hasSnapshot) {
    notices.push(filtered.length > 0 ? filtered.join("\n") : lines.length > 0
      ? "没有匹配的日志" : stale ? "上次快照为空；当前日志状态未知。" : "暂无日志");
  }

  const output = $("logsOutput");
  if (output) {
    output.textContent = notices.join("\n");
    output.dataset.state = state;
    output.dataset.stale = String(stale);
    output.setAttribute("aria-busy", String(logsState.phase === "loading"));
    if (ready && uiState.logFollow && filtered.length > 0) output.scrollTop = output.scrollHeight;
  }
  const count = $("logCount");
  if (count) {
    const total = fmt.format(lines.length);
    count.textContent = logsState.hasSnapshot
      ? `${fmt.format(filtered.length)}${filtered.length === lines.length ? "" : ` / ${total}`} 条${stale ? "（过期快照）" : ""}`
      : logsState.phase === "loading" ? "读取中" : logsState.phase === "error" ? "读取失败" : "未读取";
    count.dataset.state = state;
    count.dataset.stale = String(stale);
  }
  const follow = $("logFollowButton");
  if (follow) {
    follow.disabled = !ready;
    follow.classList.toggle("active", ready && uiState.logFollow);
    follow.textContent = uiState.logFollow ? (ready ? "停止跟随" : "跟随暂停") : "跟随最新";
    follow.title = ready ? "滚动到当前日志快照底部；不会自动刷新日志。" : "等待有效日志响应后恢复跟随。";
  }
}
