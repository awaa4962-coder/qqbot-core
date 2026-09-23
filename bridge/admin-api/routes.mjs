// bridge/admin-api/routes.mjs - local management routes.

import {
  isAuthorizedAdminRequest,
  adminForbiddenPayload,
} from "./auth.mjs";
import { buildAuditStatus, recordAdminAudit } from "./audit-log.mjs";
import { applyApiProviderAction, buildApiProviderManagerSnapshot } from "./api-provider-manager.mjs";
import { buildBackupRestorePlan, createSafeBackup, listSafeBackups } from "./backup-manager.mjs";
import { buildCommandCatalog } from "./command-catalog.mjs";
import { buildCapabilityCatalog } from "../capabilities/catalog.mjs";
import { buildCommandScaffold } from "./command-scaffold.mjs";
import { buildEditableConfigSnapshot, saveEditableConfig } from "./config-editor.mjs";
import { buildReplyDiagnosis } from "./diagnose-reply.mjs";
import { listLogFiles, readLogTail } from "./log-reader.mjs";
import { applyMemeKnowledgeAction, buildMemeKnowledgeSnapshot } from "./meme-manager.mjs";
import { buildModuleCatalog } from "./module-catalog.mjs";
import { buildPluginCatalog } from "./plugin-catalog.mjs";
import { buildRuntimeStatus } from "./runtime-status.mjs";
import { applyStickerManagerAction, buildStickerManagerSnapshot } from "./sticker-manager.mjs";
import { loadStickerPreview } from "../features/stickers/index.mjs";
import { buildProjectSelfDescription, buildWorkflowDescription } from "../self-description.mjs";
import { CFG } from "../config.mjs";
import { listMessageTraces } from "../diagnostics/message-trace.mjs";
import { replayService } from "../diagnostics/replay.mjs";
import { summaryManager } from "./summary-manager.mjs";
import { adminTaskManager } from "./task-manager.mjs";
import { conversationSummaryService } from "../features/conversation-summary/service.mjs";
import { buildChatDeliverySnapshot, resolveChatDelivery } from "../cognition/delivery-ledger.mjs";
import { buildMemoryManagerSnapshot, applyMemoryManagerAction } from "./memory-manager.mjs";
import { getApiUsageSnapshot } from "../api-providers/usage-metrics.mjs";

const GET_ROUTES = new Map([
  ["/admin/status", handleStatusRoute],
  ["/admin/commands", handleCommandsRoute],
  ["/admin/capabilities", handleCapabilitiesRoute],
  ["/admin/modules", handleModulesRoute],
  ["/admin/plugins", handlePluginsRoute],
  ["/admin/workflows", handleWorkflowsRoute],
  ["/admin/self-description", handleSelfDescriptionRoute],
  ["/admin/audit", handleAuditRoute],
  ["/admin/backups", handleBackupsRoute],
  ["/admin/logs", handleLogsRoute],
  ["/admin/config", handleConfigReadRoute],
  ["/admin/api-providers", handleApiProvidersReadRoute],
  ["/admin/api-usage", handleApiUsageRoute],
  ["/admin/memes", handleMemesReadRoute],
  ["/admin/stickers", handleStickersReadRoute],
  ["/admin/diagnose/traces", handleTracesRoute],
  ["/admin/diagnose/deliveries", handleDeliveriesReadRoute],
  ["/admin/memory", handleMemoryReadRoute],
  ["/admin/diagnose/replay", handleReplayReadRoute],
  ["/admin/summaries", handleSummariesReadRoute],
  ["/admin/tasks", handleTasksReadRoute],
  ["/admin/conversation-summaries", handleConversationSummariesRoute],
]);

const POST_ROUTES = new Map([
  ["/admin/config", handleConfigSaveRoute],
  ["/admin/api-providers", handleApiProvidersSaveRoute],
  ["/admin/memes", handleMemesSaveRoute],
  ["/admin/stickers", handleStickersSaveRoute],
  ["/admin/diagnose/reply", handleReplyDiagnoseRoute],
  ["/admin/diagnose/deliveries", handleDeliveriesPostRoute],
  ["/admin/memory", handleMemoryPostRoute],
  ["/admin/diagnose/replay", handleReplayPostRoute],
  ["/admin/summaries", handleSummariesPostRoute],
  ["/admin/tasks", handleTasksPostRoute],
  ["/admin/command-scaffold", handleCommandScaffoldRoute],
  ["/admin/backups", handleBackupsPostRoute],
]);

const STICKER_PREVIEW_PATH = "/admin/stickers/image";

