import { apiProviderPayload, apiRoutesPayload, renderApiProviders, startNewApiProvider } from "../pages/api.js";
import { renderCapabilities } from "../pages/capabilities.js";
import { configPayload, renderConfig, renderConfigEditor } from "../pages/configuration.js";
import { diagnosePayload, formatDiagnoseResult, renderDiagnoseSummary } from "../pages/diagnose-message.js";
import { renderLogs } from "../pages/logs.js";
import { addMemeSourceRow, applyMemeResearch, clearMemeForm, confirmDiscardMemeChanges, formatMemeOperationResult, memeFormPayload, renderMemes, selectedMemeName, selectedMemeQuery } from "../pages/memes.js";
import { markStatusStale, renderSnapshot, renderStoppedStatus } from "../pages/overview.js";
import { renderStickerSimulation, renderStickers, stickerEntryPayload, stickerSettingsPayload, stickerSimulationPayload } from "../pages/stickers.js";
import { actionGroup, beginAction, endAction, finishActivity, showActivity, toast } from "./activity.js";
import { applyBackground } from "./appearance.js";
import { $, setOutput, splitList } from "./dom.js";
import { ACTION_DONE, ACTION_LABELS, STICKER_ACTIONS } from "./metadata.js";
import { host, uiState } from "./state.js";
import { callManagedAction, taskPhaseLabel } from "./tasks.js";

export function validateAction(action) {
  if (action === "refreshConfig" && uiState.configDirty) {
    return window.confirm("当前配置有未保存修改。确定重新读取并放弃这些修改吗？");
  }
  if (action === "saveConfig") {
    if (!splitList($("cfgBotNames").value).length) {
      toast("机器人名不能为空。", "error");
      document.querySelector('[data-list-editor-for="cfgBotNames"] input')?.focus();
      return false;
    }
    return window.confirm(host.mode === "browser" ? "将保存非密钥配置，重启 Bridge 后生效。确定保存吗？" : "将保存非密钥配置并重启 Bridge。确定继续吗？");
  }
  if (action === "stopBridge") {
    return window.confirm("停止后机器人将不再回复，并同时关闭守护进程。确定停止 Bridge 吗？");
  }
  if (action === "stopAll") {
    return window.confirm("将停止 Bridge、守护进程、NapCat 和该运行目录下的 QQ。确定停止全部吗？");
  }
  if (action === "saveApiProvider") {
    if (!$("apiId").value.trim()) {
      toast("请填写实例 ID。", "error");
      $("apiId").focus();
      return false;
    }
    const id = $("apiId").value.trim().toLowerCase();
    const idExists = (uiState.apiSnapshot.providers || []).some(item => item.id === id);
    if (uiState.apiEditorMode === "create" && idExists) {
      toast("这个实例 ID 已存在。新增不会覆盖原实例，请换一个 ID。", "error");
      $("apiId").focus();
      return false;
    }
    const required = [
      ["apiName", "显示名称"],
      ["apiEndpoint", "Endpoint"],
      ["apiModel", "模型名"],
    ];
    for (const [fieldId, label] of required) {
      if (!$(fieldId).value.trim()) {
        toast(`请填写${label}。`, "error");
        $(fieldId).focus();
        return false;
      }
    }
  }
  if (action === "testApiProvider" && !uiState.selectedApiProviderId) {
    toast("先保存 API 实例，再测试连接。", "error");
    return false;
  }
  if (action === "deleteApiProvider") {
    if (!uiState.selectedApiProviderId) return false;
    return window.confirm(`确定删除 API 实例“${uiState.selectedApiProviderId}”吗？`);
  }
  if (action === "saveApiRoutes") {
    return window.confirm("确定应用当前 API 分配和思考强度吗？");
  }
  if (action === "rollbackApiProviders") {
    if (!uiState.apiSnapshot.rollbackAvailable) {
      toast("目前没有可回滚的 API 配置。", "error");
      return false;
    }
    return window.confirm("确定恢复上一版 API 实例和插槽配置吗？Key 不会被改动。");
  }
  if (action === "saveMeme" && !$("memeName").value.trim()) {
    toast("先填写梗名再保存。", "error");
    $("memeName").focus();
    return false;
  }
  if (action === "saveSticker" && !$("stickerId").value) {
    toast("先从左侧选择一张表情。", "error");
    return false;
  }
  if (action === "simulateSticker" && (!$("stickerSimUser").value.trim() || !$("stickerSimAssistant").value.trim())) {
    toast("请把用户消息和夜星回复都填上。", "error");
    return false;
  }
  if (action === "deleteMeme") {
    const name = selectedMemeName();
    return Boolean(name) && window.confirm(`确定删除词条“${name}”吗？需要时可从修改记录恢复。`);
  }
  if (action === "researchMemeWeb" && !selectedMemeQuery()) {
    toast("先填写或选择一个词条。", "error");
    return false;
  }
  if (action === "rollbackMemeWebUpdate") {
    if (!uiState.memeSnapshot.sync?.rollbackAvailable) {
      toast("目前没有可以回退的联网更新。", "error");
      return false;
    }
    return window.confirm("确定回退上一次联网更新吗？人工保存的内容不会被联网回退覆盖。");
  }
  if (action === "restoreMemeHistory") {
    if (!$("memeHistorySelect").value) {
      toast("目前没有可恢复的修改记录。", "error");
      return false;
    }
    return window.confirm("确定恢复这次修改之前的词条内容吗？");
  }
  if (action === "refreshMemes" && !confirmDiscardMemeChanges()) return false;
  return true;
}

