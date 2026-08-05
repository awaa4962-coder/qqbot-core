function sanitizeLogNickname(value) {
  return redactSummaryText(String(value || "群友").replace(/\[|\]/g, "")).slice(0, 40);
}

function sanitizeLogText(value) {
  return redactSummaryText(value || "[非文本消息]").replace(/\s+/g, " ").trim().slice(0, 220);
}

export function formatSummaryLines(messages, options = {}) {
  return messages.map((m, index) => {
    const time = new Date(Number(m.ts)).toLocaleTimeString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    });
    const prefix = options.evidenceIds === true ? `证据${String(index + 1).padStart(3, "0")} ` : "";
    return `[${prefix}${time}] ${sanitizeLogNickname(m.nickname)}: ${sanitizeLogText(m.text)}`;
  }).join("\n");
}

export function redactSummaryText(value) {
  return String(value || "")
    .replace(/\[CQ:at,qq=(?:all|\d+)[^\]]*\]/gi, "@群友")
    .replace(/\[CQ:[^\]]+\]/gi, "[QQ消息片段]")
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: [凭据已隐藏]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, "[密钥已隐藏]")
    .replace(/(?:api[_-]?key|token|secret|password|passwd|密码|密钥)\s*[:=：]\s*[^\s，。；;]+/gi, "[凭据已隐藏]")
    .replace(/https?:\/\/\S+/gi, "[链接已隐藏]")
    .replace(/(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?::\d{1,5})?/g, "[地址已隐藏]")
    .replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?\b/g, "[地址已隐藏]")
    .replace(/\b[1-9]\d{5,17}\b/g, "[编号已隐藏]");
}
