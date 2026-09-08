import { $, escapeHtml, fmt } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function renderCapabilities(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
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
    `<span class="available">${fmt.format(counts.available)} 可用</span>`,
    `<span class="limited">${fmt.format(counts.limited)} 受限</span>`,
    `<span class="unavailable">${fmt.format(counts.unavailable)} 不可用</span>`,
    `<span class="reserved">${fmt.format(counts.reserved)} 预留</span>`,
  ].join("");
  applyCapabilityFilter();
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
    $("capabilityList").innerHTML = '<div class="empty-state"><b>没有匹配的能力</b><span>换个关键词或清除筛选后再试。</span></div>';
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
      `<small>${escapeHtml(scope)} · ${escapeHtml(item.statusDetail)}</small>`,
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