export function operationOutputId(action) {
  return ["startAll", "health", "restartBridge", "stopBridge", "stopAll"].includes(action) ? "serviceOutput" : "actionOutput";
}

export function configureRuntimeUi() {
  if (host.mode !== "browser") return;
  document.documentElement.dataset.runtime = "browser";
  const terminalOnly = ["startAll", "restartBridge", "stopBridge", "stopAll", "setDesktopBackground"];
  terminalOnly.forEach(action => {
    document.querySelectorAll(`[data-action="${action}"]`).forEach(button => {
      button.disabled = true;
      button.title = "Linux 上请通过 Docker Compose 或 systemd 执行";
    });
  });
  document.querySelectorAll("[data-native-page]").forEach(button => {
    button.disabled = true;
    button.title = "Windows 桌面版专用入口";
  });
  const saveButton = document.querySelector('[data-action="saveConfig"]');
  if (saveButton) saveButton.textContent = "保存配置";
}

export async function runAction(action, button = null, options = {}) {
  const silent = options.silent === true;
  if (action === "newMeme") {
    if (!confirmDiscardMemeChanges()) return;
    uiState.memeSelectionMode = "entry";
    clearMemeForm();
    $("memeName").focus();
    toast("已打开空白词条。", "success");
    return;
  }
  if (action === "addMemeSource") {
    addMemeSourceRow();
    return;
  }
  if (action === "newApiProvider") {
    startNewApiProvider();
    return;
  }
  if (action === "removeCapturedSticker" &&
      !window.confirm("只会移除机器人从群聊采集的这张表情。继续吗？")) {
    return;
  }
  if (!validateAction(action) || !beginAction(action, button, silent)) return;
  let failure = null;

  if (action === "diagnose") {
    setOutput("diagnoseOutput", "正在检查消息格式、白名单、@目标和命令路由...", true);
    $("diagnoseDetails").open = false;
  }
  if (["startAll", "health", "restartBridge", "stopBridge", "stopAll", "createBackup"].includes(action)) {
    setOutput(operationOutputId(action), `${ACTION_LABELS[action] || "正在处理"}...`, true);
  }

  try {
    let payload = {};
    if (action === "refreshMemes") {
      renderMemes(await host.call("getMemes"), { forceFill: true });
      if (!silent) toast("梗库已刷新", "success");
      return;
    }
    if (action === "refreshStickers") {
      renderStickers(await host.call("getStickers"));
      if (!silent) toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "refreshCapabilities") {
      renderCapabilities(await host.call("getCapabilities"));
      if (!silent) toast("能力状态已刷新", "success");
      return;
    }
    if (action === "refreshApiProviders") {
      renderApiProviders(await host.call("getApiProviders"));
      if (!silent) toast("API 状态已刷新", "success");
      return;
    }
    if (action === "saveMeme") payload = memeFormPayload();
    if (action === "saveConfig") payload = configPayload();
    if (action === "saveApiProvider") payload = apiProviderPayload();
    if (action === "testApiProvider") payload = { action: "test-provider", providerId: uiState.selectedApiProviderId };
    if (action === "deleteApiProvider") payload = { action: "delete-provider", providerId: uiState.selectedApiProviderId };
    if (action === "saveApiRoutes") payload = apiRoutesPayload();
    if (action === "rollbackApiProviders") payload = { action: "rollback" };
    if (action === "enableMeme") payload = { action: "enable", name: selectedMemeName() };
    if (action === "disableMeme") payload = { action: "disable", name: selectedMemeName() };
    if (action === "activateMeme") payload = { action: "activate", name: selectedMemeName() };
    if (action === "quarantineMeme") payload = { action: "quarantine", name: selectedMemeName() };
    if (action === "setMemeMode") payload = { action: "set-mode", mode: button?.dataset.mode || "steady" };
    if (action === "deleteMeme") payload = { action: "delete", name: selectedMemeName() };
    if (action === "runMemeWebUpdate") payload = { action: "run-web-update" };
    if (action === "researchMemeWeb") payload = { action: "research-web", query: selectedMemeQuery() };
    if (action === "rollbackMemeWebUpdate") payload = { action: "rollback-web-update" };
    if (action === "restoreMemeHistory") payload = { action: "restore-history", revisionId: $("memeHistorySelect").value };
    if (action === "syncStickers") payload = { action: "sync", analyze: true, analysisLimit: 4 };
    if (action === "analyzeStickers") payload = { action: "analyze", limit: 4 };
    if (action === "saveStickerSettings") payload = stickerSettingsPayload();
    if (action === "setStickerMode") payload = stickerSettingsPayload(button?.dataset.mode || "steady");
    if (action === "setStickerCaptureMode") {
      payload = stickerSettingsPayload(undefined, button?.dataset.captureMode || "observe");
    }
    if (action === "refreshStickerCapabilities") payload = { action: "capabilities" };
    if (action === "cleanupStickerTemp") payload = { action: "cleanup" };
    if (action === "removeCapturedSticker") {
      payload = { action: "remove", id: $("stickerId").value };
    }
    if (action === "saveSticker") payload = stickerEntryPayload();
    if (action === "simulateSticker") payload = stickerSimulationPayload();
    if (action === "diagnose") payload = diagnosePayload();

    if (action === "setBuiltInBackground") {
      const background = await host.call("setBackground", { mode: "built-in" });
      applyBackground(background);
      toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "setDesktopBackground") {
      const background = await host.call("setBackground", { mode: "desktop" });
      applyBackground(background);
      if (!background.uri) throw new Error("没有找到可用的桌面壁纸。");
      toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "chooseBackgroundImage") {
      const background = await host.call("chooseBackgroundImage");
      if (!background.uri) {
        toast("未选择图片", "error");
        return;
      }
      applyBackground(background);
      toast(ACTION_DONE[action], "success");
      return;
    }

    const apiActions = ["saveApiProvider", "testApiProvider", "deleteApiProvider", "saveApiRoutes", "rollbackApiProviders"];
    const memeActions = [
      "saveMeme",
      "enableMeme",
      "disableMeme",
      "activateMeme",
      "quarantineMeme",
      "setMemeMode",
      "deleteMeme",
      "runMemeWebUpdate",
      "researchMemeWeb",
      "rollbackMemeWebUpdate",
      "restoreMemeHistory",
    ];
    const hostAction = STICKER_ACTIONS.includes(action)
      ? "manageStickers"
      : apiActions.includes(action)
      ? "manageApiProviders"
      : memeActions.includes(action)
        ? action === "saveMeme"
          ? "saveMeme"
          : action === "deleteMeme"
            ? "deleteMeme"
            : ["enableMeme", "disableMeme", "activateMeme", "quarantineMeme", "setMemeMode"].includes(action)
              ? "toggleMeme"
              : action
        : action;
    const result = await callManagedAction(hostAction, payload, {
      onProgress: task => showActivity(ACTION_LABELS[action] || "后台任务", "working", taskPhaseLabel(task.phase)),
    });

    if (action === "refresh") {
      renderSnapshot(result);
    } else if (STICKER_ACTIONS.includes(action)) {
      if (action === "simulateSticker") {
        renderStickerSimulation(result);
      } else {
        if (action === "removeCapturedSticker") uiState.selectedStickerId = "";
        renderStickers(result.snapshot || await host.call("getStickers"), {
          selectId: uiState.selectedStickerId,
        });
        const operation = result.result || {};
        $("stickerStatus").textContent = [
          ACTION_DONE[action],
          operation.items !== undefined ? `读取 ${operation.items} 张 · 新增 ${operation.added || 0} 张` : "",
          operation.analyzed !== undefined ? `分析 ${operation.analyzed} 张 · 复用 ${operation.reused || 0} 张 · 失败 ${operation.failed || 0} 张` : "",
        ].filter(Boolean).join("\n");
      }
    } else if (apiActions.includes(action)) {
      if (result.snapshot) {
        const keepId = action === "deleteApiProvider" ? "" : uiState.selectedApiProviderId || result.provider?.id;
        renderApiProviders(result.snapshot, { selectId: keepId });
      }
      if (action === "testApiProvider") {
        const message = result.ok
          ? `连接成功\n耗时：${result.durationMs} ms\n模型回复：${result.output || "OK"}`
          : `连接失败\n${result.error || "接口没有返回可用正文"}`;
        setOutput("apiTestOutput", message, true);
        if (!result.ok) throw new Error(result.error || "API 连接测试失败");
      } else {
        setOutput("apiRouteOutput", result.message || ACTION_DONE[action], true);
      }
    } else if (action === "refreshConfig") {
      uiState.lastConfigSnapshot = result;
      renderConfigEditor(result, { force: true });
      renderConfig(uiState.lastStatus, uiState.lastConfigSnapshot);
    } else if (action === "saveConfig") {
      const snapshot = await host.call("getConfig");
      uiState.lastConfigSnapshot = snapshot;
      renderConfigEditor(snapshot, { force: true });
      renderConfig(uiState.lastStatus, snapshot);
      if (host.mode === "browser") {
        setOutput(
          "configStatus",
          `${result.message || "配置已保存"}\n请在服务器执行 docker compose restart bridge 或 systemctl restart qqfriend 后生效。`,
          true,
        );
        return;
      }
      setOutput("configStatus", `${result.message || "配置已保存"}\n正在重启 Bridge 使配置生效...`, true);
      try {
        const restartResult = await host.call("restartBridge");
        if (restartResult.snapshot) renderSnapshot(restartResult.snapshot);
        setOutput("configStatus", "配置已保存，Bridge 已重启并重新载入。", true);
      } catch (error) {
        setOutput("configStatus", `配置已经保存，但 Bridge 重启失败：${error.message || error}`, true);
        throw new Error(`配置已保存，Bridge 重启失败：${error.message || error}`);
      }
    } else if (action === "refreshLogs") {
      renderLogs(result);
      uiState.logsLoaded = true;
    } else if (["startAll", "health", "restartBridge"].includes(action)) {
      if (result.snapshot) renderSnapshot(result.snapshot);
      setOutput("serviceOutput", formatOperationResult(result), true);
    } else if (action === "diagnose") {
      const formatted = formatDiagnoseResult(result);
      renderDiagnoseSummary(formatted.summary);
      setOutput("diagnoseRaw", formatted.raw, true);
    } else if (action === "researchMemeWeb") {
      const applied = applyMemeResearch(result);
      if (!applied) {
        $("memeStatus").textContent = `联网证据不足：${result.reason || payload.query || "-"}`;
        throw new Error(result.reason || "联网证据不足");
      }
      toast("查证结果已回填，确认后保存", "success");
      return;
    } else if (memeActions.includes(action)) {
      const snapshot = result.snapshot || await host.call("getMemes");
      const forceFill = [
        "saveMeme",
        "enableMeme",
        "disableMeme",
        "deleteMeme",
        "rollbackMemeWebUpdate",
        "restoreMemeHistory",
      ].includes(action);
      renderMemes(snapshot, { selectName: action === "deleteMeme" ? "" : selectedMemeName(), forceFill });
      setOutput("actionOutput", formatMemeOperationResult(action, result), true);
    } else if (["createBackup", "openLogs", "stopBridge", "stopAll"].includes(action)) {
      setOutput(operationOutputId(action), formatOperationResult(result), true);
      if (action === "stopBridge" || action === "stopAll") {
        renderStoppedStatus(result.generatedAt);
      }
    }

    if (!silent) toast(ACTION_DONE[action] || "操作完成", "success");
  } catch (error) {
    failure = error;
    showActionError(action, error);
    if (!silent) toast(error.message || "操作失败", "error");
  } finally {
    endAction(action);
    if (!silent) finishActivity(failure ? `${ACTION_LABELS[action] || "操作"}失败` : ACTION_DONE[action] || "操作完成", failure ? "error" : "success");
  }
}

