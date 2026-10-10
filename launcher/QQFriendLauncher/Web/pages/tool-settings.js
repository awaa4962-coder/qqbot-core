import { host } from "../ui/state.js";

const editable = ["modelRounds", "toolCalls", "durationMs"];
const labels = { modelRounds: "模型轮次", toolCalls: "工具调用次数", durationMs: "持续时间（毫秒）" };
const bounds = { modelRounds: [3, 16], transportAttempts: [2, 32], toolCalls: [1, 24], slotRounds: [2, 15],
  durationMs: [5000, 180000], requestChars: [8000, 64000], resultChars: [256, 4000], totalResultChars: [1000, 24000],
  maxTokens: [128, 8192], responseBytes: [16384, 1048576], replyChars: [256, 12000] };
const presets = ["standard", "extended", "light"];
const unsupported = "工具调度设置仅开放于 Linux 浏览器控制台。";
let refs = {}, baseline = null, latest = null, phase = "unknown", epoch = 0;
let busy = false, pendingWrite = false, unknownWrite = false, requiresAuthenticatedRead = false;
const own = (value, key) => value && ["object", "function"].includes(typeof value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const copy = value => JSON.parse(JSON.stringify(value));

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  const name = typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name")?.value : undefined;
  return Object.getPrototypeOf(prototype) === null && name === "Object";
}
function fields(value, required, optional = []) {
  if (!plain(value)) throw new Error("tool_settings_snapshot_invalid");
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== "string" ||
      ![...required, ...optional].includes(key) || !Object.getOwnPropertyDescriptor(value, key).enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    throw new Error("tool_settings_snapshot_invalid");
  }
}
function limits(value, complete = true) {
  fields(value, complete ? Object.keys(bounds) : [], complete ? [] : Object.keys(bounds));
  const result = {};
  for (const key of Object.keys(value)) {
    const number = own(value, key), [min, max] = bounds[key];
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error("tool_settings_limits_invalid");
    result[key] = number;
  }
  return result;
}
function resolve(profile, overrides) {
  const result = { ...profile, ...overrides };
  if (Object.hasOwn(overrides, "modelRounds") && !Object.hasOwn(overrides, "slotRounds")) result.slotRounds = Math.max(2, result.modelRounds - 1);
  if (result.slotRounds >= result.modelRounds || result.transportAttempts < 2 * result.modelRounds || result.totalResultChars < result.resultChars) {
    throw new Error("tool_settings_limits_invalid");
  }
  return result;
}
function equal(a, b) {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}
function sameSettings(a, b) {
  return a.autonomyEnabled === b.autonomyEnabled && a.profile === b.profile && a.interjectionProfile === b.interjectionProfile && equal(a.overrides, b.overrides);
}
function project(snapshot) {
  fields(snapshot, ["revision", "settings", "source", "effective", "profiles"], ["status"]);
  const revision = own(snapshot, "revision"), source = own(snapshot, "source"), status = own(snapshot, "status");
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || !["default", "saved"].includes(source) ||
      ![undefined, "ok"].includes(status)) throw new Error("tool_settings_snapshot_invalid");
  const input = own(snapshot, "settings");
  fields(input, ["autonomyEnabled", "profile", "interjectionProfile", "overrides"]);
  if (typeof own(input, "autonomyEnabled") !== "boolean" || !presets.includes(own(input, "profile")) || own(input, "interjectionProfile") !== "light") {
    throw new Error("tool_settings_snapshot_invalid");
  }
  const settings = { autonomyEnabled: input.autonomyEnabled, profile: input.profile, interjectionProfile: "light", overrides: limits(own(input, "overrides"), false) };
  const list = own(snapshot, "profiles"), profiles = {};
  if (!Array.isArray(list) || list.length !== presets.length) throw new Error("tool_settings_snapshot_invalid");
  for (let index = 0; index < list.length; index++) {
    const row = own(list, String(index)); fields(row, ["name", "limits"]);
    const name = own(row, "name");
    if (!presets.includes(name) || Object.hasOwn(profiles, name)) throw new Error("tool_settings_snapshot_invalid");
    profiles[name] = limits(own(row, "limits")); resolve(profiles[name], {});
  }
  const effective = own(snapshot, "effective"); fields(effective, ["chat", "interjection"]);
  const chat = limits(own(effective, "chat")), interjection = limits(own(effective, "interjection"));
  if (!equal(chat, resolve(profiles[settings.profile], settings.overrides)) || !equal(interjection, profiles.light)) {
    throw new Error("tool_settings_snapshot_invalid");
  }
  return { revision, source, settings, profiles, effective: { chat, interjection } };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function command(action, text, title) {
  const button = element("button", text, "tool-settings-command"); button.type = "button";
  button.dataset.action = action; button.title = title || text; button.setAttribute("aria-label", button.title);
  return button;
}
function field(form, id, labelText, type) {
  const label = element("label", undefined, "tool-settings-field");
  const input = element(type === "select" ? "select" : "input"); input.id = id;
  if (type !== "select") input.type = type;
  input.setAttribute("aria-label", labelText);
  label.append(element("span", labelText), input); form.append(label);
  input.addEventListener("input", edited); input.addEventListener("change", edited);
  return input;
}
function mount() {
  const root = document.getElementById("toolSettingsPanel");
  if (!root) return false;
  if (refs.root === root) return true;
  const previous = refs.autonomy ? readEditor() : null;
  refs = { root, overrides: {} }; root.replaceChildren(); root.classList.add("tool-settings-workspace");
  const header = element("div", undefined, "tool-settings-head"); header.append(element("h3", "工具调度"));
  refs.refresh = command("refreshToolSettings", "\u21bb", "刷新工具调度设置"); refs.refresh.classList.add("icon-button");
  refs.reload = element("button", "重新载入配置", "tool-settings-command"); refs.reload.type = "button";
  refs.reload.addEventListener("click", reload);
  const toolbar = element("div", undefined, "tool-settings-commands"); toolbar.append(refs.refresh, refs.reload); header.append(toolbar);
  refs.notice = element("p", "尚未读取工具调度设置。", "tool-settings-notice"); refs.notice.id = "toolSettingsActionStatus";
  refs.notice.setAttribute("role", "status"); refs.notice.setAttribute("aria-live", "polite");
  const form = element("form", undefined, "tool-settings-editor"); form.addEventListener("submit", event => event.preventDefault());
  refs.autonomy = field(form, "toolAutonomyEnabled", "模型自主调度", "checkbox");
  refs.profile = field(form, "toolSettingsProfile", "普通聊天预设", "select");
  for (const name of presets) { const option = element("option", name); option.value = name; refs.profile.append(option); }
  const overrides = element("div", undefined, "tool-settings-overrides");
  for (const key of editable) {
    const row = element("div", undefined, "tool-settings-limit");
    const toggle = field(row, "toolSettingsOverride-" + key, labels[key] + "覆盖", "checkbox");
    const input = field(row, "toolSettingsLimit-" + key, labels[key], "number");
    input.min = String(bounds[key][0]); input.max = String(bounds[key][1]); input.step = "1";
    refs.overrides[key] = { toggle, input }; overrides.append(row);
  }
  refs.dirty = element("span", "尚未读取", "save-state neutral"); refs.save = command("saveToolSettings", "保存设置");
  const saveBar = element("div", undefined, "tool-settings-save"); saveBar.append(refs.dirty, refs.save);
  refs.light = element("dl", undefined, "tool-settings-readonly"); refs.light.setAttribute("aria-label", "插话固定 light 预算，只读");
  const passive = element("section", undefined, "tool-settings-passive"); passive.append(element("h4", "插话 · light · 只读"), refs.light);
  form.append(overrides, saveBar); root.append(header, refs.notice, form, passive);
  if (previous) applyEditor(previous);
  else if (baseline) fill(baseline.settings);
  return true;
}
function readEditor() {
  return { autonomyEnabled: refs.autonomy.checked, profile: refs.profile.value,
    values: Object.fromEntries(editable.map(key => [key, { enabled: refs.overrides[key].toggle.checked, value: refs.overrides[key].input.value }])) };
}
function applyEditor(editor) {
  refs.autonomy.checked = editor.autonomyEnabled; refs.profile.value = editor.profile;
  for (const key of editable) { refs.overrides[key].toggle.checked = editor.values[key].enabled; refs.overrides[key].input.value = editor.values[key].value; }
}
function settingsEditor(settings) {
  return { autonomyEnabled: settings.autonomyEnabled, profile: settings.profile,
    values: Object.fromEntries(editable.map(key => [key, { enabled: Object.hasOwn(settings.overrides, key),
      value: String(settings.overrides[key] ?? latest?.profiles[settings.profile][key] ?? "") }])) };
}
function fingerprint(editor) {
  return JSON.stringify([editor.autonomyEnabled, editor.profile, ...editable.map(key => [key, editor.values[key].enabled,
    editor.values[key].enabled ? editor.values[key].value : null])]);
}
function fill(settings) { applyEditor(settingsEditor(settings)); }
export function toolSettingsHasDrafts() {
  return Boolean(baseline && refs.autonomy && fingerprint(readEditor()) !== fingerprint(settingsEditor(baseline.settings)));
}
export function canDiscardToolSettingsDrafts() {
  return !busy && ((!toolSettingsHasDrafts() && !unknownWrite) || window.confirm("有未保存设置或未知保存结果。确认放弃草稿并核对最新配置？"));
}
function writable() { return host.mode === "browser" && baseline && latest && baseline.revision === latest.revision &&
  !requiresAuthenticatedRead && !unknownWrite && ["ready", "dirty"].includes(phase); }
