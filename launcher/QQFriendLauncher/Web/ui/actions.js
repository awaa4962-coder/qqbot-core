import { apiProviderPayload, apiRoutesPayload, apiReadFailed, canDiscardApiDrafts, renderApiProviders, setApiNotice, startNewApiProvider, syncApiControls } from "../pages/api.js";
import { capabilityReadFailed, renderCapabilities, setCapabilityNotice } from "../pages/capabilities.js";
import { configPayload, configReadFailed, renderConfig, renderConfigEditor, syncConfigControls } from "../pages/configuration.js";
import { diagnosePayload, formatDiagnoseResult, renderDiagnoseSummary } from "../pages/diagnose-message.js";
import { logsReadFailed, renderLogs, setLogsLoading } from "../pages/logs.js";
import { renderMemes, RETIRED_MEME_ACTIONS } from "../pages/memes.js";
import { markStatusStale, renderSnapshot, renderStoppedStatus } from "../pages/overview.js";
import { canDiscardStickerDrafts, canWriteStickers, renderStickerSimulation, renderStickers, stickerReadFailed, stickerRemovalPayload, syncStickerControls, stickerEntryPayload, stickerSettingsPayload, stickerSimulationPayload, validStickerSettings } from "../pages/stickers.js";
import { actionGroup, beginAction, endAction, finishActivity, showActivity, toast } from "./activity.js";
import { applyBackground } from "./appearance.js";
import { $, setOutput, splitList } from "./dom.js";
import { ACTION_DONE, ACTION_LABELS, STICKER_ACTIONS } from "./metadata.js";
import { host, uiState } from "./state.js";
import { callManagedAction, managedTaskIsBlocked, resumeManagedTasks, taskPhaseLabel } from "./tasks.js";
import { hasVerifiedNativeTools } from "../agent-tools.js";
import { isAgentDraftAction, runAgentDraftAction } from "./agent-draft-actions.js";
import { isAgentWriteAction, runAgentWriteAction } from "./agent-write-actions.js";

async function runAgentToolsProbe(silent) {
  let terminalError;
  try {
    await callManagedAction("probeAgentTools", { action: "probe" }, {
      onProgress: task => {
        setCapabilityNotice(taskPhaseLabel(task.phase), "loading");
        showActivity(ACTION_LABELS.probeAgentTools, "working", taskPhaseLabel(task.phase));
      },
    });
  } catch (error) {
    if (!error.taskTerminal || error.taskStateUnknown) throw error;
    terminalError = error;
  }
  let snapshot;
  try {
    snapshot = await host.call("getCapabilities");
    renderCapabilities(snapshot);
  } catch (error) {
    throw Object.assign(error, { nativeProofReadFailed: true });
  }
  if (terminalError || !hasVerifiedNativeTools(snapshot.agentTools?.compatibility)) {
    throw terminalError || new Error("工具验证尚未完整通过，请查看主备模型状态。");
  }
  setCapabilityNotice("当前主备模型工具验证已完成。", "ready");
  if (!silent) toast(ACTION_DONE.probeAgentTools, "success");
}

