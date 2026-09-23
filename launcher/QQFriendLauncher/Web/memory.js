const DEFAULT_LIMITS = { maxItems: 32, maxTextChars: 300, maxTitleChars: 32, ttlDays: 90 };
const kindLabel = kind => ({ user_statement: "用户自述", operator_note: "管理员备注" }[kind] || "未知类型");
const dateLabel = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录";

export function initializeMemory(host, { document: doc = document, window: win = window } = {}) {
  const $ = id => doc.getElementById(id);
  const panel = $("memoryPanel");
  let snapshot = null;
  let selectedId = "";
  let creating = false;
  let baseline = "";
  let busy = "";
  let stale = false;
  let requestId = 0;
  const limits = () => snapshot?.limits || DEFAULT_LIMITS;
  const current = () => snapshot?.items.find(item => item.id === selectedId);
  const fields = () => ({ title: $("memoryTitle").value, text: $("memoryText").value, ttlDays: $("memoryTtl").value });
  const dirty = () => (creating || Boolean(current())) && JSON.stringify(fields()) !== baseline;
  const target = () => ({
    groupId: $("memoryScope").value === "private" ? "private" : $("memoryGroup").value.trim(),
    userId: $("memoryUser").value.trim(),
  });
  const sameTarget = (a, b) => a && b && String(a.groupId) === String(b.groupId) && String(a.userId) === String(b.userId);
  const usable = () => snapshot && !stale && sameTarget(snapshot, target());
  const discard = () => !dirty() || win.confirm("记忆有未保存修改。确定放弃这些修改吗？");

  function notice(text, error = false) {
    $("memoryNotice").textContent = text;
    $("memoryNotice").dataset.error = String(error);
  }

  function controls() {
    const ready = !busy && usable();
    panel.setAttribute("aria-busy", String(Boolean(busy)));
    for (const id of ["memoryScope", "memoryGroup", "memoryUser", "memoryLoad"]) $(id).disabled = busy === "write";
    $("memoryGroupField").hidden = $("memoryScope").value === "private";
    $("memoryGroup").disabled = busy === "write" || $("memoryScope").value === "private";
    $("memoryRefresh").disabled = busy === "write" || !snapshot;
    $("memoryNew").disabled = !ready || snapshot.items.filter(item => item.state !== "expired").length >= limits().maxItems;
    for (const id of ["memoryTitle", "memoryText", "memoryTtl"]) $(id).disabled = !ready || (!creating && !current());
    $("memorySave").disabled = !ready || (!creating && !dirty());
    $("memoryDelete").disabled = !ready || !current() || creating;
    for (const button of $("memoryList").querySelectorAll("button")) button.disabled = !ready;
    $("memoryDirty").textContent = dirty() ? "未保存" : "";
    $("memoryChars").textContent = `${$("memoryText").value.length} / ${limits().maxTextChars} 字`;
    $("memoryTitle").maxLength = limits().maxTitleChars;
    $("memoryText").maxLength = limits().maxTextChars;
    $("memoryTtl").max = limits().ttlDays;
  }

  function sourceDetails(item) {
    $("memorySource").replaceChildren();
    if (!item) return;
    const source = item.source || {};
    const values = [
      ["当前类型", kindLabel(item.kind)],
      ["来源", { user_command: "用户记忆命令", operator: "管理员操作" }[source.kind] || "未知来源"],
      ["消息 ID", source.messageId || "无"], ["来源时间", dateLabel(source.at)],
      ["创建", dateLabel(item.createdAt)], ["更新", dateLabel(item.updatedAt)],
      ["到期", dateLabel(item.expiresAt)], ["状态", item.state === "expired" ? "已过期" : "有效"],
      ["记录修订", String(item.revision)],
    ];
    for (const [label, value] of values) {
      const dt = doc.createElement("dt"); dt.textContent = label;
      const dd = doc.createElement("dd"); dd.textContent = value;
      $("memorySource").append(dt, dd);
    }
  }

  function renderList() {
    const list = $("memoryList");
    list.replaceChildren();
    if (!snapshot?.items.length) {
      const empty = doc.createElement("p"); empty.className = "memory-meta";
      empty.textContent = snapshot ? "此范围内暂无该用户的记忆。" : "尚未读取";
      list.append(empty);
    }
    for (const item of snapshot?.items || []) {
      const button = doc.createElement("button"); button.type = "button"; button.className = "memory-record";
      button.setAttribute("aria-pressed", String(!creating && item.id === selectedId));
      button.dataset.expired = String(item.state === "expired");
      const title = doc.createElement("strong"); title.textContent = item.title || "无标题";
      const meta = doc.createElement("small");
      meta.textContent = `${kindLabel(item.kind)} · ${item.state === "expired" ? "已过期" : "有效"} · 到期 ${dateLabel(item.expiresAt)}`;
      button.append(title, meta);
      button.addEventListener("click", () => {
        if (busy || !usable() || (!creating && item.id === selectedId) || !discard()) return;
        selectedId = item.id; creating = false; renderEditor();
      });
      list.append(button);
    }
  }

  function renderEditor() {
    const item = creating ? null : current();
    $("memoryEditorTitle").textContent = creating ? "新建管理员备注" : item ? "编辑记录" : "未选择记录";
    $("memorySave").textContent = creating || !item ? "创建备注" : "保存修改";
    $("memoryTitle").value = item?.title || "";
    $("memoryText").value = item?.text || "";
    $("memoryTtl").value = "30";
    baseline = JSON.stringify(fields());
    sourceDetails(item);
    renderList(); controls();
  }

  function accept(result, expected, preferId) {
    if (!result?.ok || !sameTarget(result, expected) || typeof result.revision !== "string" || !result.revision ||
        !Array.isArray(result.items) || !result.preferences || !Array.isArray(result.inferences)) {
      throw new Error("记忆响应不完整或与查询用户不符，请重新查询。");
    }
    snapshot = { ...result, limits: { ...DEFAULT_LIMITS, ...result.limits } };
    stale = false;
    creating = false;
    selectedId = result.items.some(item => item.id === preferId) ? preferId : result.items[0]?.id || "";
    $("memoryTarget").textContent = `${result.groupId === "private" ? "私聊" : "群 " + result.groupId} · QQ ${result.userId}`;
    $("memoryCount").textContent = `${result.items.length} / ${limits().maxItems}`;
    $("memoryDisplayName").textContent = result.preferences.displayName || "未设置";
    $("memoryStyleText").textContent = result.preferences.styleText || "未设置";
    $("memoryInferences").replaceChildren();
    for (const item of result.inferences) {
      const li = doc.createElement("li");
      li.textContent = `${item.label} · 来源 ${item.sourceCount} 条 · 最近 ${dateLabel(item.latestAt)}`;
      $("memoryInferences").append(li);
    }
    if (!result.inferences.length) {
      const li = doc.createElement("li"); li.textContent = "暂无推断"; $("memoryInferences").append(li);
    }
    $("memoryLegacy").textContent = result.legacyInferenceIgnored ? "旧版推断已忽略。" : "";
    renderEditor();
  }

  async function refresh() {
    if (busy === "write") return;
    const expected = target();
    if (!/^(?:[0-9]+|private)$/.test(expected.groupId) || !/^[0-9]+$/.test(expected.userId)) {
      notice("请填写数字群号与 QQ 号；私聊也必须指定 QQ 号。", true); return;
    }
    if (!discard()) return;
    const ticket = ++requestId;
    busy = "read"; controls(); notice("正在读取指定用户的记忆…");
    try {
      const result = await host.call("getMemory", expected);
      // A later query, scope change or navigation owns the UI now.
      if (ticket !== requestId || !sameTarget(expected, target())) return;
      accept(result, expected, sameTarget(snapshot, expected) ? selectedId : "");
      notice(result.items.length ? "记忆已刷新。" : "查询完成，暂无记忆。可新建管理员备注。");
    } catch (error) {
      if (ticket !== requestId) return;
      stale = true;
      notice(`${error.message || "读取失败"}；请重新查询。现有内容未更新。`, true);
    } finally {
      if (ticket === requestId) { busy = ""; controls(); }
    }
  }

  async function save(action) {
    if (busy || !usable() || (!creating && !current())) return;
    if (action === "remove" && creating) return;
    const values = fields();
    const ttlDays = Number(values.ttlDays);
    if (action !== "remove" && (!values.title.trim() || !values.text.trim() || values.text.length > limits().maxTextChars ||
        values.title.length > limits().maxTitleChars || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > limits().ttlDays)) {
      notice(`标题和内容必填，分别不超过 ${limits().maxTitleChars} / ${limits().maxTextChars} 字；有效天数为 1–${limits().ttlDays} 的整数。`, true); return;
    }
    const expected = { groupId: snapshot.groupId, userId: snapshot.userId };
    const who = `${expected.groupId === "private" ? "私聊" : "群 " + expected.groupId} / QQ ${expected.userId}`;
    const question = action === "remove"
      ? `确定删除 ${who} 的「${current().title || "无标题"}」？此操作不可撤销${dirty() ? "，未保存修改也将丢弃" : ""}。`
      : `确定${creating ? "创建" : "保存"} ${who} 的记忆？保存后为管理员备注，不代表用户自述；有效期从保存时起 ${ttlDays} 天。`;
    if (!win.confirm(question)) return;
    const payload = { ...expected, action: action === "remove" ? "remove" : creating ? "create" : "update", revision: snapshot.revision };
    if (!creating) payload.id = selectedId;
    if (action !== "remove") Object.assign(payload, { title: values.title.trim(), text: values.text.trim(), ttlDays });
    const previousIds = new Set(snapshot.items.map(item => item.id));
    const ticket = ++requestId;
    busy = "write"; controls(); notice(action === "remove" ? "正在删除…" : "正在保存管理员备注…");
    try {
      const result = await host.call("saveMemory", payload);
      if (ticket !== requestId) return;
      const preferId = payload.action === "create" ? result.items?.find(item => !previousIds.has(item.id))?.id : selectedId;
      accept(result, expected, preferId);
      notice(action === "remove" ? "记录已删除。" : "已保存为管理员备注。");
    } catch (error) {
      if (ticket !== requestId) return;
      stale = error.status !== 400;
      const message = error.status === 409
        ? "记忆已被其他操作修改。草稿已保留，请刷新核对后再编辑；未自动覆盖。"
        : error.transportFailure || !error.status
          ? "未能确认操作结果。请先刷新核实，勿重复提交；草稿已保留。"
          : `${error.message || "操作失败"}；草稿已保留。${stale ? "请刷新后重试。" : "请修正后重试。"}`;
      notice(message, true);
    } finally {
      if (ticket === requestId) { busy = ""; controls(); }
    }
  }

  function queryChanged() {
    if (busy === "write") return;
    ++requestId; busy = "";
    // Even switching back requires a fresh read, never silently reuse a snapshot.
    stale = Boolean(snapshot);
    notice(snapshot ? "查询条件已更改，原快照未更新。请查询后再编辑。" : "尚未读取，请查询指定范围与 QQ 号。");
    controls();
  }

  $("memoryQuery").addEventListener("submit", event => { event.preventDefault(); return refresh(); });
  $("memoryRefresh").addEventListener("click", refresh);
  $("memoryEditor").addEventListener("submit", event => { event.preventDefault(); return save("save"); });
  $("memoryDelete").addEventListener("click", () => save("remove"));
  $("memoryNew").addEventListener("click", () => {
    if (busy || !usable() || snapshot.items.filter(item => item.state !== "expired").length >= limits().maxItems || !discard()) return;
    selectedId = ""; creating = true; renderEditor(); $("memoryTitle").focus();
  });
  $("memoryScope").addEventListener("change", queryChanged);
  for (const id of ["memoryGroup", "memoryUser"]) $(id).addEventListener("input", queryChanged);
  for (const id of ["memoryTitle", "memoryText", "memoryTtl"]) $(id).addEventListener("input", controls);
  win.addEventListener("beforeunload", event => {
    if (!dirty() && busy !== "write") return;
    event.preventDefault(); event.returnValue = "";
  });
  controls();
  return {
    canLeave() {
      if (busy === "write") { notice("正在提交记忆，请等待操作结果后再离开。", true); return false; }
      if (!discard()) return false;
      if (dirty()) renderEditor();
      if (busy === "read") {
        ++requestId; busy = ""; stale = Boolean(snapshot);
        notice("读取已取消，请重新查询。"); controls();
      }
      return true;
    },
  };
}