function show(message, state = phase) {
  if (refs.notice) { refs.notice.textContent = message; refs.notice.dataset.state = state; }
}
function refreshNumbers() {
  if (!latest) return;
  for (const key of editable) if (!refs.overrides[key].toggle.checked) refs.overrides[key].input.value = String(latest.profiles[refs.profile.value]?.[key] ?? "");
}
function syncControls() {
  if (!refs.root) return;
  const blocked = busy || !writable();
  refs.root.setAttribute("aria-busy", String(busy));
  refs.refresh.disabled = busy || host.mode !== "browser";
  refs.reload.disabled = busy || host.mode !== "browser" || !latest;
  refs.autonomy.disabled = blocked; refs.profile.disabled = blocked;
  for (const key of editable) {
    refs.overrides[key].toggle.disabled = blocked;
    refs.overrides[key].input.disabled = blocked || !refs.overrides[key].toggle.checked;
  }
  refs.save.disabled = blocked || !toolSettingsHasDrafts();
  refs.dirty.textContent = toolSettingsHasDrafts() ? "未保存" : phase === "ready" ? "已载入" : "待核实";
  refs.dirty.classList.toggle("dirty", toolSettingsHasDrafts());
}
function edited() {
  if (host.mode !== "browser" || busy) return;
  refreshNumbers();
  if (["ready", "dirty"].includes(phase)) { phase = toolSettingsHasDrafts() ? "dirty" : "ready"; show(phase === "dirty" ? "设置有未保存修改。" : "设置未修改。"); }
  syncControls();
}
function renderLight() {
  refs.light.replaceChildren();
  for (const key of editable) refs.light.append(element("dt", labels[key]), element("dd", latest ? String(latest.effective.interjection[key]) : "未确认"));
}
function reload() {
  if (host.mode !== "browser" || requiresAuthenticatedRead || !latest || !canDiscardToolSettingsDrafts()) return;
  epoch++; unknownWrite = false; baseline = copy(latest); phase = "ready";
  fill(baseline.settings); show("已重新载入最新配置。", "ready"); syncControls();
}
export function invalidateToolSettingsView() {
  epoch++; latest = null; phase = "unknown"; unknownWrite ||= pendingWrite;
  if (!mount()) return;
  show(host.mode !== "browser" ? unsupported : "设置状态已失效，草稿已保留。", "unknown"); renderLight(); syncControls();
}
export function renderToolSettings(snapshot) {
  if (!mount()) return false;
  if (host.mode !== "browser") { invalidateToolSettingsView(); return false; }
  if (requiresAuthenticatedRead) {
    show("鉴权已失效，请重新读取设置；草稿已保留。", "authfailed"); renderLight(); syncControls(); return false;
  }
  let value;
  try { value = project(snapshot); } catch { invalidateToolSettingsView(); return false; }
  const dirty = toolSettingsHasDrafts(); epoch++; latest = value;
  unknownWrite ||= pendingWrite;
  if (!baseline || (!dirty && !unknownWrite && phase !== "conflict")) { baseline = copy(value); fill(value.settings); }
  phase = unknownWrite ? "unknown" : baseline.revision !== latest.revision || phase === "conflict" ? "conflict" : dirty ? "dirty" : "ready";
  const messages = { unknown: "保存结果待核对，草稿已保留，未自动重试。", conflict: "配置已在别处更新，草稿已保留。",
    dirty: "最新设置已读取，未保存草稿已保留。", ready: "工具调度设置已读取。" };
  refreshNumbers(); show(messages[phase]); renderLight(); syncControls(); return true;
}

