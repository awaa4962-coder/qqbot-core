import { host } from "../ui/state.js";

let latest = null;
let baseline = null;
let revision = "";
let selected = "";
let phase = "unknown";
let epoch = 0;
let busy = false;
let unknownWrite = false;
let requiresAuthenticatedRead = false;
let pendingWrite = null;
let editorBaseline = "";
let version = 0;
const toolDrafts = new Map();
let refs = {};
const own = (value, key) => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const clone = value => JSON.parse(JSON.stringify(value));
const idValid = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const hashValid = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const states = { connected: "已连接", disconnected: "未连接", connecting: "连接中", disabled: "未启用", error: "连接失败" };
const reasons = { revision_conflict: "配置已在别处更新；草稿已保留。", configuration_busy: "配置正在保存，未完成本次操作。",
  configuration_unreadable: "配置文件不可读或缺损，未覆盖原文件。", connection_failed: "连接或发现失败。",
  invalid_configuration: "配置未通过校验。", invalid_endpoint: "服务地址不在允许范围内。", server_disabled: "服务未启用。",
  schema_changed: "Schema 已变化，原许可未生效。", unsupported_schema: "参数结构暂不支持。",
  schema_contains_credentials: "工具定义含凭据，已拒绝发布。", notification_stream_ended: "通知连接已结束，需重新连接。",
  notification_stream_invalid: "服务未提供有效通知流，许可已撤销。", notification_stream_failed: "通知连接失败，许可已撤销。",
  notification_stream_limit: "通知内容超限，许可已撤销。", transport_error: "工具连接异常，许可已撤销。",
  transport_closed: "工具连接已关闭，许可已撤销。",
  unsupported_input_policy: "参数用途暂不支持。", not_allowlisted: "尚未许可。", not_discovered: "未取得当前工具定义。",
  tools_changed_refresh_required: "工具目录已变化，需重新发现。", configuration_changed: "配置已变化，需重新连接。" };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function command(action, text, serverId, toolName) {
  const button = element("button", text, "mcp-command");
  button.type = "button"; button.dataset.action = action;
  if (serverId) button.dataset.serverId = serverId;
  if (toolName) button.dataset.toolName = toolName;
  return button;
}
function localButton(name, text, title) {
  const button = element("button", text, "mcp-command"); button.type = "button";
  button.dataset.mcpLocal = name; button.title = title || text;
  button.setAttribute("aria-label", title || text);
  return button;
}
function inputField(form, key, title, type = "text") {
  const label = element("label", undefined, "mcp-field"); label.append(element("span", title));
  const input = element("input"); input.type = type; input.id = "mcp-" + key;
  input.setAttribute("aria-label", title); input.autocomplete = type === "password" ? "new-password" : "off";
  label.append(input); form.append(label); refs[key] = input;
  input.addEventListener("input", edited); input.addEventListener("change", edited);
  return input;
}
function edited() { version++; if (phase === "ready") phase = "dirty"; syncControls(); }
function mount() {
  const root = document.getElementById("mcpToolsPanel");
  if (!root) return false;
  if (refs.root === root) return true;
  refs = { root }; root.classList.add("mcp-workspace"); root.replaceChildren();
  if (host.mode !== "browser") { root.append(element("p", "MCP 管理仅开放于 Linux 浏览器控制台。")); return false; }
  const header = element("div", undefined, "section-head"); header.append(element("h3", "MCP 只读服务"));
  const actions = element("div", undefined, "mcp-commands");
  const refresh = command("refreshMcp", "↻"); refresh.classList.add("icon-button"); refresh.title = "刷新只读状态"; refresh.setAttribute("aria-label", refresh.title);
  actions.append(refresh, localButton("new", "+", "新增服务"), localButton("reload", "重新载入配置")); header.append(actions);
  refs.notice = element("p", "尚未读取服务状态。", "mcp-notice"); refs.notice.setAttribute("role", "status"); refs.notice.setAttribute("aria-live", "polite");
  refs.servers = element("div", undefined, "mcp-server-list");
  refs.editor = element("form", undefined, "mcp-editor"); refs.editor.setAttribute("aria-label", "服务配置");
  refs.editor.addEventListener("submit", event => event.preventDefault());
  refs.editor.append(element("h4", "服务配置"));
  inputField(refs.editor, "id", "服务 ID").maxLength = 32;
  inputField(refs.editor, "label", "能力名称").maxLength = 80;
  inputField(refs.editor, "url", "服务地址", "url").maxLength = 1024;
  inputField(refs.editor, "enabled", "启用服务", "checkbox");
  inputField(refs.editor, "token", "新凭据", "password").maxLength = 2048;
  inputField(refs.editor, "clearToken", "移除现有凭据", "checkbox");
  refs.keyState = element("p", "", "mcp-key-state"); refs.save = command("saveMcpServer", "保存服务");
  refs.editor.append(refs.keyState, refs.save);
  refs.tools = element("div", undefined, "mcp-tool-list");
  root.append(header, refs.notice, refs.servers, refs.editor, refs.tools);
  root.addEventListener("click", localClick);
  return true;
}
function localClick(event) {
  const button = event.target.closest?.("[data-mcp-local]");
  if (!button || busy) return;
  const action = button.dataset.mcpLocal;
  if (action === "reload") {
    if (requiresAuthenticatedRead || pendingWrite || !latest || latest.status !== "ready" || !canDiscardMcpDrafts()) return;
    unknownWrite = false; toolDrafts.clear(); acceptBaseline(latest); phase = "ready";
    fillEditor(selected); showNotice("已重新载入配置。", "ready"); renderLists(); syncControls();
  } else if (["new", "edit"].includes(action) && canDiscardMcpDrafts()) {
    toolDrafts.clear(); fillEditor(action === "new" ? "" : button.dataset.serverId);
    if (!unknownWrite && revision === latest?.revision) phase = "ready";
    renderLists(); syncControls();
  }
}
function editorFingerprint() {
  if (!refs.id) return "";
  return JSON.stringify([refs.id.value, refs.label.value, refs.url.value, refs.enabled.checked,
    refs.token.value, refs.clearToken.checked]);
}
export function mcpHasDrafts() {
  return Boolean(toolDrafts.size || editorBaseline && editorFingerprint() !== editorBaseline);
}
export function canDiscardMcpDrafts() {
  return !pendingWrite && (!mcpHasDrafts() && !unknownWrite || window.confirm("有未保存修改或未知写入结果。确认放弃草稿并核对最新配置？"));
}
function acceptBaseline(snapshot) { baseline = clone(snapshot.configuration); revision = snapshot.revision; }
function fillEditor(id) {
  selected = id;
  const server = baseline?.servers.find(item => item.id === id);
  refs.id.value = server?.id || ""; refs.label.value = server?.label || ""; refs.url.value = server?.url || "";
  refs.enabled.checked = server?.enabled || false; refs.token.value = ""; refs.clearToken.checked = false;
  refs.keyState.textContent = latest?.servers.find(item => item.id === id)?.hasToken ? "凭据已配置，未回传。" : "未配置凭据。";
  editorBaseline = editorFingerprint(); version++;
}
export function invalidateMcpView(reason) {
  if ([401, 403].includes(reason?.status)) { mcpReadFailed(reason); return; }
  if (pendingWrite) unknownWrite = true;
  epoch++; latest = null; phase = "unknown";
  if (!refs.root) return;
  if (refs.token) refs.token.value = "";
  showNotice("服务状态已失效；凭据输入已清空，其他草稿已保留。", "unknown"); renderLists(); syncControls();
}
export function renderMcp(snapshot) {
  if (!mount()) return false;
  if (requiresAuthenticatedRead) { showNotice("鉴权已失效，请重新读取服务状态；草稿已保留。", "authfailed"); syncControls(); return false; }
  let projected;
  try { projected = projectSnapshot(snapshot); } catch { mcpReadFailed({}); return false; }
  if (latest && latest.revision !== projected.revision) epoch++;
  const dirty = mcpHasDrafts(); latest = projected;
  if (!baseline || (!dirty && !unknownWrite && !["conflict", "authfailed"].includes(phase))) {
    acceptBaseline(projected);
    const id = projected.configuration.servers.some(server => server.id === selected) ? selected : projected.configuration.servers[0]?.id || "";
    fillEditor(id);
  }
  if (projected.status !== "ready") phase = "unknown";
  else if (unknownWrite) phase = "unknown";
  else if (revision !== projected.revision) phase = "conflict";
  else phase = dirty ? "dirty" : "ready";
  const message = phase === "conflict" ? reasons.revision_conflict : unknownWrite ? "写入结果未知；只读状态已刷新，草稿未重发。" :
    projected.status !== "ready" ? "服务配置状态不可用，写操作锁定。" : dirty ? "状态已刷新，未保存修改已保留。" :
      projected.servers.length ? "服务状态已读取。" : "暂无 MCP 服务。";
  showNotice(message, phase); renderLists(); syncControls(); return true;
}
function showNotice(message, state) { if (refs.notice) { refs.notice.textContent = message; refs.notice.dataset.state = state; } }
function writable() { return host.mode === "browser" && latest?.status === "ready" && revision === latest.revision &&
  !requiresAuthenticatedRead && !pendingWrite && !unknownWrite && !["unknown", "conflict", "authfailed"].includes(phase); }