export function validateAction(action) {
  if (RETIRED_MEME_ACTIONS.has(action)) {
    toast("自动梗库已停用，旧词条只读保留。", "error");
    return false;
  }
  if (action === "probeAgentTools") {
    const compatibility = uiState.capabilitySnapshot.agentTools?.compatibility;
    if (host.mode !== "browser" || compatibility?.provenance !== "live" || compatibility?.probeAllowed !== true) {
      setCapabilityNotice("当前不能发起工具验证，请刷新能力状态核实。", "error");
      return false;
    }
    if (managedTaskIsBlocked("agent_tools")) {
      setCapabilityNotice("已有验证任务结果未确认，请刷新任务状态，勿重复提交。", "error");
      return false;
    }
    return window.confirm("将用合成数据验证当前主备模型，最多4次模型请求，不发送QQ消息、不修改模型配置。继续吗？");
  }
  if (action === "refreshConfig" && uiState.configDirty) {
    return window.confirm("当前配置有未保存修改。确定重新读取并放弃这些修改吗？");
  }
  if (action === "saveConfig") {
    if (!uiState.configLoaded || uiState.configBlocked) {
      toast("配置尚未读取或结果待核实，请先重新读取。", "error");
      return false;
    }
    if (uiState.lastConfigSnapshot.files?.botNames?.writable !== false && !splitList($("cfgBotNames").value).length) {
      toast("机器人名不能为空。", "error");
      document.querySelector('[data-list-editor-for="cfgBotNames"] input')?.focus();
      return false;
    }
    return window.confirm(host.mode === "browser" ? "将保存非密钥配置，重启 Bridge 后生效。确定保存吗？" : "将保存非密钥配置并重启 Bridge。确定继续吗？");
  }
  if (action === "refreshApiProviders" && !canDiscardApiDrafts()) return false;
  if (["saveApiProvider", "testApiProvider", "deleteApiProvider", "saveApiRoutes", "rollbackApiProviders"].includes(action) &&
      (!uiState.apiProvidersLoaded || uiState.apiBlocked)) {
    setApiNotice("API 配置尚未读取或结果待核实，请先刷新。");
    return false;
  }
  if (host.mode === "browser" && ["saveApiProvider", "deleteApiProvider", "saveApiRoutes", "rollbackApiProviders"].includes(action) &&
      !/^[a-f0-9]{64}$/.test(uiState.apiSnapshot.configurationRevision || "")) {
    setApiNotice("API 保存令牌未读取，请刷新后再操作。"); return false;
  }
  if (["syncStickers", "analyzeStickers", "refreshStickerCapabilities", "cleanupStickerTemp"].includes(action) && managedTaskIsBlocked("stickers")) {
    $("stickerStatus").textContent = "已有表情任务仍在运行或结果未确认，请刷新后台任务核实，勿重复提交。";
    return false;
  }
  if (host.mode === "browser" && STICKER_ACTIONS.includes(action) && !canWriteStickers(action)) {
    $("stickerStatus").textContent = "表情状态尚未确认，请先重新读取目录。";
    return false;
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
    if (!canDiscardApiDrafts()) return false;
    if (!uiState.apiSnapshot.rollbackAvailable) {
      toast("目前没有可回滚的 API 配置。", "error");
      return false;
    }
    return window.confirm("确定恢复上一版 API 实例和插槽配置吗？Key 不会被改动。");
  }
  if (action === "saveSticker" && !$("stickerId").value) {
    toast("先从左侧选择一张表情。", "error");
    return false;
  }
  if (action === "simulateSticker" && (!$("stickerSimUser").value.trim() || !$("stickerSimAssistant").value.trim())) {
    toast("请把用户消息和夜星回复都填上。", "error");
    return false;
  }
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
  document.querySelectorAll('[data-action="openLogs"]').forEach(button => {
    button.textContent = "查看日志";
    button.dataset.view = "logs";
    button.removeAttribute("data-action");
  });
  const saveButton = document.querySelector('[data-action="saveConfig"]');
  if (saveButton) saveButton.textContent = "保存配置";
}

