(function () {
  "use strict";
  const host = window.QQFriendHost;
  if (host.mode !== "browser") return;
  const $ = id => document.getElementById(id);
  $("summaryNav").hidden = false;
  let snapshot = null;
  let selectedId = "";
  let dirty = false;
  let loading = false;
  let jobId = "";
  let pollTimer = null;
  const phaseNames = { queued: "排队中", collecting: "整理采集记录", analyzing: "主模型分析中", fallback: "备用模型分析中", saving: "保存草稿", sending: "发送中", done: "任务完成", failed: "任务失败", interrupted: "任务中断，请重新生成或核实发送状态" };
  const deliveryNames = { not_sent: "尚未发送", sent: "已发送", failed: "发送明确失败，可以重试", partial: "部分已发送，可继续剩余分段", unconfirmed: "发送待核实，不会自动重发", invalid_marker: "发送记录异常，请先核实" };

  function status(text, error = false) { $("summaryProgress").textContent = text; $("summaryProgress").dataset.error = String(error); }
  function current() { return snapshot?.revisions.find(item => item.id === selectedId); }
  function target() { return { groupId: $("summaryGroup").value, dateText: $("summaryDate").value }; }
  function canDiscard() { return !dirty || window.confirm("正文修改尚未保存，是否放弃这些修改？"); }

  async function refresh(preferId, preserve = false) {
    const result = await host.call("getSummaries", target());
    snapshot = result;
    if (!jobId) {
      const active = [...(result.jobs || [])].reverse().find(job => !["done", "failed", "interrupted"].includes(job.phase));
      if (active) { jobId = active.id; schedulePoll(); }
    }
    fillSelect($("summaryGroup"), result.groups.map(value => [value, "群 " + value]), result.groupId);
    $("summaryDate").value = result.dateText || "";
    if (!result.groups.length) { status("尚未配置日报群，请先在配置页添加。", true); controls(); return; }
    const coverage = result.coverage || {};
    $("summaryCoverage").textContent = `已采集 ${coverage.captured || 0} 条记录 · ${coverage.source === "retained-only" ? "仅有滚动保留记录，可能缺段" : "按日记录与滚动保留记录"}${coverage.capped ? " · 已达到采集上限" : ""}${coverage.truncated ? ` · ${coverage.truncated} 条长消息截短` : ""}`;
    selectedId = preferId || selectedId;
    if (!result.revisions.some(item => item.id === selectedId)) selectedId = result.revisions.at(-1)?.id || "";
    fillSelect($("summaryRevision"), result.revisions.map(item => [item.id, versionLabel(item)]), selectedId);
    const compare = $("summaryCompare").value;
    fillSelect($("summaryCompare"), [["", "不对照"], ...result.revisions.map(item => [item.id, versionLabel(item)])], compare);
    if (!preserve || !dirty) renderRevision();
    renderDelivery(); controls();
  }

  function fillSelect(element, items, value) {
    element.replaceChildren();
    for (const [id, label] of items) { const option = document.createElement("option"); option.value = id; option.textContent = label; element.append(option); }
    if (items.some(item => item[0] === value)) element.value = value;
  }

  function versionLabel(item) { return new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false }) + " · " + (item.kind === "edited" ? "人工修改" : item.kind === "topic-regenerated" ? "单讨论重写" : item.provider); }

  function renderRevision() {
    const revision = current();
    $("summaryBody").value = revision?.summary || "";
    dirty = false;
    fillSelect($("summaryTopic"), (revision?.document?.topics || []).map(item => [item.id, item.title]), "");
    $("summaryEvidence").replaceChildren();
    for (const item of revision?.evidence || []) {
      const article = document.createElement("article");
      const heading = document.createElement("strong");
      heading.textContent = `${item.id} · ${item.actorId} ${item.nickname || ""} · ${new Date(item.ts).toLocaleTimeString("zh-CN", { hour12: false })}`;
      const body = document.createElement("p"); body.textContent = item.text;
      article.append(heading, body); $("summaryEvidence").append(article);
    }
    renderCompare(); controls();
  }

  function renderCompare() { $("summaryPrevious").value = snapshot?.revisions.find(item => item.id === $("summaryCompare").value)?.summary || ""; }
  function renderDelivery() {
    const delivery = snapshot?.delivery || {};
    $("summaryDelivery").textContent = deliveryNames[delivery.status] || "发送状态待核实";
    $("summaryDeliveryDetail").textContent = delivery.total ? `已确认 ${delivery.completed || 0} / ${delivery.total} 段` : "";
  }

  function controls() {
    const busy = loading || Boolean(jobId);
    $("summaryWorkbench").setAttribute("aria-busy", String(busy));
    for (const element of $("summaryWorkbench").querySelectorAll("button,select,input")) element.disabled = busy;
    $("summaryBody").disabled = busy || !current();
    const button = name => document.querySelector(`[data-summary-action="${name}"]`);
    button("refresh").disabled = loading;
    button("generate").disabled = busy || !snapshot?.groups.length;
    button("save").disabled = busy || !current() || !dirty;
    button("regenerate-topic").disabled = busy || dirty || !current()?.document?.topics.length;
    button("send").disabled = busy || dirty || !current() || !["not_sent", "failed"].includes(snapshot?.delivery?.status);
    const resumable = snapshot?.delivery?.status === "partial" && snapshot.delivery.revisionId === selectedId;
    button("resume").hidden = !resumable;
    button("resume").disabled = busy || dirty || !resumable;
    for (const action of ["confirm-delivered", "confirm-not-delivered"]) {
      button(action).hidden = snapshot?.delivery?.status !== "unconfirmed" || snapshot.delivery.revisionId !== selectedId;
      if (action === "confirm-not-delivered" && snapshot?.delivery?.completed >= snapshot?.delivery?.total) button(action).hidden = true;
      button(action).disabled = busy;
    }
  }

  async function act(action) {
    if (loading) return;
    if (action !== "refresh" && jobId) return;
    if (["generate", "regenerate-topic"].includes(action) && !canDiscard()) return;
    if (["send", "resume"].includes(action) && !window.confirm(`将 ${target().dateText} 的所选日报${action === "resume" ? "剩余分段" : ""}发送到群 ${target().groupId}？`)) return;
    if (action.startsWith("confirm-") && !window.confirm(`请先核对群 ${target().groupId} 中第 ${Math.min((snapshot.delivery.completed || 0) + 1, snapshot.delivery.total)} 段。确认它${action === "confirm-delivered" ? "已送达" : "没有发送出去"}？`)) return;
    loading = true; controls(); status("正在处理…");
    try {
      if (action === "refresh") {
        await refresh(null, true);
        const active = snapshot?.jobs?.find(job => job.id === jobId);
        status(active ? phaseNames[active.phase] || active.phase : "已刷新"); return;
      }
      const result = await host.call("summaryAction", {
        action, ...target(), revisionId: selectedId, expectedRevisionId: snapshot?.revisions.at(-1)?.id,
        discussionId: $("summaryTopic").value, summary: action === "save" ? $("summaryBody").value : undefined,
      });
      if (result.jobId) { jobId = result.jobId; dirty = false; status("任务已提交"); schedulePoll(); }
      else { await refresh(result.revisionId); status("新版本已保存"); }
    } catch (error) {
      if (snapshot?.groupId) { $("summaryGroup").value = snapshot.groupId; $("summaryDate").value = snapshot.dateText; }
      status(error.message || "操作失败", true);
    }
    finally { loading = false; controls(); }
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(async () => {
      try {
        await refresh(null, true);
        const job = snapshot.jobs.find(item => item.id === jobId);
        if (!job) { jobId = ""; status("任务状态已失效，请刷新确认。", true); controls(); return; }
        status(job.error || phaseNames[job.phase] || job.phase, ["failed", "interrupted"].includes(job.phase));
        if (["done", "failed", "interrupted"].includes(job.phase)) {
          jobId = "";
          if (job.revisionId) { selectedId = job.revisionId; $("summaryRevision").value = selectedId; renderRevision(); }
          if (job.reason) status("未重复发送，原任务状态：" + job.reason);
          controls(); return;
        }
        schedulePoll();
      } catch (error) { jobId = ""; status(error.message || "读取任务状态失败", true); controls(); }
    }, 1200);
  }

  document.addEventListener("click", event => { const button = event.target.closest("[data-summary-action]"); if (button) act(button.dataset.summaryAction); });
  $("summaryBody").addEventListener("input", () => { dirty = $("summaryBody").value !== (current()?.summary || ""); controls(); });
  $("summaryRevision").addEventListener("change", () => { if (!canDiscard()) { $("summaryRevision").value = selectedId; return; } selectedId = $("summaryRevision").value; renderRevision(); });
  $("summaryCompare").addEventListener("change", renderCompare);
  for (const id of ["summaryGroup", "summaryDate"]) $(id).addEventListener("change", async () => {
    if (!canDiscard()) { $("summaryGroup").value = snapshot.groupId; $("summaryDate").value = snapshot.dateText; return; }
    dirty = false; selectedId = ""; await act("refresh");
  });
  const view = document.querySelector('[data-view-panel="summaries"]');
  new MutationObserver(() => { if (!view.hidden && !snapshot) act("refresh"); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
})();
