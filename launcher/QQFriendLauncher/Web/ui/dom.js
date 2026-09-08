

export const $ = (id) => document.getElementById(id);

export const fmt = new Intl.NumberFormat("zh-CN");

export function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function formatBytes(value) {
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

export function formatSeconds(value) {
  const seconds = Math.max(0, Number(value || 0));
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} 天`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)} 分钟`;
  return `${seconds.toFixed(0)} 秒`;
}

export function setOutput(id, value, expanded = true) {
  const node = $(id);
  node.textContent = value;
  node.classList.toggle("has-content", expanded);
}

export function splitList(value) {
  const raw = Array.isArray(value) ? value.join(" ") : String(value || "");
  return raw.split(/[\s,;，；、]+/).map((item) => item.trim()).filter(Boolean);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
