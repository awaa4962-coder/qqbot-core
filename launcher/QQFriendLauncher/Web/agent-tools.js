const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim() ? value : "";
const sharedLimits = [["模型轮次上限", "modelRounds"], ["工具调用上限", "toolCalls"],
  ["任务时限", "durationMs"], ["传输尝试上限", "transportAttempts"]];
const compatibilityLabels = {
  unknown: "尚未验证", verified: "已验证", partial: "部分验证", failed: "验证失败",
  unsupported: "不支持", pending: "验证结果未确认", unavailable: "不可用",
};
const reasonLabels = {
  native_tools_not_declared: "未声明原生工具支持", protocol_not_supported: "协议不支持原生工具",
  provider_not_configured: "未配置模型服务", tool_call_missing: "未返回有效工具调用",
  no_native_call: "未调用原生工具", direct_answer_expected: "直接回答，未调用工具",
  invalid_response_envelope: "模型响应结构异常", invalid_call_envelope: "工具调用结构异常",
  multiple_calls: "返回了多次工具调用", invalid_arguments: "工具参数格式异常",
  expression_mismatch: "未计算指定表达式", truncated_response: "模型响应截断，未通过完整验证",
  tool_arguments: "工具参数不符", unexpected_tool: "返回了非预期工具",
  tool_result_wrong: "工具结果不符", reply_unusable: "验证回复不可用", wrong_answer: "验证答案不符",
  wrongargs: "工具参数不符", configuration_changed: "配置已变化",
  transport_unavailable: "验证连接不可用", too_budget: "验证预算超限",
  claim_busy: "验证任务占用", proof_unavailable: "验证证据不可用",
  cancelled: "验证已取消", probe_deadline: "验证超时", probe_budget: "验证预算超限",
  result_budget: "工具结果超限", proof_persistence_failed: "验证结果保存失败",
  malformed_state: "验证记录格式异常", probe_pending: "验证结果未确认", expired: "验证证据已过期",
};
const slotLabels = [["primary", "主模型"], ["fallback", "备用模型"]];
const accessLabels = {
  current_scope: "当前会话权限（含获准私聊）", public_query: "本条公开关键词（按当前会话权限）",
  agent_group: "Agent 群白名单", agent_public_source: "本轮授权公开来源（Agent 群白名单）",
  agent_attachment: "本轮附件引用（附件工具群）", agent_draft: "本人当前群草稿（草稿工具群）",
  agent_personal: "本人当前群资料草稿（需要本人另发确认，非管理员权限）",
  agent_reminder: "本人当前群提醒草稿（需要本人另发确认，非管理员权限）",
  agent_actions: "本人当前群确认与提醒状态（只读，非管理员权限）",
};

function groupWhitelist(groups) {
  if (!Array.isArray(groups) || groups.some(group =>
    !(typeof group === "string" && /^[1-9]\d{0,19}$/.test(group) ||
      Number.isSafeInteger(group) && group > 0))) return "未知";
  return groups.length ? [...new Set(groups.map(String))].join("、") : "未开放（空白名单）";
}

function compatibilityStatus(value, provenance) {
  const status = typeof value === "string" && Object.hasOwn(compatibilityLabels, value) ? value : "unknown";
  return provenance === "qa" || ["verified", "partial"].includes(status) && provenance !== "live" ? "unknown" : status;
}

function compatibilityReason(value, provenance) {
  return provenance !== "qa" && typeof value === "string" && Object.hasOwn(reasonLabels, value) ? reasonLabels[value] : "";
}

function proofTime(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
}

