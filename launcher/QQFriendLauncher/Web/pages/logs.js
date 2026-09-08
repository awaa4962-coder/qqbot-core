import { $, fmt } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function renderLogs(logs) {
  uiState.logLines = logs.current && Array.isArray(logs.current.lines) ? logs.current.lines : [];
  applyLogFilter();
}

export function applyLogFilter() {
  const query = $("logFilter").value.trim().toLocaleLowerCase("zh-CN");
  const level = $("logLevel")?.value || "all";
  const module = $("logModule")?.value || "all";
  const filtered = uiState.logLines.filter((line) => {
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
  if (uiState.logFollow) $("logsOutput").scrollTop = $("logsOutput").scrollHeight;
}