export async function runAction(action, button = null, options = {}) {
  if (isAgentDraftAction(action)) return await runAgentDraftAction(action, button, options);
  if (isAgentWriteAction(action)) return await runAgentWriteAction(action, button, options);
  const silent = options.silent === true;
  if (action === "refreshStickers" && !silent && !canDiscardStickerDrafts()) return;
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
  let cancelled = false;
  if (actionGroup(action) === "stickers") syncStickerControls();

  if (action === "refreshCapabilities") setCapabilityNotice("正在读取能力目录…", "loading");
  if (action === "probeAgentTools") setCapabilityNotice("正在提交工具验证请求，结果尚未确认…", "loading");
  if (actionGroup(action) === "api-providers") {
    setApiNotice(ACTION_LABELS[action] || "正在处理…", "loading");
    syncApiControls();
  }
  if (actionGroup(action) === "config") {
    setOutput("configStatus", action === "saveConfig" ? "正在保存配置…" : "正在重新读取配置…", true);
    $("configStatus").dataset.state = "loading";
    syncConfigControls();
  }
  if (action === "refreshLogs") setLogsLoading();

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
      renderMemes(await host.call("getMemes"));
      if (!silent) toast("只读归档已刷新", "success");
      return;
    }
    if (action === "refreshManagedTasks") { await resumeManagedTasks(); return; }
    if (action === "refreshStickers") {
      const snapshot = await host.call("getStickers");
      renderStickers(snapshot, { force: !silent });
      if (snapshot.available === false) throw new Error("表情目录暂不可读，原文件已保留");
      if (!silent) toast(ACTION_DONE[action], "success");
      return;
    }
    if (action === "refreshCapabilities") {
      renderCapabilities(await host.call("getCapabilities"));
      if (!silent) toast("能力状态已刷新", "success");
      return;
    }
    if (action === "probeAgentTools") {
      await runAgentToolsProbe(silent);
      return;
    }
    if (action === "refreshApiProviders") {
      renderApiProviders(await host.call("getApiProviders"), { force: true });
      if (!silent) toast("API 状态已刷新", "success");
      return;
    }
    if (action === "saveConfig") payload = configPayload();
    if (action === "saveApiProvider") payload = apiProviderPayload();
    if (action === "testApiProvider") payload = { action: "test-provider", providerId: uiState.selectedApiProviderId };
    if (action === "deleteApiProvider") payload = { action: "delete-provider", providerId: uiState.selectedApiProviderId, configurationRevision: uiState.apiSnapshot.configurationRevision };
    if (action === "saveApiRoutes") payload = apiRoutesPayload();
    if (action === "rollbackApiProviders") payload = { action: "rollback", configurationRevision: uiState.apiSnapshot.configurationRevision };
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
      payload = stickerRemovalPayload();
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
      if (background.cancelled || !background.uri) {
        cancelled = true;
        toast("已取消选择，背景未更改。", "error");
        return;
      }
      applyBackground(background);
      toast(ACTION_DONE[action], "success");
      return;
    }

    const apiActions = ["saveApiProvider", "testApiProvider", "deleteApiProvider", "saveApiRoutes", "rollbackApiProviders"];
    const hostAction = STICKER_ACTIONS.includes(action)
      ? "manageStickers"
      : apiActions.includes(action)
      ? "manageApiProviders"
        : action === "refreshLogs" ? "getLogs" : action;
    const result = await callManagedAction(hostAction, payload, {
      onProgress: task => {
        showActivity(ACTION_LABELS[action] || "后台任务", "working", taskPhaseLabel(task.phase));
        if (STICKER_ACTIONS.includes(action)) $("stickerStatus").textContent = taskPhaseLabel(task.phase);
      },
    });

    if (action !== "testApiProvider" && (result?.ok === false || result?.result?.ok === false || result?.cancelled || result?.result?.cancelled)) {
      throw new Error(result?.error || result?.result?.error || (result?.cancelled || result?.result?.cancelled ? "任务已取消，未完成这次操作。" : "操作未成功。"));
    }
    if (host.mode === "browser" && (action === "saveConfig" || apiActions.includes(action) && action !== "testApiProvider") && result?.ok !== true) {
      throw Object.assign(new Error("操作响应不完整，结果未确认；请刷新核实，勿重复提交。"), { responseInvalid: true });
    }
    assertStickerMutationResult(action, result, payload);
    assertBrowserOperationResult(action, result);

    if (action === "refresh") {
      renderSnapshot(result);
      let tasksFailed = false;
      try { await resumeManagedTasks(); } catch { tasksFailed = true; }
      if (Object.keys(result.errors || {}).length || tasksFailed) {
        throw Object.assign(new Error(tasksFailed ? "运行状态已更新；后台任务未能刷新，请查看任务页。"
          : "运行状态已更新；配置或日志未能刷新，请查看对应页面。"), { partialRefresh: true });
      }
    } else if (STICKER_ACTIONS.includes(action)) {
      if (action === "simulateSticker") {
        renderStickerSimulation(result);
      } else {
        if (action === "removeCapturedSticker") uiState.selectedStickerId = "";
        const snapshot = result.snapshot || await host.call("getStickers");
        renderStickers(snapshot, {
          selectId: uiState.selectedStickerId,
          confirmed: action === "saveSticker" || action === "removeCapturedSticker" ? "entry"
            : ["saveStickerSettings", "setStickerMode", "setStickerCaptureMode"].includes(action) ? "settings" : undefined,
        });
        if (snapshot.available === false) throw new Error("表情目录暂不可读，原文件已保留");
        const operation = result.result || {};
        if (operation.ok === false || operation.cancelled) throw new Error(operation.error || "表情任务未完成");
        $("stickerStatus").textContent = [
          ACTION_DONE[action],
          operation.items !== undefined ? `读取 ${operation.items} 张 · 新增 ${operation.added || 0} 张` : "",
          operation.analyzed !== undefined ? `分析 ${operation.analyzed} 张 · 复用 ${operation.reused || 0} 张 · 失败 ${operation.failed || 0} 张` : "",
        ].filter(Boolean).join("\n");
      }
    } else if (apiActions.includes(action)) {
      if (result.snapshot) {
        const keepId = action === "deleteApiProvider" ? "" : uiState.selectedApiProviderId || result.provider?.id;
        renderApiProviders(result.snapshot, { selectId: keepId, force: true, preserveRoutes: action === "saveApiProvider", preserveProvider: action === "saveApiRoutes" });
      }
      if (action === "testApiProvider") {
        const message = result?.ok === true
          ? `连接成功\n耗时：${result.durationMs} ms\n模型回复：${result.output || "OK"}`
          : `连接失败\n${result?.error || "接口没有返回已确认的可用正文"}`;
        setOutput("apiTestOutput", message, true);
        if (result?.ok !== true) throw new Error(result?.error || "API 连接测试失败");
      } else {
        setOutput("apiRouteOutput", result.message || ACTION_DONE[action], true);
      }
      setApiNotice(result.message || ACTION_DONE[action], "ready");
    } else if (action === "refreshConfig") {
      renderConfigEditor(result, { force: true });
      renderConfig(uiState.lastStatus, uiState.lastConfigSnapshot);
    } else if (action === "saveConfig") {
      let snapshot;
      try { snapshot = await host.call("getConfig"); renderConfigEditor(snapshot, { force: true }); }
      catch { throw new Error("配置已保存，但重新读取失败；请刷新确认，暂勿重复提交。"); }
      renderConfig(uiState.lastStatus, snapshot);
      if (host.mode === "browser") {
        $("configStatus").dataset.state = "ready";
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
    } else if (["createBackup", "openLogs", "stopBridge", "stopAll"].includes(action)) {
      setOutput(operationOutputId(action), action === "createBackup" && host.mode === "browser"
        ? `备份已创建\n名称：${result.name}\n文件：${result.included.length} 份\n类型：非密钥资料`
        : formatOperationResult(result), true);
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
    if (actionGroup(action) === "config") syncConfigControls();
    if (actionGroup(action) === "api-providers") syncApiControls();
    if (actionGroup(action) === "stickers") syncStickerControls();
    if (!silent) finishActivity(
      cancelled ? "已取消，未更改背景" : failure?.taskStateUnknown ? "任务结果尚未确认" : failure?.partialRefresh ? "部分刷新未完成" : failure ? `${ACTION_LABELS[action] || "操作"}失败` : ACTION_DONE[action] || "操作完成",
      failure || cancelled ? "error" : "success", failure?.taskStateUnknown || failure?.partialRefresh ? failure.message : undefined,
    );
  }
}

