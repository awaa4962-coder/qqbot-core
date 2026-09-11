import { callManagedAction, taskPhaseLabel } from "./ui/tasks.js";

(function () {
  "use strict";
  const host = window.QQFriendHost;
  if (host.mode !== "browser") return;
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
  const labels = {
    processing: "处理中", sent: "已发送", partial: "部分成功", failed: "失败", ignored: "未触发", no_reply: "未产生回复", processed: "处理结束",
    received: "接收", admission: "准入", route: "路由", context: "上下文", model: "模型", output: "正文检查", send: "发送", complete: "结束",
    started: "开始", ok: "成功", skipped: "跳过", primary: "主模型", fallback: "备用模型", local: "本地恢复", unavailable: "模型不可用", model_unavailable: "模型未产生可用正文",
    group_at: "群聊 @", interjection: "自动插话", private_chat: "私聊", private_file: "私聊文件", command: "命令", preview: "链接预览", file: "文件", jm: "JM", "resource-transfer": "资源转发", "link-preview": "链接预览", wordcloud: "词云", "conversation-summary": "成员聊天总结",
    group_not_whitelisted: "群不在白名单", blacklisted_user: "发送人被屏蔽", self_message: "机器人自身消息", duplicate_event: "重复投递", duplicate_text: "复读消息", private_not_whitelisted: "私聊不在白名单",
    ingress_rate_limited: "入口限流", scope_rate_limited: "当前会话限流", priority_rate_limited: "优先通道限流",
    accepted: "已接纳", preview_sent: "链接预览抑制插话", mentioned: "已进入 @ 回复", short: "消息太短", empty: "内容为空", no_probability: "该场景不自动插话", cooldown: "插话冷却中", random: "本次未命中插话概率", triggered: "触发插话",
    empty_content: "模型正文为空", empty_content_with_reasoning: "只有推理，没有正文", unsafe_reasoning: "正文含推理内容", secret_leak: "正文安全检查未通过", send_failed: "发送重试后失败", exception: "处理异常",
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
      li.textContent = `${label(step.stage)} · ${label(step.status)} · +${duration(step.elapsedMs - previous)}`;
      previous = step.elapsedMs;
      const detail = document.createElement("span");
      detail.textContent = stepDetails(step);
      li.append(detail); list.append(li);
      if (step.sources?.length) {
        const sources = document.createElement("span");
        sources.className = "trace-sources";
        sources.textContent = step.sources.map(sourceLabel).join("；");
        li.append(sources);
      }
    }
    box.append(list);
  }

  function sourceLabel(source) {
    const kinds = { quote: "引用", thread: "对话线程", memory: "个人历史", group: "群聊", image: "图片" };
    const reasons = { reply_chain: "引用链", continuation: "承接", keywords: "关键词", synonyms: "同义表达", mention: "被提及者", recent: "最近背景", image_reference: "明确看图指向" };
    return `${kinds[source.kind] || "上下文"} ${source.messageId || "旧记录"} · ${reasons[source.reason] || "相关"}${source.clipped ? " · 所在层已裁剪" : ""}`;
  }

  function stepDetails(step) {
    return [step.reason && label(step.reason), step.provider, step.position && label(step.position), step.route && label(step.route),
      step.chars !== undefined && `${step.chars} 字符`, step.messages !== undefined && `${step.messages} 层上下文`,
      step.pruned > 0 && `裁剪 ${step.pruned} 层`, step.httpStatus > 0 && `HTTP ${step.httpStatus}`,
      step.attempt && `第 ${step.attempt} 次`, step.probability !== undefined && `概率 ${Math.round(step.probability * 100)}%`,
      step.promptTokens > 0 && `输入 ${step.promptTokens} / 缓存 ${step.cachedTokens || 0} token`,
    ].filter(Boolean).join(" · ");
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
