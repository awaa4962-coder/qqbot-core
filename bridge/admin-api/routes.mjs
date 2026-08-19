// bridge/admin-api/routes.mjs - local management routes.

import { isAuthorizedAdminRequest, adminForbiddenPayload, isLoopbackAddress } from "./auth.mjs";
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
import { getMemeStore } from "../knowledge/memes/index.mjs";
import { CFG } from "../config.mjs";

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
  ["/admin/memes", handleMemesReadRoute],
  ["/admin/stickers", handleStickersReadRoute],
]);

const POST_ROUTES = new Map([
  ["/admin/config", handleConfigSaveRoute],
  ["/admin/api-providers", handleApiProvidersSaveRoute],
  ["/admin/memes", handleMemesSaveRoute],
  ["/admin/stickers", handleStickersSaveRoute],
  ["/admin/diagnose/reply", handleReplyDiagnoseRoute],
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
  if (pathname === STICKER_PREVIEW_PATH) {
    // WebView image tags cannot attach the admin token. Keep this opaque-ID route loopback-only.
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, adminForbiddenPayload());
      return true;
    }
    await handleStickerPreviewRoute(req, res, { ...context, pathname, url, sendJson });
    return true;
  }
  if (!isAuthorizedAdminRequest(req)) {
    sendJson(res, 403, adminForbiddenPayload());
    return true;
  }

  return await handleAuthorizedAdminRoute(req, res, { pathname, url, sendJson });
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
    "Cross-Origin-Resource-Policy": "cross-origin",
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

function handleCommandsRoute(_req, res, context) {
  context.sendJson(res, 200, buildCommandCatalog(), 2);
}

function handleCapabilitiesRoute(_req, res, context) {
  context.sendJson(res, 200, buildCapabilityCatalog({
    surface: "console",
    memeMode: getMemeStore().mode,
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
  context.sendJson(res, 200, buildMemeKnowledgeSnapshot(), 2);
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
    sendJson(res, 200, await applyMemeKnowledgeAction(payload), 2);
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