export function showActionError(action, error) {
  const message = error.message || String(error);
  if (action === "probeAgentTools") {
    if (error.nativeProofReadFailed || [401, 403].includes(error.status)) capabilityReadFailed(error);
    else setCapabilityNotice(message, "error");
    return;
  }
  if (error.taskStateUnknown) {
    const group = actionGroup(action);
    setOutput(group === "memes" ? "memeStatus" : group === "stickers" ? "stickerStatus" : operationOutputId(action), message, true);
    return;
  }
  if (action === "diagnose") {
    setOutput("diagnoseOutput", `诊断失败：${message}`, true);
    $("diagnoseDetails").open = false;
    return;
  }
  if (action === "refresh" || action === "refreshStatus") {
    if (error.partialRefresh) return;
    markStatusStale(`数据刷新失败 · ${message}`);
    return;
  }
  if (actionGroup(action) === "config") {
    if (action === "refreshConfig" || action === "saveConfig" && (error.status === 409 || error.status === 403 || !error.status || error.status >= 500 || error.transportFailure || error.responseInvalid || message.startsWith("配置已保存"))) {
      configReadFailed(error, action === "saveConfig" && error.status === 409
        ? "配置已在别处更新，本页修改未被覆盖。请先核对当前输入，再重新读取配置。"
        : message.startsWith("配置已保存") ? message
        : action === "saveConfig" && (error.transportFailure || error.responseInvalid || !error.status || error.status >= 500) ? "保存结果未确认；草稿已保留，请先重新读取核实，勿重复提交。" : undefined);
      return;
    }
    if (action === "saveConfig" && error.status === 409) {
      setOutput("configStatus", "配置已在别处更新，本页修改未被覆盖。请先核对当前输入，再重新读取配置。", true);
      return;
    }
    setOutput("configStatus", message.startsWith("配置已保存") ? message : `配置操作失败：${message}`, true);
    $("configStatus").dataset.state = "error";
    return;
  }
  if (actionGroup(action) === "api-providers") {
    if (action === "refreshApiProviders" || [403, 409].includes(error.status) || error.status >= 500 && action !== "testApiProvider" || error.transportFailure || error.responseInvalid) apiReadFailed(error);
    else setApiNotice(`API 操作失败：${message}`);
    const outputId = action === "testApiProvider" ? "apiTestOutput" : "apiRouteOutput";
    setOutput(outputId, `API 操作失败：${message}`, true);
    return;
  }
  if (actionGroup(action) === "memes") {
    $("memeStatus").textContent = `操作失败：${message}`;
    return;
  }
  if (actionGroup(action) === "stickers") {
    if (action === "refreshStickers" || [401, 403, 409].includes(error.status) || error.transportFailure || error.responseInvalid || error.status >= 500) stickerReadFailed(error);
    $("stickerStatus").textContent = `操作失败：${message}`;
    return;
  }
  if (action === "refreshCapabilities") { capabilityReadFailed(error); return; }
  if (action === "refreshLogs") {
    logsReadFailed(error);
    return;
  }
  setOutput(operationOutputId(action), `操作失败：${message}`, true);
}