export function showActionError(action, error) {
  const message = error.message || String(error);
  if (action === "diagnose") {
    setOutput("diagnoseOutput", `诊断失败：${message}`, true);
    $("diagnoseDetails").open = false;
    return;
  }
  if (action === "refresh" || action === "refreshStatus") {
    markStatusStale(`数据刷新失败 · ${message}`);
    return;
  }
  if (actionGroup(action) === "config") {
    setOutput("configStatus", message.startsWith("配置已保存") ? message : `配置操作失败：${message}`, true);
    return;
  }
  if (actionGroup(action) === "api-providers") {
    const outputId = action === "testApiProvider" ? "apiTestOutput" : "apiRouteOutput";
    setOutput(outputId, `API 操作失败：${message}`, true);
    return;
  }
  if (actionGroup(action) === "memes") {
    $("memeStatus").textContent = `操作失败：${message}`;
    return;
  }
  if (actionGroup(action) === "stickers") {
    $("stickerStatus").textContent = `操作失败：${message}`;
    return;
  }
  setOutput(operationOutputId(action), `操作失败：${message}`, true);
}

export function formatOperationResult(result) {
  const snapshot = result?.snapshot || {};
  const status = snapshot.status || {};
  const lines = [result?.message || "操作完成"];
  if (status.status) lines.push(`Bridge：${status.status === "ok" ? "在线" : status.status}`);
  if (status.version) lines.push(`版本：${status.version}`);
  if (status.process?.pid) lines.push(`PID：${status.process.pid}`);
  if (result?.path || result?.logsDir) lines.push(`位置：${result.path || result.logsDir}`);
  return lines.join("\n");
}
