import { $, escapeHtml, fmt } from "../ui/dom.js";
import { uiState } from "../ui/state.js";
import { mountAgentTools } from "../agent-tools.js";
import { invalidateAgentDraftView, renderAgentDraftSnapshot } from "../ui/agent-draft-actions.js";
import { invalidateAgentWriteView, renderAgentWriteSnapshot } from "../ui/agent-write-actions.js";

export function renderCapabilities(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.categories) || !Array.isArray(snapshot.capabilities) ||
      snapshot.capabilities.some(item => !item || typeof item !== "object")) {
    invalidateAgentDraftView();
    invalidateAgentWriteView();
    throw new Error("能力目录响应不完整，请重新读取。");
  }
  renderAgentDraftSnapshot(snapshot.agentDrafts);
  renderAgentWriteSnapshot(snapshot.agentWrites);
  uiState.capabilitySnapshot = snapshot;
  uiState.capabilitiesLoaded = true;
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
  $("capabilityNavCount").textContent = String(capabilities.length);

  const categorySelect = $("capabilityCategory");
  const selected = categorySelect.value || "all";
  categorySelect.innerHTML = [
    '<option value="all">全部分类</option>',
    ...categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.number}. ${item.name}`)}</option>`),
  ].join("");
  categorySelect.value = categories.some((item) => item.id === selected) ? selected : "all";

  const counts = countCapabilityStatuses(capabilities);
  $("capabilitySummary").innerHTML = [
    `<b>${fmt.format(capabilities.length)} 项能力</b>`,
    `<span class="available">${fmt.format(counts.available)} 可调用</span>`,
    `<span class="limited">${fmt.format(counts.limited)} 受限</span>`,
    `<span class="unavailable">${fmt.format(counts.unavailable)} 不可用</span>`,
    `<span class="reserved">${fmt.format(counts.reserved)} 预留</span>`,
  ].join("");
  setCapabilityNotice(capabilities.length ? "能力目录已刷新" : "目录已读取，暂无能力记录", capabilities.length ? "ready" : "empty");
  applyCapabilityFilter();
  const agentPanel = $("agentToolsPanel");
  if (agentPanel) mountAgentTools(agentPanel, snapshot.agentTools);
}

export function setCapabilityNotice(message, state = "error") {
  const notice = $("capabilityNotice");
  if (notice) {
    notice.textContent = message;
    if (notice.dataset) notice.dataset.state = state;
  }
  const panel = $("capabilityPanel");
  panel?.setAttribute?.("aria-busy", String(state === "loading"));
}

export function capabilityReadFailed(error) {
  invalidateAgentDraftView();
  invalidateAgentWriteView();
  uiState.capabilitiesLoaded = false;
  const denied = [401, 403].includes(error?.status);
  const message = denied ? "无权读取能力目录，请重新认证后刷新。"
    : [500, 502, 503, 504].includes(error?.status) ? "能力读取失败：服务暂不可用。"
    : error?.status === 404 ? "能力读取失败：接口未开放。" : "能力读取失败：状态未确认。";
  const cached = Array.isArray(uiState.capabilitySnapshot?.capabilities) && uiState.capabilitySnapshot.capabilities.length > 0;
  setCapabilityNotice(denied ? message : `${message}${cached ? "以下为上次快照，非最新状态。" : "尚未取得目录。"}`);
  if (denied) {
    uiState.capabilitySnapshot = { categories: [], capabilities: [] };
    $("capabilityList").innerHTML = "";
    $("capabilitySummary").textContent = "目录未读取";
    $("capabilityNavCount").textContent = "-";
    const agentPanel = $("agentToolsPanel");
    if (agentPanel) mountAgentTools(agentPanel, null);
  }
  // Legacy action feedback reuses this same error for its toast after the page handler.
  if (error && typeof error === "object") {
    try {
      error.message = message;
      if (error.message !== message) throw new Error();
    } catch { throw new Error(message); }
  }
}

export function applyCapabilityFilter() {
  const query = ($("capabilitySearch")?.value || "").trim().toLowerCase();
  const category = $("capabilityCategory")?.value || "all";
  const status = $("capabilityStatus")?.value || "all";
  const categoryMap = new Map((uiState.capabilitySnapshot.categories || []).map((item) => [item.id, item]));
  const matches = (uiState.capabilitySnapshot.capabilities || []).filter((item) => {
    if (category !== "all" && item.category !== category) return false;
    if (status !== "all" && item.status !== status) return false;
    if (!query) return true;
    const haystack = [item.name, item.summary, ...(item.keywords || []), ...(item.examples || [])].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (!matches.length) {
    $("capabilityList").innerHTML = `<div class="empty-state"><b>${uiState.capabilitiesLoaded ? uiState.capabilitySnapshot.capabilities.length ? "没有匹配的能力" : "暂无能力记录" : "能力目录尚未读取"}</b></div>`;
    return;
  }
  $("capabilityList").innerHTML = matches.map((item) => {
    const meta = categoryMap.get(item.category) || {};
    const scope = (item.scopes || []).map(capabilityScopeLabel).join(" · ");
    const examples = (item.examples || []).map((example) => `<code>${escapeHtml(example)}</code>`).join("");
    return [
      `<article class="capability-row" data-status="${escapeHtml(item.status)}">`,
      '<div class="capability-index">',
      `<span>${escapeHtml(String(meta.number || "-"))}</span>`,
      `<small>${escapeHtml(meta.name || item.category)}</small>`,
      "</div>",
      '<div class="capability-copy">',
      `<div class="capability-title"><h3>${escapeHtml(item.name)}</h3><span class="capability-badge">${escapeHtml(item.statusLabel)}</span></div>`,
      `<p>${escapeHtml(item.summary)}</p>`,
      `<small>${escapeHtml(scope)} · ${escapeHtml(item.statusDetail || "状态待确认")}</small>`,
      `<small class="capability-state">${escapeHtml(capabilityStateLabel(item.state))}</small>`,
      examples ? `<div class="capability-examples">${examples}</div>` : "",
      "</div>",
      "</article>",
    ].join("");
  }).join("");
}

export function countCapabilityStatuses(capabilities) {
  return capabilities.reduce((counts, item) => {
    const key = Object.prototype.hasOwnProperty.call(counts, item.status) ? item.status : "unavailable";
    counts[key] += 1;
    return counts;
  }, { available: 0, limited: 0, unavailable: 0, reserved: 0 });
}

export function capabilityScopeLabel(scope) {
  return ({ group: "群聊", private: "私聊", console: "控制台" })[scope] || scope;
}

export function capabilityStateLabel(state) {
  if (!state) return "状态待刷新";
  const installed = state.installed === true ? "已安装" : state.installed === false ? "未安装" : "安装状态待确认";
  const enabled = state.enabled === true ? "已启用" : state.enabled === false ? "未启用" : "启用状态待确认";
  const permission = state.permitted == null ? "权限按实际会话判断" : state.permitted === true ? "会话已许可" : "当前会话受限";
  const health = ({ ready: "依赖检查通过", configured: "模型已配置，连通性未探测", partially_configured: "部分会话模型配置不可用",
    configuration_error: "模型配置不可用", degraded: "依赖异常", disabled: "当前未运行", unknown: "检查中", not_checked: "未做运行探测" })[state.health] || "状态待确认";
  return [installed, enabled, permission, health].join(" · ");
}
