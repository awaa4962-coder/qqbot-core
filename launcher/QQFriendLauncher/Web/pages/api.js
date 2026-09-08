import { $, escapeHtml } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export function renderApiProviders(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return;
  uiState.apiSnapshot = snapshot;
  uiState.apiProvidersLoaded = true;
  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const presets = Array.isArray(snapshot.presets) ? snapshot.presets : [];
  const protocols = Array.isArray(snapshot.protocols) ? snapshot.protocols : [];
  const requestedId = options.selectId || uiState.selectedApiProviderId;
  uiState.selectedApiProviderId = providers.some(item => item.id === requestedId)
    ? requestedId
    : providers[0]?.id || "";

  $("apiNavCount").textContent = String(providers.length);
  $("apiProviderCount").textContent = String(providers.length);
  $("apiKeyCount").textContent = String(providers.filter(item => item.keyConfigured).length);
  $("apiPresetCount").textContent = String(presets.length);
  $("apiGroupRoute").textContent = formatApiRoute(snapshot.routes?.group_chat);
  $("apiSummary").dataset.ready = "true";

  $("apiPreset").innerHTML = presets.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
  ).join("");
  $("apiProtocol").innerHTML = protocols.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
  ).join("");

  $("apiProviderList").innerHTML = providers.map(item => {
    const active = item.id === uiState.selectedApiProviderId;
    const status = item.keyConfigured ? "已配置" : "缺少 Key";
    return [
      `<button type="button" class="provider-card${active ? " active" : ""}" data-api-provider="${escapeHtml(item.id)}">`,
      `<span class="provider-card-title"><b>${escapeHtml(item.name)}</b><i class="${item.keyConfigured ? "ok" : "warn"}">${status}</i></span>`,
      `<small>${escapeHtml(item.model || "未填写模型")}</small>`,
      `<em>${escapeHtml(protocolLabel(item.protocol))}</em>`,
      "</button>",
    ].join("");
  }).join("") || '<div class="empty-state"><b>还没有 API</b><span>点“新增”创建第一个实例。</span></div>';

  renderApiRouteList(snapshot);
  fillApiProviderForm(providers.find(item => item.id === uiState.selectedApiProviderId));
}