function modelLabel(value) {
  const label = text(value).trim();
  const hasControl = [...label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  return label.length <= 80 && !hasControl &&
    !/[a-z][a-z\d+.-]*:\/\/|www\.|\b(?:sk-|Bearer\s|api[_-]?key|configurationRevision)|\b[a-f\d]{64}\b/i.test(label)
    ? label || "模型未知" : "模型未知";
}

function compatibilityView(value) {
  const data = isRecord(value) ? value : {};
  const now = Date.now();
  const supplied = Array.isArray(data.slots) && data.slots.length <= 2 && Array.from(data.slots).every(slot =>
    isRecord(slot) && slotLabels.some(([position]) => slot.position === position)) &&
    new Set(data.slots.map(slot => slot.position)).size === data.slots.length ? data.slots : [];
  const slots = slotLabels.map(([position, label]) => {
    const slot = supplied.find(item => item.position === position);
    let status = compatibilityStatus(slot?.status, data.provenance);
    const model = modelLabel(slot?.model);
    const checkedAt = proofTime(slot?.checkedAt);
    const expiresAt = proofTime(slot?.expiresAt);
    const expired = Number.isFinite(expiresAt) && expiresAt <= now;
    if (expired || status === "verified" && (model === "模型未知" ||
      !Number.isFinite(checkedAt) || checkedAt > now || !Number.isFinite(expiresAt) || expiresAt <= checkedAt)) {
      status = "unknown";
    }
    return { label, model, status, expired, reason: compatibilityReason(slot?.reason, data.provenance) };
  });
  let status = compatibilityStatus(data.status, data.provenance);
  // An aggregate claim cannot override missing, stale or contradictory slot evidence.
  if (status === "verified" && !slots.every(slot => slot.status === "verified")) {
    status = ["failed", "unsupported", "partial", "pending", "unavailable"].find(candidate =>
      slots.some(slot => slot.status === candidate)) || "unknown";
  }
  return { status, slots, reason: compatibilityReason(data.reason, data.provenance) };
}

export function hasVerifiedNativeTools(value) {
  return compatibilityView(value).status === "verified";
}

/**
 * Parent-owned snapshot: { tools: [{ name, label, mode, available, access }],
 * limits: { modelRounds, toolCalls, durationMs, transportAttempts },
 * rollout: { groups: Array<string | number>, mentionedOnly: true, privateEnabled: false },
 * compatibility: { status: "unknown" | "verified" | "partial" | "failed" | "unsupported" | "pending" | "unavailable",
 * slots: [{ position: "primary" | "fallback", model: sanitizedLabel, status, reason, checkedAt, expiresAt, attempts }],
 * provenance: "live" | "qa", probeAllowed: boolean, requestLimit: 4 } }.
 * Only live provenance can provide positive proof or enable the parent-owned probe command.
 * QA records always project as unknown, even with fresh verified slots.
 * Proof timestamps are epoch milliseconds or ISO strings; verified slots need current evidence.
 * The parent binds proof to the current actual model, protocol, key, schema and mode before projection.
 * This renderer cannot validate that identity or infer proof coverage across modes.
 * Compatibility is management evidence, not a per-chat or runtime authorization gate.
 * Expiry only downgrades this view; tool availability, groups and parameters remain parent-owned.
 * Pending records do not imply a live process; the parent owns paid confirmation and task progress.
 * Only model labels, fixed statuses and allowlisted reason labels render; raw reasons and identity stay parent-owned.
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
  const probe = element("button", "验证工具");
  probe.type = "button";
  probe.dataset.action = "probeAgentTools";
  probe.disabled = !isRecord(data.compatibility) || data.compatibility.provenance !== "live" ||
    data.compatibility.probeAllowed !== true;
  probe.setAttribute("title", "最多4次模型请求，不发送QQ消息");
  heading.append(probe);
  panel.append(heading);
  const notice = element("p", !isRecord(snapshot) ? "尚未读取工具状态" : data.compatibility?.provenance === "qa"
    ? "非生产验证快照（不作为当前配置证明）" : "服务端状态快照（非 API 调用验证）", "diagnostic-notice");
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
  if (Object.hasOwn(data.rollout || {}, "materialGroups")) row("附件工具群", groupWhitelist(data.rollout.materialGroups));
  if (Object.hasOwn(data.rollout || {}, "draftGroups")) row("草稿工具群", groupWhitelist(data.rollout.draftGroups));
  if (Object.hasOwn(data.rollout || {}, "writeGroups")) row("本人设置工具群", groupWhitelist(data.rollout.writeGroups));
  if (Object.hasOwn(data.rollout || {}, "reminderGroups")) row("提醒工具群", groupWhitelist(data.rollout.reminderGroups));
  const compatibility = compatibilityView(data.compatibility);
  row(data.compatibilityCoverage?.scope === "core" ? "基础工具协议兼容性" : "原生工具兼容性", `${compatibilityLabels[compatibility.status]}${compatibility.reason ? ` · ${compatibility.reason}` : ""}`);
  for (const slot of compatibility.slots) {
    row(slot.label, `${slot.model} · ${compatibilityLabels[slot.status]}${slot.expired ? "（已过期）" : ""}${slot.reason ? ` · ${slot.reason}` : ""}`);
  }

  const tools = data.tools;
  if (!Array.isArray(tools) || tools.some(tool => !isRecord(tool) || !text(tool.name))) {
    row("工具清单", "未知");
  } else if (!tools.length) {
    row("工具清单", "服务端未列出工具");
  } else {
    for (const tool of tools) {
      const label = text(tool.label) || tool.name;
      const mode = ["read", "readonly", "read_only"].includes(tool.mode) ? "只读" : tool.mode === "draft" ? "草稿" : tool.mode === "task" ? "状态/取消" : "模式未知";
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
