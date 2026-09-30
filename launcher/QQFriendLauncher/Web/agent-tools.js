const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim() ? value : "";
const sharedLimits = [["模型轮次上限", "modelRounds"], ["工具调用上限", "toolCalls"],
  ["任务时限", "durationMs"], ["传输尝试上限", "transportAttempts"]];
const compatibilityLabels = { verified: "已验证", incompatible: "不兼容", unsupported: "不支持" };
const accessLabels = {
  current_scope: "当前会话权限（含获准私聊）", public_query: "本条公开关键词（按当前会话权限）",
  agent_group: "Agent 群白名单", agent_public_source: "本轮授权公开来源（Agent 群白名单）",
};

function groupWhitelist(groups) {
  if (!Array.isArray(groups) || groups.some(group =>
    !(typeof group === "string" && /^[1-9]\d{0,19}$/.test(group) ||
      Number.isSafeInteger(group) && group > 0))) return "未知";
  return groups.length ? [...new Set(groups.map(String))].join("、") : "未开放（空白名单）";
}

/**
 * Parent-owned snapshot: { tools: [{ name, label, mode, available, access }],
 * limits: { modelRounds, toolCalls, durationMs, transportAttempts },
 * rollout: { groups: Array<string | number>, mentionedOnly: true, privateEnabled: false },
 * compatibility: { status: "unknown" | "verified" | "incompatible" | "unsupported" } }.
 * available must be boolean; read/readonly/read_only modes render as read-only.
 * No defaults, config inference or I/O. The parent owns fetching and routing.
 * Returns the rendered section; remounting replaces only the supplied container.
 */
export function mountAgentTools(container, snapshot) {
  if (!container?.ownerDocument || typeof container.replaceChildren !== "function") {
    throw new TypeError("Agent tools require a DOM container");
  }
  const document = container.ownerDocument;
  const data = isRecord(snapshot) ? snapshot : {};
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const panel = element("section", undefined, "agent-tools");
  panel.setAttribute("aria-label", "有限工具状态");
  const heading = element("div", undefined, "section-head");
  heading.append(element("h3", "有限工具"));
  panel.append(heading);
  const notice = element("p", isRecord(snapshot)
    ? "服务端状态快照（非 API 调用验证）" : "尚未读取工具状态", "diagnostic-notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-label", `有限工具状态：${notice.textContent}`);
  panel.append(notice);
  if (!isRecord(snapshot)) {
    container.replaceChildren(panel);
    return panel;
  }

  const rows = element("dl", undefined, "memory-facts agent-tools-rows");
  rows.setAttribute("aria-label", "工具权限、可用状态与共享预算");
  const row = (label, value, title = label) => {
    const term = element("dt", label, "agent-tool-label");
    term.setAttribute("title", title);
    term.setAttribute("aria-label", title);
    const detail = element("dd", value);
    detail.setAttribute("aria-label", `${title}：${value}`);
    rows.append(term, detail);
  };
  row("新增工具范围", data.rollout?.mentionedOnly === true ? "主动@ · 灰度群" : "未知");
  row("灰度群白名单", groupWhitelist(data.rollout?.groups));
  const status = data.compatibility?.status;
  row("原生工具兼容性", typeof status === "string" && Object.hasOwn(compatibilityLabels, status)
    ? compatibilityLabels[status] : "尚未验证");

  const tools = data.tools;
  if (!Array.isArray(tools) || tools.some(tool => !isRecord(tool) || !text(tool.name))) {
    row("工具清单", "未知");
  } else if (!tools.length) {
    row("工具清单", "服务端未列出工具");
  } else {
    for (const tool of tools) {
      const label = text(tool.label) || tool.name;
      const mode = ["read", "readonly", "read_only"].includes(tool.mode) ? "只读" : "模式未知";
      const availability = tool.available === true ? "服务端标记可用" : tool.available === false ? "不可用" : "未知";
      const access = typeof tool.access === "string" && Object.hasOwn(accessLabels, tool.access)
        ? accessLabels[tool.access] : "权限范围未知";
      row(label, `${mode} · ${availability} · ${access}`, `${label}（${tool.name}）`);
    }
  }

  const limits = isRecord(data.limits) ? data.limits : {};
  for (const [label, key] of sharedLimits) {
    const value = limits[key];
    const display = Number.isSafeInteger(value) && value >= 0
      ? key === "durationMs" ? `${value / 1000} 秒` : String(value) : "未知";
    row(label, display, `共享预算 · ${label}`);
  }
  panel.append(rows);
  container.replaceChildren(panel);
  return panel;
}