export function renderApiRouteList(snapshot) {
  const providers = (snapshot.providers || []).filter(item => item.enabled !== false);
  const options = providers.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.model || "未选模型")}</option>`
  ).join("");
  const reasoningOptions = (snapshot.reasoningModes || [
    { id: "economy", name: "省额度" },
    { id: "auto", name: "智能" },
    { id: "deep", name: "深度" },
  ]).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  $("apiRouteList").innerHTML = (snapshot.tasks || []).map(task => {
    const fallbackProtected = task.protectedFallback === "deepseek";
    return [
      `<article class="api-route-row" data-api-task="${escapeHtml(task.id)}">`,
      `<div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.id)}</small></div>`,
      `<label>主力<select data-route-primary>${options}</select></label>`,
      `<span class="route-arrow">→</span>`,
      `<label>兜底<select data-route-fallback${fallbackProtected ? " disabled" : ""}><option value="">无</option>${options}</select></label>`,
      `<label class="route-reasoning">思考<select data-route-reasoning>${reasoningOptions}</select></label>`,
      fallbackProtected ? '<span class="route-lock">固定 DS</span>' : "",
      "</article>",
    ].join("");
  }).join("");
  document.querySelectorAll("[data-api-task]").forEach(row => {
    const task = row.dataset.apiTask;
    const route = snapshot.routes?.[task] || {};
    row.querySelector("[data-route-primary]").value = route.primary || "";
    row.querySelector("[data-route-fallback]").value = route.fallback || "";
    row.querySelector("[data-route-reasoning]").value = route.reasoning || "auto";
    updateApiRouteReasoningAvailability(row);
  });
  syncGlobalReasoningState();
  $("apiRouteOutput").textContent = `配置版本 ${snapshot.revision || 1} · API 与思考设置只影响后续请求`;
}

export function updateApiRouteReasoningAvailability(row) {
  const providerId = row.querySelector("[data-route-primary]")?.value;
  const provider = (uiState.apiSnapshot.providers || []).find(item => item.id === providerId);
  const select = row.querySelector("[data-route-reasoning]");
  const configurable = provider?.reasoningControl?.configurable === true;
  select.disabled = !configurable;
  select.title = configurable ? "设置这个功能的思考强度" : "当前主力 API 不提供可控思考档位";
  row.classList.toggle("reasoning-unavailable", !configurable);
}

export function applyGlobalReasoningPreset(mode) {
  let changed = 0;
  document.querySelectorAll("[data-api-task]").forEach(row => {
    const select = row.querySelector("[data-route-reasoning]");
    if (select.disabled) return;
    select.value = mode;
    changed++;
  });
  syncGlobalReasoningState();
  $("apiRouteOutput").textContent = changed
    ? `已选择“${reasoningModeLabel(mode)}”，点击“应用插槽”后生效`
    : "当前 API 没有可调思考档位";
}

export function syncGlobalReasoningState() {
  const selects = [...document.querySelectorAll("[data-route-reasoning]:not(:disabled)")];
  const modes = [...new Set(selects.map(select => select.value))];
  const activeMode = modes.length === 1 ? modes[0] : "";
  document.querySelectorAll("[data-reasoning-preset]").forEach(button => {
    button.classList.toggle("active", button.dataset.reasoningPreset === activeMode);
  });
  if (!$("apiReasoningState")) return;
  $("apiReasoningState").textContent = !selects.length
    ? "跟随模型"
    : activeMode
      ? reasoningModeLabel(activeMode)
      : "按功能细调";
}

export function reasoningModeLabel(mode) {
  return ({ economy: "省额度", auto: "智能", deep: "深度" })[mode] || "智能";
}

export function fillApiProviderForm(provider) {
  const item = provider || {};
  uiState.apiEditorMode = item.id ? "edit" : "create";
  uiState.selectedApiProviderId = item.id || "";
  $("apiEditorTitle").textContent = item.id ? item.name : "新增 API";
  $("apiEditorHint").textContent = item.id ? "修改 Key 时重新填写；留空不会覆盖" : "先选预设，再填写模型名和 Key";
  $("apiSaveButton").textContent = item.id ? "保存修改" : "创建实例";
  $("apiId").value = item.id || "";
  $("apiId").disabled = Boolean(item.id);
  $("apiName").value = item.name || "";
  $("apiPreset").value = item.presetId || "custom-openai-chat";
  $("apiProtocol").value = item.protocol || "openai-chat";
  $("apiEndpoint").value = item.endpoint || "";
  $("apiModel").value = item.model || "";
  $("apiAuth").value = item.auth || "bearer";
  $("apiTokenField").value = item.tokenField || "max_tokens";
  $("apiKey").value = "";
  $("apiAllowLocal").checked = item.allowLocal === true;
  $("apiKeyState").textContent = item.keyConfigured ? "Key 已配置" : "未配置 Key";
  $("apiKeyState").classList.toggle("dirty", !item.keyConfigured);
  document.querySelectorAll("#apiCapabilityChecks input").forEach(input => {
    input.checked = (item.capabilities || ["text"]).includes(input.value);
  });
}

export function startNewApiProvider() {
  uiState.selectedApiProviderId = "";
  document.querySelectorAll(".provider-card").forEach(card => card.classList.remove("active"));
  fillApiProviderForm(null);
  applyApiPreset("custom-openai-chat");
  $("apiId").focus();
  $("apiTestOutput").textContent = "填写并保存后可以测试连接";
}

export function applyApiPreset(presetId) {
  const preset = (uiState.apiSnapshot.presets || []).find(item => item.id === presetId);
  if (!preset) return;
  $("apiPreset").value = preset.id;
  $("apiProtocol").value = preset.protocol;
  $("apiEndpoint").value = preset.endpoint || "";
  $("apiEndpoint").placeholder = preset.endpointHint || "https://.../chat/completions";
  $("apiModel").value = preset.model || "";
  $("apiAuth").value = preset.auth || "bearer";
  $("apiTokenField").value = preset.tokenField || "max_tokens";
  $("apiAllowLocal").checked = preset.allowLocal === true;
  document.querySelectorAll("#apiCapabilityChecks input").forEach(input => {
    input.checked = (preset.capabilities || []).includes(input.value);
  });
  if (!$("apiName").value.trim()) $("apiName").value = preset.name;
}

export function apiProviderPayload() {
  return {
    action: "save-provider",
    mode: uiState.apiEditorMode,
    provider: {
      id: $("apiId").value.trim().toLowerCase(),
      name: $("apiName").value.trim(),
      presetId: $("apiPreset").value,
      protocol: $("apiProtocol").value,
      endpoint: $("apiEndpoint").value.trim(),
      model: $("apiModel").value.trim(),
      auth: $("apiAuth").value,
      tokenField: $("apiTokenField").value.trim(),
      allowLocal: $("apiAllowLocal").checked,
      capabilities: [...document.querySelectorAll("#apiCapabilityChecks input:checked")].map(input => input.value),
      key: $("apiKey").value.trim() || undefined,
    },
  };
}

export function apiRoutesPayload() {
  const routes = {};
  document.querySelectorAll("[data-api-task]").forEach(row => {
    routes[row.dataset.apiTask] = {
      primary: row.querySelector("[data-route-primary]").value,
      fallback: row.querySelector("[data-route-fallback]").value || null,
      reasoning: row.querySelector("[data-route-reasoning]").value || "auto",
    };
  });
  return { action: "save-routes", routes };
}

export function formatApiRoute(route) {
  if (!route) return "-";
  return `${route.primary || "未配置"} → ${route.fallback || "本地"}`;
}

export function protocolLabel(protocol) {
  return ({
    "openai-chat": "OpenAI Chat",
    "openai-responses": "Responses",
    "anthropic-messages": "Anthropic",
    "gemini-native": "Gemini",
  })[protocol] || protocol;
}
