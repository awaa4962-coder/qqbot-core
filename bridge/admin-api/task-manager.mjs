import path from "node:path";
import { CFG } from "../config.mjs";
import { createTaskRunner } from "../tasks/runner.mjs";
import { applyMemeKnowledgeAction } from "./meme-manager.mjs";
import { applyStickerManagerAction } from "./sticker-manager.mjs";
import { replayService } from "../diagnostics/replay.mjs";

const ALLOWED = Object.freeze({
  memes: ["run-web-update", "research-web"],
  stickers: ["sync", "analyze", "capabilities", "cleanup"],
  replay: ["generate"],
});

export function createAdminTaskManager(options = {}) {
  const tasks = createTaskRunner({ filename: options.filename || path.join(CFG.dataRoot, ".qqfriend", "tasks", "admin.json"),
    maxConcurrent: 2, historyLimit: 20 });
  const handlers = options.handlers || { memes: applyMemeKnowledgeAction, stickers: applyStickerManagerAction, replay: payload => replayService.act(payload) };

  function start(input = {}) {
    const module = String(input.module || "");
    const payload = normalizePayload(module, input.payload);
    return tasks.start({
      scope: module, meta: { module }, action: payload.action, timeoutMs: options.timeoutMs,
      run: async ({ progress, signal }) => {
        progress("running");
        const result = await handlers[module](payload, { signal, onProgress: progress });
        return { ...result, ok: result?.ok !== false && result?.result?.ok !== false };
      },
      resultView: compactResult,
    });
  }
  function snapshot(input = {}) { return input.id ? { task: tasks.inspect(String(input.id)) } : { tasks: tasks.list() }; }
  return { start, snapshot, wait: tasks.wait };
}

function normalizePayload(module, value) {
  const input = value && typeof value === "object" ? value : {};
  const action = String(input.action || "");
  if (!Object.hasOwn(ALLOWED, module) || !ALLOWED[module].includes(action)) throw new Error("不支持的后台任务");
  if (module === "memes" && action === "research-web") {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) throw new Error("请填写 200 字以内的查询词");
    return { action, query: input.query.trim() };
  }
  if (module === "memes") return { action };
  if (module === "replay") return { action, caseId: String(input.caseId || "").slice(0, 80) };
  return batchPayload(input, action);
}

function batchPayload(input, action) {
  const size = Number(input.limit ?? input.analysisLimit ?? 4);
  const limit = Number.isFinite(size) ? Math.max(1, Math.min(4, Math.floor(size))) : 4;
  return { action, limit, analysisLimit: limit, analyze: input.analyze !== false };
}

function compactResult(result) {
  if (!result || typeof result !== "object") return result;
  // Catalogs are already persistent and can be refreshed; keep only the operation's result.
  const { snapshot: _snapshot, ...value } = result;
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return { ok: result.ok !== false, refreshRequired: true };
  return value;
}

export const adminTaskManager = createAdminTaskManager();
