import { host } from "./state.js";
import { $ } from "./dom.js";
import { beginAction, endAction, finishActivity, groupIsBusy, toast } from "./activity.js";
import { mountAgentWrites } from "../agent-writes.js";

const ACTION = "refreshAgentWrites";
const UNSUPPORTED = "Windows 桌面版暂不支持读取 Agent 写入状态。";
const actions = new Set(["set_name", "set_style", "memory_create", "memory_update", "memory_remove", "create", "cancel"]);
const phases = new Set(["pending", "executing", "applied", "not_applied", "unknown", "revoked", "expired", "invalidated",
  "armed", "sending", "sent", "failed", "cancelled", "partial", "interrupted"]);
const data = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
let viewGeneration = 0;

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = data(prototype, "constructor");
  return Object.getPrototypeOf(prototype) === null && typeof constructor === "function" && data(constructor, "name") === "Object";
}
const own = (value, key) => record(value) ? data(value, key) : undefined;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402271999999;

function section(value, kind) {
  const status = own(value, "status");
  if (status === "unavailable") return { status, items: [] };
  const items = own(value, "items");
  if (status !== "ready" || !Array.isArray(items) || items.length > 128) return undefined;
  const rows = []; const refs = new Set();
  for (let index = 0; index < items.length; index++) {
    const item = data(items, String(index));
    const ref = own(item, "ref"); const phase = own(item, "phase"); const createdAt = own(item, "createdAt");
    const deadlineKey = kind === "confirmations" ? "expiresAt" : "dueAt";
    const deadline = own(item, deadlineKey);
    const prefix = kind === "confirmations" ? "cf_" : "rem_";
    const action = kind === "confirmations" ? own(item, "action") : undefined;
    if (typeof ref !== "string" || ref.length !== prefix.length + 32 || !ref.startsWith(prefix) ||
        !/^[a-f0-9]{32}$/.test(ref.slice(prefix.length)) || refs.has(ref) || !phases.has(phase) ||
        !timestamp(createdAt) || !timestamp(deadline) || deadline <= createdAt ||
        kind === "confirmations" && !actions.has(action)) return undefined;
    refs.add(ref);
    rows.push({ ref, ...(kind === "confirmations" ? { action } : {}), phase, createdAt, [deadlineKey]: deadline });
  }
  return { status, items: rows };
}

function project(value) {
  try {
    const status = own(value, "status"); const enabled = own(value, "enabled");
    if (typeof enabled !== "boolean") return undefined;
    if (status === "unavailable") return { status, enabled,
      confirmations: { status: "unavailable", items: [] }, reminders: { status: "unavailable", items: [] } };
    if (status !== "ready") return undefined;
    const confirmations = section(own(value, "confirmations"), "confirmations");
    const reminders = section(own(value, "reminders"), "reminders");
    return confirmations && reminders ? { status, enabled, confirmations, reminders } : undefined;
  } catch { return undefined; }
}

function notice(message, state) {
  const element = $("agentWriteActionStatus");
  if (element) { element.textContent = message; if (element.dataset) element.dataset.state = state; }
}

function syncControls() {
  const busy = groupIsBusy(ACTION);
  const panel = $("agentWritesPanel");
  panel?.setAttribute("aria-busy", String(busy));
  for (const button of panel?.querySelectorAll('[data-action="refreshAgentWrites"]') || []) button.disabled = busy;
}

function unsupported() {
  const panel = $("agentWritesPanel");
  if (panel) {
    panel.textContent = UNSUPPORTED; panel.setAttribute?.("aria-busy", "false");
  }
  notice(UNSUPPORTED, "unavailable");
}

export function isAgentWriteAction(action) { return action === ACTION; }

export function invalidateAgentWriteView() {
  viewGeneration++;
  if (host.mode !== "browser") { unsupported(); return; }
  const panel = $("agentWritesPanel");
  if (panel) mountAgentWrites(panel, null);
  notice("写入状态未确认，旧记录已清除。", "error"); syncControls();
}

export function renderAgentWriteSnapshot(snapshot, { generation } = {}) {
  if (generation !== undefined && generation !== viewGeneration) return false;
  if (host.mode !== "browser") { viewGeneration++; unsupported(); return false; }
  const value = project(snapshot);
  if (!value) { invalidateAgentWriteView(); return false; }
  viewGeneration++;
  const panel = $("agentWritesPanel");
  if (panel) mountAgentWrites(panel, value);
  const readable = value.status === "ready" && value.confirmations.status === "ready" && value.reminders.status === "ready";
  notice(readable ? value.enabled ? "写入元数据已刷新。" : "写入功能未开放。" : "写入状态无法完整读取，未显示不可用服务的旧记录。", readable ? "ready" : "unavailable");
  syncControls(); return true;
}

export async function runAgentWriteAction(action, _button, options = {}) {
  if (!isAgentWriteAction(action)) return;
  if (host.mode !== "browser") { viewGeneration++; unsupported(); return; }
  const silent = options.silent === true;
  // Keep the fixed-size refresh icon unchanged; this region owns pending controls across remounts.
  if (!beginAction(ACTION, null, silent)) return;
  const generation = viewGeneration;
  notice("正在读取写入状态，结果尚未确认。", "loading"); syncControls();
  try {
    const snapshot = await host.call("getAgentActions", {});
    if (generation !== viewGeneration) return;
    const value = project(snapshot);
    if (!value) throw new Error("write_state_unknown");
    if (!renderAgentWriteSnapshot(value, { generation })) return;
    const status = $("agentWriteActionStatus");
    const message = status?.textContent || "写入状态未确认。";
    const tone = status?.dataset.state === "ready" ? "success" : "error";
    if (!silent) toast(message, tone);
    finishActivity(message, tone, message);
  } catch (error) {
    if (generation !== viewGeneration) return;
    invalidateAgentWriteView();
    const message = [401, 403].includes(error?.status) ? "无权读取写入状态，旧记录已清除。"
      : error?.status === 404 ? "写入状态读取接口未开放，旧记录已清除。" : "写入状态读取失败，旧记录已清除。";
    notice(message, "error");
    if (!silent) toast(message, "error");
    finishActivity(message, "error", message);
  } finally { endAction(ACTION); syncControls(); }
}
