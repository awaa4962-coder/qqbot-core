export function buildRuntimeText(runtime = {}) {
  const uptime = Number(runtime.uptime ?? process.uptime());
  const memory = runtime.memory ?? process.memoryUsage().rss;
  return [
    "夜星运行状态",
    "状态：正常",
    "运行时长：" + formatUptime(uptime),
    "内存占用：" + Math.round(memory / 1024 / 1024) + " MB",
  ].join("\n");
}

function formatUptime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  if (value >= 86400) return Math.floor(value / 86400) + " 天 " + Math.floor((value % 86400) / 3600) + " 小时";
  if (value >= 3600) return Math.floor(value / 3600) + " 小时 " + Math.floor((value % 3600) / 60) + " 分钟";
  if (value >= 60) return Math.floor(value / 60) + " 分钟 " + (value % 60) + " 秒";
  return value + " 秒";
}