function assertStickerMutationResult(action, result, payload) {
  if (host.mode !== "browser") return;
  const settings = ["saveStickerSettings", "setStickerMode", "setStickerCaptureMode"].includes(action);
  const entry = action === "saveSticker";
  const removal = action === "removeCapturedSticker";
  if (!settings && !entry && !removal) return;
  const snapshot = result?.snapshot;
  const matchingEntry = Array.isArray(snapshot?.entries) ? snapshot.entries.find(item => item?.id === payload.id) : null;
  const requested = settings ? normalizedStickerSettingsRequest(payload.settings) : entry ? normalizedStickerEntryRequest(payload.patch) : null;
  const confirmed = settings ? validStickerSettings(result?.settings) && snapshot?.settings &&
    Object.keys(requested).every(key => JSON.stringify(result.settings[key]) === JSON.stringify(requested[key]) &&
      JSON.stringify(result.settings[key]) === JSON.stringify(snapshot.settings[key]))
    : entry ? validEditableSticker(result?.entry) && result.entry.id === payload.id && matchingEntry &&
      Object.keys(requested).every(key => JSON.stringify(result.entry[key]) === JSON.stringify(requested[key]) &&
        JSON.stringify(result.entry[key]) === JSON.stringify(matchingEntry[key]))
      : result?.removed?.id === payload.id && result?.cloud?.ok === true && !matchingEntry;
  if (!confirmed || !Array.isArray(snapshot?.entries) || snapshot.available === false) {
    throw Object.assign(new Error("表情写入响应不完整，结果未确认；草稿已保留，请刷新核实，勿重复提交。"), { responseInvalid: true });
  }
}

function validEditableSticker(entry) {
  return typeof entry?.id === "string" && entry.id !== "" && typeof entry.description === "string" && typeof entry.enabled === "boolean" &&
    Array.isArray(entry.tags) && entry.tags.every(tag => typeof tag === "string") && Array.isArray(entry.allowedGroups);
}

function normalizedStickerGroups(values) {
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
}

function normalizedStickerSettingsRequest(settings) {
  const value = { ...settings, allowedGroups: normalizedStickerGroups(settings.allowedGroups) };
  const limits = [["chance", 0, 1], ["strongChance", 0, 1], ["captureMinConfidence", 0, 1],
    ["cooldownMs", 0, 86400000], ["captureDailyLimit", 0, 200], ["captureCatalogLimit", 1, 2000], ["captureMinDistinctSenders", 1, 20]];
  for (const [key, min, max] of limits) {
    const number = Math.max(min, Math.min(max, value[key]));
    value[key] = max === 1 ? number : Math.round(number);
  }
  return value;
}

function normalizedStickerEntryRequest(patch) {
  const clean = value => [...String(value)].map(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? " " : character).join("").trim();
  const tags = values => [...new Set(values.map(tag => clean(tag).slice(0, 20)).filter(Boolean))].slice(0, 8);
  // The store caps the edit first, then the public record performs its text projection.
  return { description: clean(String(patch.description).trim().slice(0, 240)).slice(0, 240), enabled: patch.enabled !== false,
    tags: tags(tags(patch.tags)),
    allowedGroups: normalizedStickerGroups(patch.allowedGroups) };
}

function assertBrowserOperationResult(action, result) {
  if (host.mode !== "browser") return;
  const confirmed = action === "createBackup" ? result?.schemaVersion === 1 && result?.mode === "safe-non-secret" &&
    typeof result.name === "string" && result.name !== "" && Number.isFinite(Date.parse(result.createdAt)) &&
    Array.isArray(result.included) && result.included.every(file => typeof file === "string")
    : action !== "health" || typeof result?.health?.status === "string" && typeof result?.snapshot?.status?.status === "string";
  if (!confirmed) throw Object.assign(new Error("操作响应不完整，结果未确认；请刷新核实，勿重复提交。"), { responseInvalid: true });
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