export function toolSettingsActionTicket() { return mount() ? { epoch, fingerprint: fingerprint(readEditor()) } : null; }
export function toolSettingsTicketCurrent(ticket) { return host.mode === "browser" && ticket?.epoch === epoch; }
export function toolSettingsReadSucceeded(snapshot, ticket) {
  if (!toolSettingsTicketCurrent(ticket)) return false;
  try { project(snapshot); } catch { return false; }
  requiresAuthenticatedRead = false;
  return renderToolSettings(snapshot);
}
export function setToolSettingsBusy(value, writing = false) { busy = value; pendingWrite = value && writing; syncControls(); }
export function toolSettingsPayload() {
  if (!writable() || busy) throw new Error("tool_settings_view_locked");
  if (!toolSettingsHasDrafts()) throw new Error("tool_settings_not_dirty");
  const settings = copy(baseline.settings); settings.autonomyEnabled = refs.autonomy.checked; settings.profile = refs.profile.value;
  if (!presets.includes(settings.profile) || typeof settings.autonomyEnabled !== "boolean") throw new Error("tool_settings_limits_invalid");
  for (const key of editable) {
    delete settings.overrides[key];
    if (!refs.overrides[key].toggle.checked) continue;
    const text = refs.overrides[key].input.value;
    if (!/^\d+$/.test(text)) throw new Error("tool_settings_limits_invalid");
    settings.overrides[key] = Number(text);
  }
  limits(settings.overrides, false); resolve(latest.profiles[settings.profile], settings.overrides);
  return { action: "save", expectedRevision: baseline.revision, settings };
}
export function toolSettingsReadFailed(error) {
  invalidateToolSettingsView(); phase = [401, 403].includes(error?.status) ? "authfailed" : "unknown";
  requiresAuthenticatedRead ||= phase === "authfailed";
  show(phase === "authfailed" ? "无权读取工具调度设置，草稿已保留。" : "工具调度设置读取失败，草稿已保留。", phase); syncControls();
}
export function toolSettingsWriteFailed(error, unknown) {
  epoch++; unknownWrite ||= unknown; phase = unknownWrite ? "unknown" : error?.status === 409 ? "conflict" : "authfailed";
  if ([401, 403].includes(error?.status)) { requiresAuthenticatedRead = true; latest = null; renderLight(); }
  const messages = { unknown: "保存结果未知，未自动重试；草稿已保留，请核对最新配置。",
    conflict: "配置冲突，未覆盖；草稿已保留，请核对最新配置。", authfailed: "保存未获授权，草稿已保留。" };
  show(messages[phase]); syncControls();
}
export function toolSettingsWriteSucceeded(snapshot, ticket, submitted) {
  if (!toolSettingsTicketCurrent(ticket) || own(snapshot, "status") !== "ok") return false;
  let value;
  try { value = project(snapshot); } catch { return false; }
  if (!sameSettings(value.settings, submitted)) return false;
  const editedDuringSave = fingerprint(readEditor()) !== ticket.fingerprint;
  epoch++; baseline = copy(value); latest = value; unknownWrite = false;
  if (!editedDuringSave) fill(value.settings);
  phase = toolSettingsHasDrafts() ? "dirty" : "ready";
  show(phase === "dirty" ? "设置已保存，仍有未保存修改。" : "工具调度设置已保存。"); renderLight(); syncControls(); return true;
}
export function toolSettingsNotice() { return refs.notice?.textContent || "设置状态未确认。"; }
