function sanitizeLogNickname(value) {
  return String(value || "群友").replace(/\[|\]/g, "").slice(0, 40);
}

function sanitizeLogText(value) {
  return String(value || "[非文本消息]").replace(/\s+/g, " ").trim().slice(0, 220);
}

export function formatSummaryLines(messages) {
  return messages.map(m => {
    const time = new Date(Number(m.ts)).toLocaleTimeString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    });
    return `[${time}] ${sanitizeLogNickname(m.nickname)}: ${sanitizeLogText(m.text)}`;
  }).join("\n");
}
