import { $, escapeHtml } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function stripConfiguredMention(raw) {
  const names = Array.isArray(uiState.lastStatus.config?.botNames) && uiState.lastStatus.config.botNames.length
    ? uiState.lastStatus.config.botNames
    : ["夜星"];
  let clean = raw.trim();
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clean = clean.replace(new RegExp(`^@?${escaped}\\s*`, "i"), "").trim();
  }
  return clean || raw.trim();
}

export function diagnosePayload() {
  const messageType = $("diagType")?.value === "private" ? "private" : "group";
  const groupId = Number($("diagGroup").value.trim());
  const userId = Number($("diagUser").value.trim());
  if (messageType === "group" && (!Number.isSafeInteger(groupId) || groupId <= 0)) throw new Error("群号格式不正确。");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("QQ 号格式不正确。");
  const clean = stripConfiguredMention($("diagText").value);
  const selfUin = String(uiState.lastStatus.config?.selfUin || "1000000001");
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

export function formatDiagnoseResult(result) {
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

export function renderDiagnoseSummary(summary) {
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

export function replyPlanLabel(action) {
  return ({
    command_reply: "直接返回命令结果",
    ai_reply: "进入模型回复",
    ignore: "忽略这条消息",
    blocked: "被规则拦截",
  })[action] || action;
}
