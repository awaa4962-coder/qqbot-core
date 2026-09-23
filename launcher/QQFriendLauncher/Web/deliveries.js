const statusLabels = {
  processing: "处理中", sending: "等待发送回执", sent: "已确认发送", silent: "主动不回复", failed: "失败",
  cancelled: "已停止", resolved: "已人工核实", partial: "部分发送", unknown: "结果未知", interrupted: "处理已中断",
};

export function initializeDeliveries(host) {
  const $ = id => document.getElementById(id);
  const panel = $("deliveryPanel");
  panel.hidden = false;
  let busy = false;
  let loaded = false;
  function notice(text, error = false) {
    $("deliveryNotice").textContent = text;
    $("deliveryNotice").dataset.error = String(error);
  }
  async function refresh() {
    const data = await host.call("getDeliveries", { status: $("deliveryStatus").value, groupId: $("deliveryGroup").value.trim(), userId: $("deliveryUser").value.trim() });
    render(data);
    if (data.health !== "ready") { notice(data.error || "发送状态不可用", true); return false; }
    notice(`符合条件 ${data.total} 条 · 已记录 ${data.stored} / ${data.capacity} 条 · 已结束记录保留 ${data.retentionHours} 小时 · 待核实记录保留，不自动重发`);
    return true;
  }
  async function action(operation) {
    if (busy) return;
    busy = true;
    panel.setAttribute("aria-busy", "true");
    panel.querySelectorAll("button,input,select").forEach(node => { node.disabled = true; });
    notice("正在处理…");
    try { await operation(); }
    catch (error) { notice(error.message || "操作失败，请刷新后检查", true); }
    finally {
      busy = false;
      panel.setAttribute("aria-busy", "false");
      panel.querySelectorAll("button,input,select").forEach(node => { node.disabled = false; });
    }
  }
  async function resolve(item, delivered) {
    const result = delivered ? "已收到" : "未收到";
    if (!window.confirm(`已在 QQ 核实这条回复${result}？只记录核实结果，不补发消息，也不补写聊天记忆。`)) return;
    await action(async () => {
      await host.call("resolveDelivery", { id: item.id, action: delivered ? "confirm-delivered" : "confirm-not-delivered" });
      if (await refresh()) notice(`已记录「${result}」，未发送任何消息。`);
    });
  }
  function render(data) {
    const body = $("deliveryRows");
    body.replaceChildren();
    if (!data.items?.length) {
      const cell = body.insertRow().insertCell(); cell.colSpan = 4;
      cell.textContent = data.health === "ready" ? "暂无符合条件的记录" : "记录暂时不可用";
    }
    for (const item of data.items || []) {
      const row = body.insertRow();
      const time = new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false });
      const values = [`${time} · ${item.surface === "private" ? "私聊" : "群聊"}`, statusLabels[item.status] || "未知状态", `${item.confirmed} / ${item.uncertain}`];
      for (const [index, text] of values.entries()) {
        const cell = row.insertCell(); cell.textContent = text;
        cell.dataset.label = ["时间 / 范围", "状态", "确认 / 未知段数"][index];
      }
      const cell = row.insertCell(); cell.dataset.label = "核实结果";
      if (!item.active && ["partial", "unknown", "interrupted"].includes(item.status)) {
        const actions = document.createElement("div"); actions.className = "delivery-actions";
        for (const delivered of [true, false]) {
          const button = document.createElement("button"); button.type = "button";
          button.textContent = delivered ? "已收到" : "未收到";
          button.title = "记录人工核实结果，不重发";
          button.addEventListener("click", () => resolve(item, delivered)); actions.append(button);
        }
        cell.append(actions);
      } else cell.textContent = { checked_delivered: "人工确认已收到", checked_not_delivered: "人工确认未收到" }[item.resolution] || "无需核实";
    }
  }
  $("refreshDeliveries").addEventListener("click", () => action(refresh));
  $("deliveryStatus").addEventListener("change", () => action(refresh));
  for (const id of ["deliveryGroup", "deliveryUser"]) $(id).addEventListener("keydown", event => { if (event.key === "Enter") action(refresh); });
  const view = document.querySelector('[data-view-panel="diagnostics"]');
  new MutationObserver(() => {
    if (!view.hidden && !loaded) { loaded = true; action(refresh); }
  }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
}
