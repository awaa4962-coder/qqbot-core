import { host } from "./state.js";
import { beginAction, endAction, finishActivity, toast } from "./activity.js";
import { setMcpBusy, mcpActionTicket, mcpTicketCurrent, mcpServerPayload, mcpToolPayload,
  mcpConnectionPayload, mcpReadFailed, mcpReadSucceeded, mcpWriteFailed, mcpWriteSucceeded, mcpBeginWrite, mcpEndWrite } from "../pages/mcp.js";

const actions = new Set(["refreshMcp", "saveMcpServer", "connectMcpServer", "refreshMcpTools", "disconnectMcpServer", "approveMcpTool"]);
const connections = { connectMcpServer: "connect", refreshMcpTools: "refresh", disconnectMcpServer: "disconnect" };
const GROUP = "mcpServices";
export function isMcpAction(action) { return actions.has(action); }
function feedback(message, ok, silent) {
  const tone = ok ? "success" : "error";
  if (!silent) toast(message, tone);
  finishActivity(message, tone, message);
}
function payload(action, button) {
  if (action === "saveMcpServer") return mcpServerPayload();
  if (action === "approveMcpTool") return mcpToolPayload(button?.dataset.serverId, button?.dataset.toolName);
  return mcpConnectionPayload(connections[action], button?.dataset.serverId);
}
export async function runMcpAction(action, button, options = {}) {
  if (!isMcpAction(action)) return false;
  const silent = options.silent === true;
  if (host.mode !== "browser") { feedback("MCP 管理仅开放于 Linux 浏览器控制台。", false, silent); return false; }
  if (!beginAction(GROUP, null, silent)) return false;
  const ticket = mcpActionTicket();
  let sent = false;
  try {
    // Validate drafts before locking controls; all writes share this action group.
    const body = action === "refreshMcp" ? null : payload(action, button);
    setMcpBusy(true);
    if (!body) {
      const snapshot = await host.call("getMcpServices", {});
      if (!mcpTicketCurrent(ticket)) return false;
      const ok = mcpReadSucceeded(snapshot, ticket);
      if (!ok) mcpReadFailed({});
      feedback(ok && snapshot.status === "ready" ? "MCP 只读状态已刷新。" : "MCP 配置状态不可用。", ok && snapshot.status === "ready", silent);
      return ok;
    }
    mcpBeginWrite(ticket, body);
    sent = true;
    const result = await host.call("applyMcpAction", body);
    if (!mcpTicketCurrent(ticket)) return false;
    if (result?.ok !== true) {
      mcpWriteFailed(result, result?.ok !== false);
      feedback(result?.reason === "revision_conflict" ? "配置冲突；草稿已保留。" : "操作未确认成功；未自动重试。", false, silent);
      return false;
    }
    const snapshot = result.snapshot || result;
    const acknowledgement = body.action === "save" ? action === "approveMcpTool" ?
      { toolKey: button.dataset.serverId + "/" + button.dataset.toolName } : {} : null;
    const ok = mcpWriteSucceeded(snapshot, ticket, acknowledgement);
    if (!ok) mcpWriteFailed({}, true);
    feedback(ok ? "MCP 操作已完成。" : "响应不完整，结果待核对。", ok, silent);
    return ok;
  } catch (error) {
    if (!mcpTicketCurrent(ticket)) return false;
    let connectionFailed = false;
    if (action === "refreshMcp") mcpReadFailed(error);
    else if (sent) {
      const knownConnectionFailure = error?.status === 400 && error.mcpFailure?.ok === false &&
        error.mcpFailure.reason === "connection_failed" && ["connect", "refresh"].includes(connections[action]);
      connectionFailed = mcpWriteFailed(knownConnectionFailure ? error.mcpFailure : error,
        !knownConnectionFailure && ![401, 403, 409].includes(error?.status)) === true;
    }
    const messages = { mcp_server_draft_pending: "服务草稿尚未保存；工具许可未提交。", mcp_drafts_pending: "请先保存或放弃编辑，再执行连接操作。",
      mcp_tool_draft_pending: "工具许可尚未保存；服务草稿未提交。",
      mcp_schema_conflict: "工具定义已变化，许可未提交。", mcp_view_locked: "当前状态不允许写入，请刷新并核对配置。" };
    feedback(messages[error?.message] || (connectionFailed ? "连接或发现失败；服务状态已更新，未自动重试。" :
      sent ? "操作结果未确认；未自动重试，草稿已保留。" : "表单或工具许可未通过校验，未提交。"), false, silent);
    return false;
  } finally { mcpEndWrite(ticket); endAction(GROUP); setMcpBusy(false); }
}
