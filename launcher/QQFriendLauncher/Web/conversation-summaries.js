import { host } from "./ui/state.js";
import { taskPhaseLabel, waitForTask } from "./ui/tasks.js";

if (host.mode === "browser") {
  const panel = document.getElementById("conversationSummaryPanel");
  const view = panel.closest("[data-view-panel]");
  const notice = document.getElementById("conversationSummaryNotice");
  const button = document.getElementById("refreshConversationSummaries");
  let polling = false;
  panel.hidden = false;
  const finished = task => ["done", "failed", "interrupted"].includes(task.phase);
  const time = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

  function render(snapshot) {
    const body = document.getElementById("conversationSummaryRows");
    body.replaceChildren();
    for (const task of [...snapshot.tasks].reverse()) {
      const row = body.insertRow();
      row.insertCell().textContent = `${time(task.startedAt)} / 群 ${task.groupId}`;
      row.insertCell().textContent = `${task.targetCount} 人 / ${time(task.from)} 至 ${time(task.to)}`;
      row.insertCell().textContent = task.error || ({ analyzing: "模型正在总结", fallback: "备用模型正在总结", sending: "正在发送" })[task.phase] || taskPhaseLabel(task.phase);
      row.insertCell().textContent = task.provider || "-";
      ["时间 / 群", "人数 / 范围", "状态", "模型"].forEach((label, index) => { row.cells[index].dataset.label = label; });
    }
    if (!snapshot.tasks.length) { const cell = body.insertRow().insertCell(); cell.colSpan = 4; cell.textContent = "暂无成员总结任务"; }
    notice.textContent = `${snapshot.tasks.length} 个任务 · 不显示聊天原文`;
  }

  async function refresh() {
    if (polling || view.hidden) return;
    polling = true; button.disabled = true;
    try {
      await waitForTask(() => host.call("getConversationSummaries"), {
        onProgress: render, isDone: snapshot => view.hidden || snapshot.tasks.every(finished),
      });
      notice.dataset.error = "false";
    } catch (error) { notice.textContent = error.message || "读取任务失败"; notice.dataset.error = "true"; }
    finally { polling = false; button.disabled = false; }
  }
  button.addEventListener("click", refresh);
  new MutationObserver(() => { if (!view.hidden) refresh(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
}
