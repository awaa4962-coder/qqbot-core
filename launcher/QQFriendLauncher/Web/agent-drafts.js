const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_TASKS = 100;
const MAX_TEXT = 32768;
const actions = { daily: "日报草稿", conversation: "对话总结草稿" };
const phases = {
  queued: "排队中", collecting: "收集中", analyzing: "分析中", fallback: "备用处理中",
  overdue: "已超时，等待收尾", cancelling: "取消中", cancelled: "已取消",
  done: "已完成", failed: "失败", interrupted: "已中断",
};
const active = new Set(["queued", "collecting", "analyzing", "fallback", "overdue", "cancelling"]);
const errors = {
  invalid_arguments: "参数无效", not_allowed: "未获授权", target_not_allowed: "目标未获授权",
  invalid_date: "日期无效", guard_unavailable: "安全检查不可用", model_callback_required: "模型接口不可用",
  cancelled: "取消请求已处理", permission_changed: "权限已变化", privacy_changed: "隐私设置已变化",
  stale_request: "请求已失效", budget_exceeded: "任务预算超限", no_records: "无可用记录",
  model_unavailable: "模型不可用", unsafe_service_result: "结果未通过安全检查", business_unavailable: "业务不可用",
  draft_failed: "草稿未完成", interrupted: "任务已中断",
};
const counts = [["captured", "采集记录"], ["selected", "选中记录"], ["background", "背景记录"],
  ["targetCount", "目标数量"], ["missingTargets", "缺失目标"], ["malformed", "异常记录"]];
