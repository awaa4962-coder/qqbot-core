import { host } from "./state.js";
import { beginAction, endAction, finishActivity, toast } from "./activity.js";
import { toolSettingsReadSucceeded, toolSettingsActionTicket, toolSettingsTicketCurrent, setToolSettingsBusy,
  toolSettingsPayload, toolSettingsReadFailed, toolSettingsWriteFailed, toolSettingsWriteSucceeded, toolSettingsNotice } from "../pages/tool-settings.js";

const GROUP = "toolSettings";
const actions = new Set(["refreshToolSettings", "saveToolSettings"]);
export function isToolSettingsAction(action) { return actions.has(action); }
function feedback(message, ok, silent) {
  const tone = ok ? "success" : "error";
  if (!silent) toast(message, tone);
  finishActivity(message, tone, message);
}
function responseError(value) {
  const code = value?.error || value?.code;
  const status = value?.statusCode || value?.status;
  return { status: Number.isInteger(status) ? status : code === "tool_settings_conflict" ? 409 : undefined };
}
export async function runToolSettingsAction(action, _button, options = {}) {
  if (!isToolSettingsAction(action)) return false;
  const silent = options.silent === true, writing = action === "saveToolSettings";
  if (host.mode !== "browser") { feedback("工具调度设置仅开放于 Linux 浏览器控制台。", false, silent); return false; }
  if (!beginAction(GROUP, null, silent)) return false;
  let ticket, sent = false;
  try {
    const body = writing ? toolSettingsPayload() : {};
    ticket = toolSettingsActionTicket();
    if (!ticket) throw new Error("tool_settings_view_locked");
    setToolSettingsBusy(true, writing);
    sent = writing;
    const result = await host.call(writing ? "saveToolSettings" : "getToolSettings", body);
    if (!toolSettingsTicketCurrent(ticket)) { feedback(toolSettingsNotice(), false, silent); return false; }
    if (!writing) {
      const ok = toolSettingsReadSucceeded(result, ticket);
      if (!ok) toolSettingsReadFailed(responseError(result));
      feedback(toolSettingsNotice(), ok, silent); return ok;
    }
    const ok = toolSettingsWriteSucceeded(result, ticket, body.settings);
    if (!ok) {
      const error = responseError(result);
      toolSettingsWriteFailed(error, ![401, 403, 409].includes(error.status));
    }
    feedback(toolSettingsNotice(), ok, silent); return ok;
  } catch (error) {
    if (ticket && !toolSettingsTicketCurrent(ticket)) { feedback(toolSettingsNotice(), false, silent); return false; }
    const failure = responseError(error);
    if (!writing) toolSettingsReadFailed(failure);
    else if (sent) toolSettingsWriteFailed(failure, ![401, 403, 409].includes(failure.status));
    const message = sent || !writing ? toolSettingsNotice() : error?.message === "tool_settings_limits_invalid"
      ? "数字范围或预算组合无效，未提交。" : "设置尚未读取、未修改或状态待核实，未提交。";
    feedback(message, false, silent); return false;
  } finally { endAction(GROUP); setToolSettingsBusy(false); }
}