export async function handleAdminApiRequest(req, res, context = {}) {
  const pathname = context.pathname || "/";
  const url = context.url || new URL(req.url || "/", "http://localhost");
  const sendJson = context.sendJson;
  if (!sendJson) throw new Error("sendJson is required");

  if (!pathname.startsWith("/admin/")) return false;
  if (!isAuthorizedAdminRequest(req, {
    containerized: context.containerized,
    requiredToken: context.requiredToken,
  })) {
    sendJson(res, 403, adminForbiddenPayload());
    return true;
  }
  if (pathname === STICKER_PREVIEW_PATH) {
    await handleStickerPreviewRoute(req, res, { ...context, pathname, url, sendJson });
    return true;
  }

  return await handleAuthorizedAdminRoute(req, res, { pathname, url, sendJson, loadMemeArchive: context.loadMemeArchive });
}

async function handleStickerPreviewRoute(req, res, context) {
  if (req.method !== "GET") {
    context.sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const preview = await (context.loadStickerPreview || loadStickerPreview)(
    context.url.searchParams.get("id") || ""
  );
  if (!preview.ok) {
    context.sendJson(res, 404, { error: "sticker preview unavailable" });
    return;
  }
  res.writeHead(200, {
    "Cache-Control": "private, max-age=300",
    "Content-Length": String(preview.buffer.length),
    "Content-Type": preview.mimeType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(preview.buffer);
}

async function handleAuthorizedAdminRoute(req, res, context) {
  recordRouteAudit(req, context);
  if (await dispatchAdminRoute(req, res, context)) return true;
  context.sendJson(res, 404, { error: "admin route not found" });
  return true;
}

async function dispatchAdminRoute(req, res, context) {
  const routes = req.method === "GET" ? GET_ROUTES : req.method === "POST" ? POST_ROUTES : null;
  const handler = routes?.get(context.pathname);
  if (!handler) return false;
  await handler(req, res, context);
  return true;
}

function handleStatusRoute(_req, res, context) {
  context.sendJson(res, 200, buildRuntimeStatus(), 2);
}

function handleApiUsageRoute(_req, res, context) {
  try {
    const allowed = new Set(["days", "provider", "model", "task", "position", "promptVersion", "configuredMode", "effectiveMode"]);
    const values = Object.fromEntries(context.url.searchParams);
    if (Object.keys(values).some(key => !allowed.has(key))) throw new Error("用量筛选参数无效");
    if (values.days !== undefined && !["1", "7", "30"].includes(values.days)) throw new Error("统计时间范围无效");
    context.sendJson(res, 200, getApiUsageSnapshot(values));
  } catch { context.sendJson(res, 400, { error: "用量查询参数无效或记录暂时不可读" }); }
}

function handleCommandsRoute(_req, res, context) {
  context.sendJson(res, 200, buildCommandCatalog(), 2);
}

function handleCapabilitiesRoute(_req, res, context) {
  context.sendJson(res, 200, buildCapabilityCatalog({
    surface: "console",
  }), 2);
}

function handleModulesRoute(_req, res, context) {
  context.sendJson(res, 200, buildModuleCatalog(), 2);
}

function handlePluginsRoute(_req, res, context) {
  context.sendJson(res, 200, buildPluginCatalog(), 2);
}

function handleWorkflowsRoute(_req, res, context) {
  context.sendJson(res, 200, buildWorkflowDescription(), 2);
}

function handleSelfDescriptionRoute(_req, res, context) {
  context.sendJson(res, 200, buildProjectSelfDescription(), 2);
}

function handleAuditRoute(_req, res, context) {
  context.sendJson(res, 200, buildAuditStatus({ tail: context.url.searchParams.get("tail") }), 2);
}

function handleBackupsRoute(_req, res, context) {
  context.sendJson(res, 200, listSafeBackups(context.root, { backupRoot: CFG.adminBackupDir }), 2);
}

function handleConfigReadRoute(_req, res, context) {
  context.sendJson(res, 200, buildEditableConfigSnapshot(), 2);
}

function handleApiProvidersReadRoute(_req, res, context) {
  context.sendJson(res, 200, buildApiProviderManagerSnapshot({ root: context.root }), 2);
}

function handleMemesReadRoute(_req, res, context) {
  context.sendJson(res, 200, (context.loadMemeArchive || buildMemeKnowledgeSnapshot)(), 2);
}

function handleStickersReadRoute(_req, res, context) {
  context.sendJson(res, 200, buildStickerManagerSnapshot(), 2);
}

function handleLogsRoute(_req, res, context) {
  const { url, sendJson } = context;
  try {
    const file = url.searchParams.get("file") || "";
    const tail = url.searchParams.get("tail") || "";
    const filter = url.searchParams.get("filter") || "";
    sendJson(res, 200, {
      files: listLogFiles(),
      current: readLogTail({ file, tail, filter }),
    }, 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleConfigSaveRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    sendJson(res, 200, saveEditableConfig(payload), 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleApiProvidersSaveRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    const result = await applyApiProviderAction(payload, { root: context.root });
    sendJson(res, 200, result, 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleMemesSaveRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    sendJson(res, 410, await applyMemeKnowledgeAction(payload), 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleStickersSaveRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    sendJson(res, 200, await applyStickerManagerAction(payload), 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleReplyDiagnoseRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    sendJson(res, 200, buildReplyDiagnosis(payload), 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function handleTracesRoute(_req, res, context) {
  const query = Object.fromEntries(context.url.searchParams);
  context.sendJson(res, 200, listMessageTraces(query), 2);
}

function handleDeliveriesReadRoute(_req, res, context) {
  context.sendJson(res, 200, buildChatDeliverySnapshot(Object.fromEntries(context.url.searchParams)));
}

function handleMemoryReadRoute(_req, res, context) {
  try { context.sendJson(res, 200, buildMemoryManagerSnapshot(Object.fromEntries(context.url.searchParams))); }
  catch (error) { context.sendJson(res, error.statusCode || 503, { error: error.statusCode ? error.message : "记忆暂不可用，请检查存储。" }); }
}

async function handleMemoryPostRoute(req, res, context) {
  try { context.sendJson(res, 200, applyMemoryManagerAction(await readJsonRequestBody(req))); }
  catch (error) { context.sendJson(res, error.statusCode || 503, { error: error.statusCode ? error.message : "记忆未保存，请刷新后检查。" }); }
}

async function handleDeliveriesPostRoute(req, res, context) {
  try { context.sendJson(res, 200, resolveChatDelivery(await readJsonRequestBody(req))); }
  catch { context.sendJson(res, 400, { error: "核实未保存：操作无效、记录仍在处理或状态不可用。请刷新后检查。" }); }
}

function handleSummariesReadRoute(_req, res, context) {
  try { context.sendJson(res, 200, summaryManager.snapshot(Object.fromEntries(context.url.searchParams))); }
  catch (error) { context.sendJson(res, 400, { error: error.message }); }
}

function handleTasksReadRoute(_req, res, context) {
  try { context.sendJson(res, 200, adminTaskManager.snapshot(Object.fromEntries(context.url.searchParams))); }
  catch (error) { context.sendJson(res, 400, { error: error.message }); }
}

function handleConversationSummariesRoute(_req, res, context) {
  try { context.sendJson(res, 200, conversationSummaryService.snapshot()); }
  catch { context.sendJson(res, 503, { error: "暂时读不到成员总结任务，请稍后刷新。" }); }
}

async function handleTasksPostRoute(req, res, context) {
  try { context.sendJson(res, 202, adminTaskManager.start(await readJsonRequestBody(req))); }
  catch (error) { context.sendJson(res, 400, { error: error.message }); }
}

async function handleSummariesPostRoute(req, res, context) {
  try { context.sendJson(res, 200, await summaryManager.act(await readJsonRequestBody(req))); }
  catch (error) { context.sendJson(res, 400, { error: error.message }); }
}

function handleReplayReadRoute(_req, res, context) {
  try {
    context.sendJson(res, 200, replayService.snapshot(), 2);
  } catch (error) {
    context.sendJson(res, 400, { error: error.message });
  }
}

async function handleReplayPostRoute(req, res, context) {
  try {
    const payload = await readJsonRequestBody(req);
    context.sendJson(res, 200, await replayService.act(payload), 2);
  } catch (error) {
    context.sendJson(res, 400, { error: error.message });
  }
}

async function handleCommandScaffoldRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    sendJson(res, 200, buildCommandScaffold(payload, { root: context.root }), 2);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleBackupsPostRoute(req, res, context) {
  const { sendJson } = context;
  try {
    const payload = await readJsonRequestBody(req);
    if (payload.action === "create") {
      sendJson(res, 200, createSafeBackup({
        root: context.root,
        name: payload.name,
        backupRoot: CFG.adminBackupDir,
      }), 2);
      return;
    }
    if (payload.action === "restore-plan") {
      sendJson(res, 200, buildBackupRestorePlan({
        root: context.root,
        name: payload.name,
        backupRoot: CFG.adminBackupDir,
      }), 2);
      return;
    }
    sendJson(res, 400, { error: "unknown backup action" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function recordRouteAudit(req, context) {
  if (context.pathname === "/admin/audit") return;
  recordAdminAudit({
    method: req.method,
    pathname: context.pathname,
    remoteAddress: req.socket?.remoteAddress,
    queryKeys: context.url.searchParams.keys(),
  });
}

async function readJsonRequestBody(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += data.length;
    if (total > maxBytes) throw new Error("admin request body too large");
    chunks.push(data);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}
