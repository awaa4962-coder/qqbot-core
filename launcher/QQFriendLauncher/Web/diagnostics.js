import { callManagedAction, taskPhaseLabel } from "./ui/tasks.js";
import { initializeDeliveries } from "./deliveries.js";

(function () {
  "use strict";
  const host = window.QQFriendHost;
  if (host.mode !== "browser") return;
  initializeDeliveries(host);
  const $ = (id) => document.getElementById(id);
  const tracePanel = $("messageTracePanel");
  const replayPanel = $("replayPanel");
  tracePanel.hidden = false;
  replayPanel.hidden = false;
  let rows = [];
  let selectedId = "";
  let replay = null;
  let loaded = false;
  const busy = new Set();
  const toolNames = { recall_memory: "记忆检索", read_bot_status: "机器人状态", web_search: "公开搜索" };
  const toolReasons = {
    tool_model_round: "模型轮次", tool_completed: "工具完成", tool_empty: "无结果", tool_denied: "权限拒绝",
    tool_arguments: "参数无效", tool_unavailable: "工具不可用", tool_reused: "复用结果", tool_budget: "达到预算上限",
  };
  const labels = {
    ...toolReasons,
    processing: "处理中", sent: "已发送", partial: "部分成功", failed: "失败", silent: "主动不回复", ignored: "未触发", no_reply: "未产生回复", processed: "处理结束",
    received: "接收", admission: "准入", route: "路由", context: "上下文", vision: "看图", model: "模型", tool: "工具", output: "正文检查", send: "发送", complete: "结束",
    image_direct: "原图与对话一起理解", image_description: "客观描述兜底", image_cache: "复用同范围客观描述", image_unavailable: "图片未能读取",
    image_payload: "模型误回图片编码，已拦截",
    started: "开始", ok: "成功", skipped: "跳过", primary: "主模型", fallback: "备用模型", local: "本地恢复", unavailable: "模型不可用", model_unavailable: "模型未产生可用正文",
    group_at: "群聊 @", interjection: "自动插话", private_chat: "私聊", private_file: "私聊文件", command: "命令", preview: "链接预览", file: "文件", jm: "JM", "resource-transfer": "资源转发", "link-preview": "链接预览", wordcloud: "词云", "conversation-summary": "成员聊天总结",
    group_not_whitelisted: "群不在白名单", blacklisted_user: "发送人被屏蔽", self_message: "机器人自身消息", duplicate_event: "重复投递", duplicate_text: "复读消息", private_not_whitelisted: "私聊不在白名单",
    ingress_rate_limited: "入口限流", scope_rate_limited: "当前会话限流", priority_rate_limited: "优先通道限流",
    accepted: "已接纳", preview_sent: "链接预览抑制插话", mentioned: "已进入 @ 回复", short: "消息太短", empty: "内容为空", no_probability: "该场景不自动插话", cooldown: "插话冷却中", random: "本次未命中插话概率", triggered: "触发插话",
    empty_content: "模型正文为空", empty_content_with_reasoning: "只有推理，没有正文", unsafe_reasoning: "正文含推理内容", secret_leak: "正文安全检查未通过", send_failed: "发送重试后失败", exception: "处理异常",
    intentional_silence: "模型决定不插话", invalid_interjection: "插话输出格式无效", request_failed: "模型请求失败", tools_unavailable: "本轮工具未开放", output_budget: "模型正文超过输出上限",
    cancelled: "已停止", privacy_changed: "记忆已清理，旧回复作废", permission_changed: "会话权限已变化", preferences_changed: "称呼或偏好已更新", reply_superseded: "已有更新的回复请求", reply_expired: "回复处理超时", reply_capacity: "进行中的回复过多", bridge_stopping: "服务正在停止",
    unknown: "回执未知", send_unknown: "发送结果未知，请先核实",
    reply_duplicate: "这条消息已处理，不再重发", delivery_state_unavailable: "发送状态无法保存，已停止回复", forgotten_event: "已清理的旧事件", stale_event: "超过保留期的旧事件",
    quote_source_unknown: "引用来源资料不完整", quote_scope_mismatch: "引用不属于当前群", quote_message_mismatch: "引用消息编号不匹配",
    quote_privacy_unavailable: "无法核对引用的隐私边界", quote_forgotten: "引用内容已被清理", quote_content_empty: "引用没有可用正文或图片",
  };
  const label = (value) => labels[value] || value || "待判断";

  function notice(id, text, error = false) {
    $(id).textContent = text;
    $(id).dataset.error = String(error);
  }

  async function action(name) {
    const target = name === "traces" ? "traces" : "replay";
    if (busy.has(target)) return;
    busy.add(target);
    const panel = target === "traces" ? tracePanel : replayPanel;
    const noticeId = target === "traces" ? "traceNotice" : "replayNotice";
    panel.setAttribute("aria-busy", "true");
    panel.querySelectorAll("button,input,select").forEach(node => { node.disabled = true; });
    notice(noticeId, name === "generate" ? "正在生成候选回复，等待模型返回…" : "正在处理…");
    try {
      if (name === "traces") await loadTraces();
      else if (name === "replay") { renderReplay(await host.call("getReplay")); notice(noticeId, "回放记录已刷新"); }
      else await replayAction(name);
    } catch (error) {
      notice(noticeId, error.message || "操作失败，请稍后重试", true);
    } finally {
      busy.delete(target);
      panel.setAttribute("aria-busy", "false");
      panel.querySelectorAll("button,input,select").forEach(node => { node.disabled = false; });
      updateReplayButtons();
    }
  }

  async function loadTraces() {
    const data = await host.call("getMessageTraces", { status: $("traceStatus").value, groupId: $("traceGroup").value.trim(), messageId: $("traceMessage").value.trim(), limit: 100 });
    rows = data.items;
    if (!rows.some(row => row.id === selectedId)) selectedId = rows[0]?.id || "";
    renderRows();
    notice("traceNotice", `符合条件 ${data.total} 条 · 当前显示 ${rows.length} 条 · 本次运行最多保留 ${data.capacity} 条 / ${data.retentionHours} 小时 · 不含聊天正文`);
  }

  function renderRows() {
    const body = $("traceRows");
    body.replaceChildren();
    if (!rows.length) {
      const row = body.insertRow(); const cell = row.insertCell();
      cell.colSpan = 4; cell.textContent = "暂无符合条件的记录";
    }
    for (const item of rows) {
      const row = body.insertRow();
      row.classList.toggle("selected", item.id === selectedId);
      const button = document.createElement("button");
      button.type = "button"; button.className = "trace-select";
      button.textContent = new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false });
      button.setAttribute("aria-pressed", String(item.id === selectedId));
      const scope = document.createElement("small");
      scope.textContent = item.scope === "private" ? `私聊 ${item.userId}` : `群 ${item.groupId}`;
      button.append(scope);
      button.addEventListener("click", () => { selectedId = item.id; renderRows(); });
      row.insertCell().append(button);
      row.insertCell().textContent = label(item.route);
      row.insertCell().textContent = label(item.status);
      row.insertCell().textContent = duration(item.durationMs);
    }
    renderTraceDetail(rows.find(row => row.id === selectedId));
  }

  function renderTraceDetail(item) {
    const box = $("traceDetail");
    box.replaceChildren();
    if (!item) { box.textContent = "选择一条记录查看处理阶段"; return; }
    const title = document.createElement("h3"); title.textContent = `${label(item.status)} · ${label(item.route)}`;
    const meta = document.createElement("p"); meta.textContent = `消息 ${item.messageId || "无编号"} · 发送人 ${item.userId || "未知"}`;
    box.append(title, meta);
    if (item.reason && item.status !== "sent") { const reason = document.createElement("p"); reason.textContent = label(item.reason); box.append(reason); }
    const list = document.createElement("ol");
    let previous = 0;
    for (const step of item.stages) {
      const li = document.createElement("li");
      const status = step.stage === "tool" && !["started", "ok", "failed", "skipped"].includes(step.status) ? "待判断" : label(step.status);
      li.textContent = `${label(step.stage)} · ${status} · +${duration(step.elapsedMs - previous)}`;
      previous = step.elapsedMs;
      const detail = document.createElement("span");
      detail.textContent = stepDetails(step);
      li.append(detail); list.append(li);
      if (step.stage !== "tool" && step.sources?.length) {
        const sources = document.createElement("span");
        sources.className = "trace-sources";
        sources.textContent = step.sources.map(sourceLabel).join("；");
        li.append(sources);
      }
    }
    box.append(list);
  }

  function sourceLabel(source) {
    const kinds = { quote: "引用", thread: "对话线程", memory: "个人历史", group: "群聊", image: "图片", note: "明确记忆" };
    const reasons = { reply_chain: "引用链", continuation: "承接", keywords: "关键词", synonyms: "同义表达", mention: "被提及者", recent: "最近背景", image_reference: "明确看图指向", explicit_note: "本人记忆命令", operator_note: "管理员备注", inferred_topic: "原话话题线索" };
    const verified = source.verified ? ` · 同群来源已核验${source.at ? " · " + new Date(source.at).toLocaleString("zh-CN", { hour12: false }) : ""}` : "";
    const actor = source.kind === "quote" && source.userId ? " · 发言人 " + source.userId : "";
    const note = source.kind === "note" ? ` · 条目 ${source.noteId || "未知"} · 修订 ${source.revision || 0}` : "";
    return `${kinds[source.kind] || "上下文"} ${source.messageId || "旧记录"}${actor} · ${reasons[source.reason] || "相关"}${verified}${note}${source.clipped ? " · 摘录或所在层已裁剪" : ""}`;
  }

  function stepDetails(step) {
    const tools = toolDetails(step);
    if (step.stage === "tool") {
      const reason = typeof step.reason === "string" && Object.hasOwn(toolReasons, step.reason) ? toolReasons[step.reason] : "";
      return [reason, ...tools].filter(Boolean).join(" · ");
    }
    return [step.reason && label(step.reason), step.provider, step.position && label(step.position), step.route && label(step.route), step.model,
      step.selfFactsVersion && `运行事实 v${step.selfFactsVersion} · ${step.capabilityCount || 0} 项能力`,
      step.turnRevision && `回复修订 ${step.turnRevision}`, step.privacyRevision !== undefined && `隐私代次 ${step.privacyRevision}`,
      step.promptVersion && `提示词 ${step.promptVersion}`, step.promptFingerprint && `前缀 ${step.promptFingerprint}`,
      step.staticChars > 0 && `固定 ${step.staticChars} 字符`, step.dynamicChars > 0 && `表达设置 ${step.dynamicChars} 字符`,
      step.inputTextChars > 0 && `组装正文 ${step.inputTextChars} 字符`,
      step.stage === "vision" && `可读 ${step.images || 0} 张 · 失败 ${step.imageFailed || 0} 张 · 超限 ${step.imageOmitted || 0} 张`,
      step.imageFirstFrames > 0 && `${step.imageFirstFrames} 张动态图仅读首帧`,
      step.chars !== undefined && `${step.chars} 字符`, step.messages !== undefined && `${step.messages} 层上下文`,
      step.pruned > 0 && `裁剪 ${step.pruned} 层`, step.httpStatus > 0 && `HTTP ${step.httpStatus}`,
      step.attempt && `第 ${step.attempt} 次`, step.probability !== undefined && `概率 ${Math.round(step.probability * 100)}%`,
      step.promptTokens > 0 && `输入 ${step.promptTokens} / 缓存 ${step.cachedTokens || 0} token`,
      ...tools,
    ].filter(Boolean).join(" · ");
  }

  function toolDetails(step) {
    const count = key => {
      const value = step[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9 ? String(value) : "";
    };
    const budget = (title, countKey, limitKey) => {
      const used = count(countKey); const limit = count(limitKey);
      if (used) return `${title} ${used}${limit ? " / " + limit : ""}`;
      return limit ? `${title}上限 ${limit}` : "";
    };
    return [
      typeof step.toolName === "string" && Object.hasOwn(toolNames, step.toolName) && toolNames[step.toolName],
      budget("模型轮次", "modelRounds", "modelRoundLimit"), budget("工具调用", "toolCalls", "toolLimit"),
      count("transportAttempts") && `传输尝试 ${count("transportAttempts")} 次`,
      count("toolResultChars") && `本次结果 ${count("toolResultChars")} 字符`,
      count("toolOutputChars") && `工具累计输出 ${count("toolOutputChars")} 字符`,
      count("requestedCompletionTokens") && `累计请求额度 ${count("requestedCompletionTokens")} token（非实际用量）`,
    ];
  }

  function duration(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.max(0, Math.round(ms))} ms`; }

  function renderReplay(data) {
    replay = data;
    const select = $("replayCase"); const selected = select.value;
    select.replaceChildren();
    for (const item of data.cases) {
      const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; select.append(option);
    }
    if (data.cases.some(item => item.id === selected)) select.value = selected;
    renderCase();
  }

  function renderCase() {
    const item = replay?.cases.find(example => example.id === $("replayCase").value);
    if (!item) return;
    $("replayInput").textContent = item.input;
    $("replayExpectations").replaceChildren();
    item.expectations.forEach(text => { const li = document.createElement("li"); li.textContent = text; $("replayExpectations").append(li); });
    $("replaySources").hidden = !item.packet.sources?.length;
    $("replaySources").textContent = (item.packet.sources || []).map(sourceLabel).join("；");
    for (const [field, key] of [["Baseline", "baseline"], ["Candidate", "candidate"]]) {
      const answer = item[key];
      $("replay" + field).textContent = answer?.text || (key === "baseline" ? "尚未保存基线" : "尚未生成候选");
      $("replay" + field + "Meta").textContent = answer ? `${answer.version} · ${answer.provider} · ${label(answer.position)} · ${duration(answer.durationMs)}${answer.fingerprint !== item.packet.fingerprint ? " · 输入已变化" : ""}` : "";
    }
    $("replayReview").value = item.review;
    $("replayPacket").textContent = item.packet.messages.map(message => `[${message.role}]\n${message.content}`).join("\n\n");
    $("replayQuota").textContent = `今日生成 ${replay.todayRuns} / ${replay.dailyLimit}`;
    updateReplayButtons();
  }

  function updateReplayButtons() {
    const selected = replay?.cases.find(item => item.id === $("replayCase").value);
    for (const name of ["baseline", "review"]) replayPanel.querySelector(`[data-diagnostic-action="${name}"]`).disabled = busy.has("replay") || !selected?.candidate;
    replayPanel.querySelector('[data-diagnostic-action="generate"]').disabled = busy.has("replay") || !selected || replay.todayRuns >= replay.dailyLimit;
  }

  async function replayAction(name) {
    const data = await callManagedAction("replayAction", { action: name, caseId: $("replayCase").value, review: $("replayReview").value }, {
      onProgress: task => notice("replayNotice", taskPhaseLabel(task.phase)),
    });
    if (name === "check") {
      const failed = data.checks.filter(item => !item.ok);
      notice("replayNotice", failed.length ? `检查失败：${failed.map(item => item.name).join("、")}` : `${data.checks.length} 项输入和输出边界检查通过 · 未调用模型；答案质量请人工比较`, failed.length > 0);
    } else {
      renderReplay(data);
      notice("replayNotice", { generate: "候选回复已生成，未发送到 QQ", baseline: "基线已保存", review: "评价已保存" }[name]);
    }
  }

  window.addEventListener("qqfriend:task", async event => {
    const { task, type } = event.detail;
    if (task.module !== "replay") return;
    if (type === "started") busy.add("replay");
    if (type === "complete" || type === "error") {
      busy.delete("replay");
      try { renderReplay(await host.call("getReplay")); } catch { notice("replayNotice", "读取回放结果失败，请刷新", true); }
    }
    notice("replayNotice", task.error || taskPhaseLabel(task.phase), task.phase === "failed" || type === "error");
    replayPanel.setAttribute("aria-busy", String(busy.has("replay")));
    updateReplayButtons();
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-diagnostic-action]");
    if (button) action(button.dataset.diagnosticAction);
  });
  $("replayCase").addEventListener("change", renderCase);
  $("traceStatus").addEventListener("change", () => action("traces"));
  const view = document.querySelector('[data-view-panel="diagnostics"]');
  new MutationObserver(() => {
    if (!view.hidden && !loaded) { loaded = true; action("traces"); action("replay"); }
  }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
})();