const flags = [["complete", "完整覆盖"], ["partial", "部分覆盖"], ["sampled", "已抽样"], ["capped", "已达上限"]];
const known = (labels, value) => typeof value === "string" && Object.hasOwn(labels, value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402271999999;
const timeLabel = value => timestamp(value)
  ? new Date(value + 28800000).toISOString().slice(0, 19).replace("T", " ") : "未知";

export function isAgentDraftTaskId(value) {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export function isAgentDraftTerminalPhase(value) {
  return known(phases, value) && !active.has(value);
}

function jobView(value) {
  const id = own(value, "id");
  const action = own(value, "action");
  const phase = own(value, "phase");
  const startedAt = own(value, "startedAt");
  const finishedAt = own(value, "finishedAt");
  const resultAvailable = own(value, "resultAvailable");
  const valid = isAgentDraftTaskId(id) && known(actions, action) && known(phases, phase) &&
    timestamp(startedAt) && (finishedAt === undefined || timestamp(finishedAt) && finishedAt >= startedAt) &&
    typeof resultAvailable === "boolean" && !(active.has(phase) && finishedAt !== undefined);
  return { id: valid ? id : undefined, action: known(actions, action) ? action : undefined,
    phase: valid ? phase : undefined, startedAt: valid ? startedAt : undefined,
    finishedAt: valid ? finishedAt : undefined, resultAvailable: valid ? resultAvailable : undefined,
    error: own(value, "error"), valid };
}

function snapshotView(value) {
  const status = own(value, "status");
  const enabled = own(value, "enabled");
  const tasks = own(value, "tasks");
  if (status !== "ready" || typeof enabled !== "boolean" || !Array.isArray(tasks) || tasks.length > MAX_TASKS) {
    return { ready: false, enabled, notice: status === "unavailable" ? "状态无法读取" : "状态未知" };
  }
  // Never consult a list entry's body. Only the separately selected task may carry a result.
  const jobs = Array.from(tasks, jobView);
  const ids = jobs.filter(job => job.valid).map(job => job.id.toLowerCase());
  if (new Set(ids).size !== ids.length) return { ready: false, enabled, notice: "任务列表未知" };
  return { ready: true, enabled, jobs, selected: own(value, "task"), notice: "服务端任务状态" };
}

function errorLabel(value) {
  if (value === undefined || value === "") return "";
  return known(errors, value) ? errors[value] : "错误未知";
}

function safeDraft(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) return false;
  const normalized = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const hiddenControl = [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 && ![9, 10, 13].includes(code) || code >= 127 && code <= 159 ||
      code >= 8203 && code <= 8207 || code >= 8234 && code <= 8238 || code >= 8288 && code <= 8303 || code === 65279;
  });
  if (hiddenControl) return false;
  // Fail closed for uncleaned envelopes, reasoning, credentials and local paths, including late text.
  const unsafe = [
    /<\/?(?:think|thinking|analysis|reasoning)\b|<\|(?:channel|im_start|im_end)\|>|\breasoning[_-]content\b/i,
    /\b(?:analysis|reasoning|thinking|chain[ ._-]of[ ._-]thought)\s*[:=]|```(?:analysis|reasoning|thinking)\b|["'](?:choices|raw|body|messages)["']\s*:/i,
    /\b(?:sk|rk|pk|ghp|github_pat)[-_][\w-]{6,}|\b(?:Basic|Bearer|Digest)\s+\S+|-----BEGIN [\w ]*PRIVATE KEY-----/i,
    /\b(?:api[ _-]?key|access[_-]?token|refresh[_-]?token|token|key|authorization|password|secret|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]/i,
    /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/,
    /\b[A-Za-z]:[\\/]|\\\\[^\s]+|\bfile:\/\/|(?:^|[\s"'(:=：])(?:\/|~\/|\.{1,2}\/)[^\s<]+/m,
    /https?:\/\/[^\s/]+@|[?&](?:key|token|api[_-]?key|access[_-]?token|password|secret)=/i,
  ];
  return !unsafe.some(pattern => pattern.test(normalized)) && !["[", "{"].includes(normalized.trimStart()[0]);
}

function resultView(view) {
  if (!view.ready || view.selected === undefined) return { notice: "尚未载入草稿" };
  const job = jobView(view.selected);
  const listed = view.jobs.find(item => item.valid && job.valid && item.id.toLowerCase() === job.id.toLowerCase());
  const result = own(view.selected, "result");
  if (!job.valid || job.phase !== "done" || job.resultAvailable !== true || listed?.phase !== "done" ||
      listed.resultAvailable !== true || listed.action !== job.action || listed.startedAt !== job.startedAt ||
      own(result, "sent") !== false || own(result, "persisted") !== false || !safeDraft(own(result, "text"))) {
    return { notice: "结果未知" };
  }
  return { notice: "草稿 · 未发送 · 未落盘", text: own(result, "text"), coverage: own(result, "coverage") };
}

// Controller validation shares the renderer's job/result rules but rejects partial DTOs.
export function validateAgentDraftSnapshot(snapshot, { id, requireResult = false } = {}) {
  const view = snapshotView(snapshot);
  const safeError = job => job.error === undefined || job.error === "" || known(errors, job.error);
  if (!view.ready || !view.jobs.every(job => job.valid && safeError(job))) return false;
  if (id !== undefined && (!isAgentDraftTaskId(id) || own(view.selected, "id") !== id)) return false;
  if (view.selected === undefined) return id === undefined && !requireResult;
  const selected = jobView(view.selected);
  const listed = view.jobs.find(job => selected.valid && job.id.toLowerCase() === selected.id.toLowerCase());
  if (!selected.valid || !safeError(selected) || !listed || listed.action !== selected.action ||
      listed.startedAt !== selected.startedAt || listed.phase !== selected.phase || listed.resultAvailable !== selected.resultAvailable) return false;
  const result = own(view.selected, "result");
  return !requireResult && result === undefined || resultView(view).text !== undefined && isRecord(own(result, "coverage"));
}

function coverageRows(element, coverage) {
  const list = element("dl", undefined, "memory-facts agent-drafts-coverage");
  list.setAttribute("aria-label", "草稿覆盖范围");
  const row = (label, value) => list.append(element("dt", label), element("dd", value));
  for (const [key, label] of counts) {
    const value = own(coverage, key);
    if (value !== undefined) row(label, Number.isSafeInteger(value) && value >= 0 ? String(value) : "未知");
  }
  for (const [key, label] of flags) {
    const value = own(coverage, key);
    if (value !== undefined) row(label, typeof value === "boolean" ? value ? "是" : "否" : "未知");
  }
  const truncated = own(coverage, "truncated");
  if (truncated !== undefined) {
    row("截断情况", typeof truncated === "boolean" ? truncated ? "已截断" : "未截断"
      : Number.isSafeInteger(truncated) && truncated >= 0 ? `${truncated} 条` : "未知");
  }
  if (!list.children.length) row("覆盖范围", "未知");
  return list;
}

function taskList(element, view, button) {
  const wrap = element("div", undefined, "agent-drafts-list");
  Object.assign(wrap.style, { minWidth: "0", maxWidth: "100%", overflow: "auto", maxHeight: "360px" });
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "草稿任务列表");
  const table = element("table", undefined, "agent-drafts-table");
  Object.assign(table.style, { width: "100%", minWidth: "420px", tableLayout: "fixed", borderCollapse: "collapse", fontSize: "13px" });
  const head = element("thead"); const heading = element("tr");
  for (const [label, width] of [["任务（北京时间）", "43%"], ["状态", "29%"], ["操作", "28%"]]) {
    const cell = element("th", label);
    cell.scope = "col";
    Object.assign(cell.style, { width, textAlign: "left", padding: "8px", overflowWrap: "anywhere" });
    heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = element("tbody");
  for (const job of view.jobs) {
    const row = element("tr");
    const cells = [element("td"), element("td"), element("td")];
    for (const cell of cells) Object.assign(cell.style, { padding: "8px", verticalAlign: "top",
      overflowWrap: "anywhere", borderBottom: "1px solid var(--line)" });
    cells[0].append(element("div", job.action ? actions[job.action] : "任务类型未知"), element("small", timeLabel(job.startedAt)));
    cells[1].append(element("div", job.phase ? phases[job.phase] : "状态未知"));
    if (job.finishedAt !== undefined) cells[1].append(element("small", `结束：${timeLabel(job.finishedAt)}`));
    const failure = errorLabel(job.error);
    if (failure) cells[1].append(element("div", failure));
    const commands = element("div", undefined, "memory-actions agent-drafts-actions");
    Object.assign(commands.style, { display: "flex", flexWrap: "wrap", gap: "6px" });
    if (job.valid) {
      const inspect = button("查看草稿", "inspectAgentDraft", job.id);
      inspect.disabled = job.phase !== "done" || job.resultAvailable !== true;
      inspect.setAttribute("title", inspect.disabled ? "草稿尚不可用" : "查看草稿");
      commands.append(inspect);
      if (view.enabled && active.has(job.phase)) {
        const cancel = button(job.phase === "cancelling" ? "取消中" : "取消任务", "cancelAgentDraft", job.id);
        cancel.disabled = job.phase === "cancelling";
        cancel.setAttribute("title", cancel.disabled ? "取消请求处理中" : "请求取消任务");
        commands.append(cancel);
      }
    } else commands.append(element("span", "不可操作"));
    cells[2].append(commands); row.append(...cells); body.append(row);
  }
  table.append(body); wrap.append(table);
  return wrap;
}

/** Pure renderer. The parent owns refresh/inspect/cancel delegation and the query-id fetch.
 * Classes reuse the unframed agent-tools region; local dimensions keep the table scroll-contained.
 * No list body, callbacks, polling, storage, network or optimistic lifecycle transitions.
 */
export function mountAgentDrafts(container, snapshot) {
  if (!container?.ownerDocument || typeof container.replaceChildren !== "function") throw new TypeError("DOM container required");
  const document = container.ownerDocument;
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const button = (label, action, id) => {
    const node = element("button", label, "agent-drafts-command");
    node.type = "button"; node.dataset.action = action;
    if (id !== undefined) node.dataset.taskId = id;
    Object.assign(node.style, { width: "96px", minWidth: "96px", maxWidth: "100%", height: "34px",
      flexShrink: "0", padding: "4px 8px", whiteSpace: "normal", overflowWrap: "anywhere" });
    return node;
  };
  const view = snapshotView(snapshot);
  const panel = element("section", undefined, "agent-tools agent-drafts");
  Object.assign(panel.style, { minWidth: "0", maxWidth: "100%" });
  panel.setAttribute("aria-label", "Agent 草稿任务");
  const head = element("div", undefined, "section-head agent-drafts-head");
  head.append(element("h3", "Agent 草稿"), button("刷新状态", "refreshAgentDrafts"));
  const notice = element("p", `${view.notice} · ${view.enabled === false ? "未开放" : view.ready ? "已开放" : "开放状态未知"}`, "diagnostic-notice");
  notice.setAttribute("role", "status"); panel.append(head, notice);
  if (view.ready) {
    panel.append(view.jobs.length ? taskList(element, view, button) : element("p", "服务端未列出任务", "diagnostic-notice"));
  } else panel.append(element("p", "任务列表未知", "diagnostic-notice"));
  const preview = element("div", undefined, "agent-drafts-preview");
  Object.assign(preview.style, { minWidth: "0", maxWidth: "100%", marginTop: "16px", borderTop: "1px solid var(--line)" });
  const previewHeading = element("h4", "草稿预览");
  Object.assign(previewHeading.style, { fontSize: "13px", margin: "12px 0 8px" });
  preview.append(previewHeading);
  const result = resultView(view);
  const state = element("p", result.notice, "diagnostic-notice");
  state.setAttribute("role", "status"); preview.append(state);
  if (result.text !== undefined) {
    const draft = element("pre", result.text, "agent-drafts-text");
    Object.assign(draft.style, { whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", fontSize: "13px",
      minWidth: "0", maxWidth: "100%", minHeight: "72px", maxHeight: "360px", overflow: "auto", margin: "0" });
    preview.append(coverageRows(element, result.coverage), draft);
  }
  panel.append(preview); container.replaceChildren(panel);
  return panel;
}