export function setMcpBusy(value) { busy = value; syncControls(); }
function syncControls() {
  if (!refs.root) return;
  refs.root.setAttribute("aria-busy", String(busy)); refs.root.dataset.state = phase;
  for (const button of refs.root.querySelectorAll("button")) {
    const read = button.dataset.action === "refreshMcp" || button.dataset.mcpLocal === "reload";
    button.disabled = busy || (!read && !writable()) || button.dataset.unsupported === "true";
  }
  for (const input of refs.editor?.querySelectorAll("input") || []) input.disabled = busy || !writable();
  if (refs.id) refs.id.disabled = busy || !writable() || Boolean(selected);
  const serverDirty = Boolean(editorBaseline && editorFingerprint() !== editorBaseline);
  for (const node of [...(refs.tools?.querySelectorAll("input") || []), ...(refs.tools?.querySelectorAll("select") || [])]) node.disabled = busy || !writable() || serverDirty;
  if (refs.save) refs.save.disabled ||= toolDrafts.size > 0;
}
function table(headers) {
  const node = element("table", undefined, "mcp-table");
  const head = element("thead"); const row = element("tr");
  for (const title of headers) row.append(element("th", title)); head.append(row);
  const body = element("tbody"); node.append(head, body); return { node, body };
}
function cell(row, label, child) {
  const td = element("td"); td.dataset.label = label;
  td.append(typeof child === "string" ? element("span", child) : child); row.append(td);
}
function renderLists() {
  if (!refs.servers) return;
  refs.servers.replaceChildren(); refs.tools.replaceChildren();
  if (!latest) { refs.servers.append(element("p", "实时状态未确认。")); return; }
  const servers = table(["服务", "状态", "工具", "操作"]);
  for (const server of latest.servers) {
    const row = element("tr"); cell(row, "服务", server.label + " · " + server.id);
    cell(row, "状态", (states[server.status] || "状态未确认") + (server.reason ? " · " + safeReason(server.reason) : ""));
    cell(row, "工具", String(server.toolCount));
    const commands = element("div", undefined, "mcp-commands"); const edit = localButton("edit", "编辑"); edit.dataset.serverId = server.id;
    commands.append(edit, command("connectMcpServer", "连接", server.id), command("refreshMcpTools", "发现工具", server.id), command("disconnectMcpServer", "断开", server.id));
    cell(row, "操作", commands); servers.body.append(row);
  }
  refs.servers.append(latest.servers.length ? servers.node : element("p", "尚未配置服务。"));
  renderTools();
}
function renderTools() {
  refs.tools.append(element("h4", "工具许可"));
  const server = latest.servers.find(item => item.id === selected);
  if (!server?.tools.length) { refs.tools.append(element("p", "暂无发现的工具。")); return; }
  const tools = table(["许可", "能力", "范围", "有效状态", "定义", "操作"]);
  for (const tool of server.tools) tools.body.append(toolRow(server, tool));
  refs.tools.append(tools.node, element("p", "只读许可不等于远端实现已通过安全审计。", "mcp-boundary"));
}
function toolRow(server, tool) {
  const key = server.id + "/" + tool.name;
  const configured = baseline?.servers.find(item => item.id === server.id)?.tools.find(item => item.name === tool.name);
  const draft = toolDrafts.get(key) || { enabled: configured?.enabled || false, scope: configured?.scope || tool.supportedScopes[0] || "public",
    label: configured?.label || tool.name, schemaHash: tool.schemaHash };
  const row = element("tr");
  const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = draft.enabled; enabled.setAttribute("aria-label", "允许 " + tool.name);
  const label = element("input"); label.type = "text"; label.maxLength = 80; label.value = draft.label; label.setAttribute("aria-label", tool.name + " 能力名称");
  const scope = element("select"); scope.setAttribute("aria-label", tool.name + " 范围");
  for (const [value, title] of [["public", "公开查询"], ["current", "当前会话"]]) {
    const option = element("option", title); option.value = value; option.disabled = !tool.supportedScopes.includes(value); scope.append(option);
  }
  scope.value = draft.scope;
  const update = () => { toolDrafts.set(key, { enabled: enabled.checked, scope: scope.value, label: label.value,
    schemaHash: draft.schemaHash }); edited(); };
  enabled.addEventListener("change", update); scope.addEventListener("change", update); label.addEventListener("input", update);
  const allowed = writable() && !busy;
  enabled.disabled = !allowed; scope.disabled = !allowed; label.disabled = !allowed;
  cell(row, "许可", enabled); const name = element("div"); name.append(element("b", tool.name), label); cell(row, "能力", name);
  cell(row, "范围", scope); cell(row, "有效状态", tool.available ? "当前可用" : safeReason(tool.reason));
  const definition = element("code", tool.discovered ? tool.schemaHash.slice(0, 12) : "未发现"); definition.title = tool.schemaHash; cell(row, "定义", definition);
  const approve = command("approveMcpTool", "保存许可", server.id, tool.name);
  approve.dataset.unsupported = String(!tool.discovered || !tool.supportedScopes.length); cell(row, "操作", approve);
  return row;
}
function safeReason(reason) { return reasons[reason] || "状态未确认。"; }
export function mcpActionTicket() { return { epoch, version, serverId: refs.id?.value.trim() || selected }; }
export function mcpTicketCurrent(ticket) { return ticket.epoch === epoch; }
export function mcpReadSucceeded(snapshot, ticket) {
  if (!mcpTicketCurrent(ticket)) return false;
  try { projectSnapshot(snapshot); } catch { return false; }
  requiresAuthenticatedRead = false;
  return renderMcp(snapshot);
}
export function mcpBeginWrite(ticket, body) {
  if (pendingWrite) throw new Error("mcp_view_locked");
  pendingWrite = { ticket, expectedRevision: body.expectedRevision, action: body.action, serverId: body.serverId,
    configuration: body.configuration ? canonicalConfiguration(body.configuration) : null,
    publicChange: body.configuration ? canonicalConfiguration(body.configuration) !== canonicalConfiguration(baseline) : false,
    credentialStates: Object.entries(body.tokens || {}).map(([id, token]) => [id, token !== null]), confirmed: false, knownFailure: false };
}
export function mcpEndWrite(ticket) {
  if (pendingWrite?.ticket !== ticket) return;
  const uncertain = !pendingWrite.confirmed && !pendingWrite.knownFailure;
  pendingWrite = null;
  if (uncertain) {
    unknownWrite = true;
    if (phase !== "authfailed") phase = "unknown";
    showNotice("写入结果未知；未自动重试，需只读核对并显式重新载入配置。", phase);
  }
  syncControls();
}
export function mcpReadFailed(error) {
  if (pendingWrite) unknownWrite = true;
  const auth = [401, 403].includes(error?.status);
  requiresAuthenticatedRead ||= auth;
  epoch++; phase = auth ? "authfailed" : "unknown"; latest = null;
  if (refs.token && auth) refs.token.value = "";
  showNotice(auth ? "认证失败；凭据输入已清空，其他草稿已保留。" : "状态读取失败或接口未开放，草稿已保留。", phase);
  renderLists(); syncControls();
}
export function mcpWriteFailed(result, uncertain = false) {
  if (result?.reason === "connection_failed" && !validConnectionFailure(result.snapshot)) uncertain = true;
  if (pendingWrite && !uncertain && mcpTicketCurrent(pendingWrite.ticket)) pendingWrite.knownFailure = true;
  if ([401, 403].includes(result?.status)) { mcpReadFailed(result); return false; }
  if (uncertain && pendingWrite?.action !== "save") { latest = null; renderLists(); }
  else if (result?.snapshot) renderMcp(result.snapshot);
  unknownWrite ||= uncertain;
  phase = uncertain ? "unknown" : result?.reason === "revision_conflict" || result?.status === 409 ? "conflict" : "error";
  showNotice(uncertain ? "写入结果未知；未自动重试，草稿已保留。" : safeReason(result?.reason), phase); syncControls();
  return !uncertain && result?.reason === "connection_failed";
}
function validConnectionFailure(snapshot) {
  try {
    const value = projectSnapshot(snapshot);
    return value.status === "ready" && ["connect", "refresh"].includes(pendingWrite?.action) &&
      ["error", "disconnected"].includes(value.servers.find(server => server.id === pendingWrite.serverId)?.status);
  } catch { return false; }
}
export function mcpWriteSucceeded(snapshot, ticket, acknowledgement) {
  if (!mcpTicketCurrent(ticket)) return false;
  let projected;
  try { projected = projectSnapshot(snapshot); } catch { return false; }
  if (!pendingWrite || pendingWrite.ticket !== ticket || !exactAcknowledgement(projected, pendingWrite)) return false;
  pendingWrite.confirmed = true;
  if (ticket.version === version && acknowledgement) {
    if (acknowledgement.toolKey) {
      toolDrafts.delete(acknowledgement.toolKey); acceptBaseline(projected);
    } else { toolDrafts.clear(); baseline = null; editorBaseline = ""; selected = ticket.serverId; }
    unknownWrite = false; phase = "ready";
  }
  return renderMcp(snapshot);
}
function exactAcknowledgement(snapshot, pending) {
  if (snapshot.status !== "ready") return false;
  if (pending.action !== "save") return true;
  if (canonicalConfiguration(snapshot.configuration) !== pending.configuration) return false;
  if ((pending.publicChange || pending.credentialStates.length) && snapshot.revision === pending.expectedRevision) return false;
  return pending.credentialStates.every(([id, present]) => snapshot.servers.find(server => server.id === id)?.hasToken === present);
}
function canonicalConfiguration(configuration) {
  const servers = configuration.servers.map(projectConfigServer).sort((a, b) => a.id.localeCompare(b.id));
  for (const server of servers) {
    server.url = new URL(server.url).href;
    server.tools.sort((a, b) => a.name.localeCompare(b.name));
    for (const tool of server.tools) tool.bindings = Object.fromEntries(Object.entries(tool.bindings).sort(([a], [b]) => a.localeCompare(b)));
  }
  return JSON.stringify({ servers });
}
function requireWritable() { if (!writable()) throw new Error("mcp_view_locked"); }
export function mcpServerPayload() {
  requireWritable();
  if (toolDrafts.size) throw new Error("mcp_tool_draft_pending");
  const id = refs.id.value.trim(); const label = refs.label.value.trim(); const url = refs.url.value.trim();
  if (!idValid(id) || !label || label.length > 80 || !url || url.length > 1024) throw new Error("mcp_invalid_form");
  const configuration = clone(baseline);
  const index = configuration.servers.findIndex(server => server.id === id);
  if (!selected && index !== -1 || index === -1 && configuration.servers.length >= 4) throw new Error("mcp_invalid_form");
  const server = { id, label, url, enabled: refs.enabled.checked, tools: index < 0 ? [] : configuration.servers[index].tools };
  if (index < 0) configuration.servers.push(server); else configuration.servers[index] = server;
  if (refs.token.value && refs.clearToken.checked) throw new Error("mcp_invalid_form");
  const tokens = refs.clearToken.checked ? { [id]: null } : refs.token.value ? { [id]: refs.token.value } : undefined;
  return { action: "save", expectedRevision: revision, configuration, ...(tokens ? { tokens } : {}) };
}
export function mcpToolPayload(serverId, name) {
  requireWritable();
  if (mcpHasDrafts() && editorFingerprint() !== editorBaseline) throw new Error("mcp_server_draft_pending");
  const server = latest.servers.find(item => item.id === serverId);
  const tool = server?.tools.find(item => item.name === name);
  if (!tool?.discovered || !hashValid(tool.schemaHash)) throw new Error("mcp_tool_not_discovered");
  const key = serverId + "/" + name;
  const config = clone(baseline); const target = config.servers.find(item => item.id === serverId);
  const old = target?.tools.find(item => item.name === name);
  const draft = toolDrafts.get(key) || { enabled: old?.enabled || false, scope: old?.scope || tool.supportedScopes[0], label: old?.label || name, schemaHash: tool.schemaHash };
  if (!target || draft.schemaHash !== tool.schemaHash || draft.enabled && !tool.supportedScopes.includes(draft.scope)) throw new Error("mcp_schema_conflict");
  const bindings = draft.scope === "current" ? Object.fromEntries(tool.scopeFields.map(field => [field, field === "group_id" ? "groupId" : "userId"])) : {};
  if (draft.scope === "current" && !Object.keys(bindings).length) throw new Error("mcp_scope_unavailable");
  const next = { name, label: draft.label.trim() || name, enabled: draft.enabled, scope: draft.scope, mode: "read",
    bindings, inputPolicy: draft.scope === "current" ? "current-scope" : "public-query", schemaHash: tool.schemaHash };
  target.tools = target.tools.filter(item => item.name !== name); target.tools.push(next);
  return { action: "save", expectedRevision: revision, configuration: config };
}
export function mcpConnectionPayload(action, serverId) {
  requireWritable();
  if (mcpHasDrafts()) throw new Error("mcp_drafts_pending");
  if (!latest.servers.some(server => server.id === serverId)) throw new Error("mcp_unknown_server");
  return { action, serverId, expectedRevision: revision };
}
function projectSnapshot(value) {
  const status = own(value, "status"); const rev = own(value, "revision");
  const config = own(value, "configuration"); const servers = own(value, "servers");
  if (!["ready", "error", "closed", "not_initialized"].includes(status) || typeof rev !== "string" || rev.length > 64 ||
      !Array.isArray(servers) || servers.length > 4 || !Array.isArray(own(config, "servers")) || own(config, "servers").length > 4) throw new Error("mcp_snapshot_invalid");
  const configuration = { servers: config.servers.map(projectConfigServer) };
  const projected = servers.map(server => {
    if (!idValid(own(server, "id")) || typeof own(server, "label") !== "string" || !Array.isArray(own(server, "tools")) || server.tools.length > 64) throw new Error("mcp_snapshot_invalid");
    return { id: server.id, label: server.label.slice(0, 80), enabled: own(server, "enabled") === true,
      status: own(server, "status"), reason: own(server, "reason"), hasToken: own(server, "hasToken") === true,
      toolCount: Number.isSafeInteger(own(server, "toolCount")) ? server.toolCount : 0, tools: server.tools.map(projectTool) };
  });
  const ids = configuration.servers.map(server => server.id);
  if (new Set(ids).size !== ids.length || new Set(projected.map(server => server.id)).size !== projected.length ||
      projected.length !== ids.length || projected.some(server => !ids.includes(server.id))) throw new Error("mcp_snapshot_invalid");
  return { status, revision: rev, configuration, servers: projected };
}
function projectConfigServer(server) {
  if (!idValid(own(server, "id")) || typeof own(server, "label") !== "string" || typeof own(server, "url") !== "string" ||
      typeof own(server, "enabled") !== "boolean" || server.label.length > 80 || server.url.length > 1024 ||
      !Array.isArray(own(server, "tools")) || server.tools.length > 32) throw new Error("mcp_snapshot_invalid");
  return { id: server.id, label: server.label.slice(0, 80), url: server.url.slice(0, 1024), enabled: server.enabled,
    tools: server.tools.map(projectConfigTool) };
}
function projectConfigTool(tool) {
  const name = own(tool, "name"); const label = own(tool, "label") || name; const scope = own(tool, "scope");
  const enabled = own(tool, "enabled"); const schemaHash = own(tool, "schemaHash"); const bindings = own(tool, "bindings") || {};
  const expectedPolicy = scope === "current" ? "current-scope" : "public-query";
  const inputPolicy = own(tool, "inputPolicy") ?? expectedPolicy;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name) || typeof label !== "string" || label.length > 80 ||
      !["public", "current"].includes(scope) || typeof enabled !== "boolean" || own(tool, "mode") !== "read" ||
      inputPolicy !== expectedPolicy ||
      (schemaHash !== undefined && !hashValid(schemaHash)) || (enabled && !schemaHash) ||
      !bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("mcp_snapshot_invalid");
  const projectedBindings = {};
  for (const key of Object.keys(bindings)) {
    if (!["group_id", "user_id"].includes(key) || own(bindings, key) !== (key === "group_id" ? "groupId" : "userId")) throw new Error("mcp_snapshot_invalid");
    projectedBindings[key] = own(bindings, key);
  }
  if (scope === "public" && Object.keys(projectedBindings).length || scope === "current" && !Object.keys(projectedBindings).length) throw new Error("mcp_snapshot_invalid");
  return { name, label, enabled, mode: "read", scope, inputPolicy,
    bindings: projectedBindings, ...(schemaHash ? { schemaHash } : {}) };
}
function projectTool(tool) {
  const name = own(tool, "name");
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name) ||
      !Array.isArray(own(tool, "scopeFields") || []) || !Array.isArray(own(tool, "supportedScopes") || [])) throw new Error("mcp_snapshot_invalid");
  return { name, enabled: own(tool, "enabled") === true, available: own(tool, "available") === true,
    discovered: own(tool, "discovered") === true, reason: own(tool, "reason"), schemaHash: own(tool, "schemaHash") || "",
    scopeFields: (own(tool, "scopeFields") || []).filter(field => ["group_id", "user_id"].includes(field)),
    supportedScopes: (own(tool, "supportedScopes") || []).filter(scope => ["public", "current"].includes(scope)) };
}
