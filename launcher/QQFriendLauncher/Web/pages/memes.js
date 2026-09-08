import { $, escapeHtml, splitList } from "../ui/dom.js";
import { ACTION_DONE, MEME_FIELD_IDS } from "../ui/metadata.js";
import { uiState } from "../ui/state.js";

export function renderMemes(snapshot, options = {}) {
  uiState.memeSnapshot = snapshot || { entries: [], candidates: [] };
  const entries = Array.isArray(uiState.memeSnapshot.entries) ? uiState.memeSnapshot.entries : [];
  const desiredEntry = options.selectName || uiState.lastEntrySelection || entries[0]?.name || "";
  if ($("memeNavCount")) $("memeNavCount").textContent = String(entries.length);

  $("memeSelect").innerHTML = entries
    .map((entry) => `<option value="${escapeHtml(entry.name)}">${escapeHtml(entry.name)} · ${escapeHtml(entry.level || "B")} · ${memeStatusLabel(entry.status, entry.enabled)}</option>`)
    .join("");
  $("memeHistorySelect").innerHTML = (uiState.memeSnapshot.history || [])
    .map((item) => {
      const date = item.at ? new Date(item.at).toLocaleString("zh-CN") : "未知时间";
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.term)} · ${historyActionLabel(item.action)} · ${escapeHtml(date)}</option>`;
    })
    .join("");

  if (entries.some((entry) => entry.name === desiredEntry)) $("memeSelect").value = desiredEntry;
  uiState.lastEntrySelection = $("memeSelect").value;
  document.querySelectorAll("[data-action='setMemeMode']").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === uiState.memeSnapshot.mode);
  });
  const counts = uiState.memeSnapshot.counts || {};
  const sync = uiState.memeSnapshot.sync || {};
  const lastSync = sync.lastSuccessAt ? new Date(sync.lastSuccessAt).toLocaleString("zh-CN") : "尚未成功";
  const sourceStates = Object.entries(sync.sources || {});
  const sourceOk = sourceStates.filter(([, item]) => item?.ok).length;
  const sourceFailed = sourceStates.length - sourceOk;
  const latestRun = Array.isArray(sync.runs) ? sync.runs.at(-1) : null;
  const rolledBack = latestRun?.status === "rolled-back";
  $("memeUpdateState").textContent = sync.error
    ? "更新失败"
    : rolledBack
      ? "已回退"
      : sync.lastSuccessAt
        ? "已联网"
        : "等待更新";
  $("memeUpdateState").classList.toggle("dirty", Boolean(sync.error));
  $("memeStatus").textContent = [
    `模式：${memeModeLabel(uiState.memeSnapshot.mode)}`,
    `启用 ${counts.active ?? entries.filter((item) => item.enabled).length} · 隔离 ${counts.quarantined || 0} · 停用 ${counts.disabled || 0} · 过期 ${counts.stale || 0}`,
    `最近联网：${lastSync}`,
    rolledBack
      ? "最近一次联网批次已回退"
      : `本轮新增 ${sync.accepted || 0} · 更新 ${sync.updated || 0} · 审核 ${sync.review || 0}`,
    sourceStates.length ? `来源：可用 ${sourceOk} · 失败 ${sourceFailed}` : "来源：等待首次更新",
    sync.error ? `问题：${sync.error}` : "群聊不会自动造词；人工字段不会被联网更新覆盖。",
    `删除防复活：${uiState.memeSnapshot.tombstoneCount || 0}`,
  ].join("\n");

  if (options.forceFill || (!uiState.memeDirty && !$("memeName").value.trim())) {
    const selected = entries.find((entry) => entry.name === $("memeSelect").value);
    if (selected) fillMemeForm(selected);
    else clearMemeForm();
  }
  uiState.memesLoaded = true;
}

export function memeFormFingerprint() {
  return JSON.stringify({
    fields: Object.fromEntries(MEME_FIELD_IDS.map((id) => [id, $(id).value])),
    sources: readMemeSources(),
    locks: selectedMemeLocks(),
  });
}

export function setMemeSavedState() {
  uiState.memeBaseline = memeFormFingerprint();
  setMemeDirty(false);
}

export function setMemeDirty(value) {
  uiState.memeDirty = Boolean(value);
  const state = $("memeDirtyState");
  state.textContent = uiState.memeDirty ? "未保存" : "已保存";
  state.classList.toggle("dirty", uiState.memeDirty);
}

export function updateMemeDirty() {
  setMemeDirty(memeFormFingerprint() !== uiState.memeBaseline);
}

export function confirmDiscardMemeChanges() {
  return !uiState.memeDirty || window.confirm("当前词条有未保存修改。确定放弃这些修改吗？");
}

export function fillMemeForm(entry) {
  if (!entry) return;
  uiState.memeEditingOriginalName = entry.name || "";
  $("memeName").value = entry.name || "";
  $("memeLevel").value = entry.level || "B";
  $("memeConfidence").value = Math.round(Number(entry.confidence || 0) * 100);
  $("memeEntryStatus").value = entry.status || (entry.enabled === false ? "disabled" : "active");
  $("memeScopeType").value = entry.scope?.type === "groups" ? "groups" : "global";
  $("memeScopeGroups").value = Array.isArray(entry.scope?.groupIds) ? entry.scope.groupIds.join(" ") : "";
  updateMemeScopeInput();
  $("memeAliases").value = Array.isArray(entry.aliases) ? entry.aliases.join(" ") : "";
  $("memeTriggers").value = Array.isArray(entry.triggers) ? entry.triggers.join(" ") : "";
  $("memeMeaning").value = entry.meaning || "";
  $("memeUsage").value = entry.usage || "";
  $("memeExamples").value = Array.isArray(entry.examples) ? entry.examples.join("\n") : "";
  renderMemeSources(entry.sources || []);
  setMemeLocks(entry.manualFields || []);
  $("memeEntryMeta").textContent = formatMemeEntryMeta(entry);
  setMemeSavedState();
}

export function clearMemeForm() {
  uiState.memeEditingOriginalName = "";
  MEME_FIELD_IDS.forEach((id) => {
    const node = $(id);
    if (node.tagName === "SELECT") return;
    node.value = "";
  });
  $("memeLevel").value = "B";
  $("memeConfidence").value = "70";
  $("memeEntryStatus").value = "active";
  $("memeScopeType").value = "global";
  $("memeScopeGroups").value = "";
  updateMemeScopeInput();
  renderMemeSources([]);
  setMemeLocks(uiState.memeSnapshot.editableFields || []);
  $("memeEntryMeta").textContent = "新词条将作为人工词条保存。";
  setMemeSavedState();
}

export function applyMemeResearch(result) {
  if (!result?.ok || !result.entry) return false;
  const entry = result.entry;
  $("memeName").value = entry.name || result.query || "";
  $("memeLevel").value = entry.level || "A";
  $("memeConfidence").value = Math.round(Number(entry.confidence || 0.8) * 100);
  $("memeEntryStatus").value = "active";
  $("memeAliases").value = splitList(entry.aliases || []).join(" ");
  $("memeTriggers").value = splitList(entry.triggers || [entry.name]).join(" ");
  $("memeMeaning").value = entry.meaning || "";
  $("memeUsage").value = entry.usage || "";
  $("memeExamples").value = (entry.examples || []).join("\n");
  renderMemeSources(entry.sources || result.evidence || []);
  setMemeLocks(uiState.memeSnapshot.editableFields || []);
  $("memeStatus").textContent = [
    `联网查证已回填：${entry.name || result.query}`,
    `证据：${(result.evidence || []).length} 条 · 审核模型 ${result.review?.provider || "已兜底"}`,
    uiState.memeEditingOriginalName ? "保存会更新当前词条。" : "保存后会新增人工确认词条。",
  ].join("\n");
  uiState.memeBaseline = "";
  setMemeDirty(true);
  return true;
}

export function memeFormPayload() {
  const status = $("memeEntryStatus").value;
  return {
    action: "save",
    entry: {
      originalName: uiState.memeEditingOriginalName,
      name: $("memeName").value.trim(),
      level: $("memeLevel").value,
      confidence: Number($("memeConfidence").value || 0) / 100,
      enabled: status === "active",
      status,
      scope: {
        type: $("memeScopeType").value,
        groupIds: splitList($("memeScopeGroups").value),
      },
      aliases: splitList($("memeAliases").value),
      triggers: splitList($("memeTriggers").value),
      meaning: $("memeMeaning").value.trim(),
      usage: $("memeUsage").value.trim(),
      examples: $("memeExamples").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      sources: readMemeSources(),
      manualFields: selectedMemeLocks(),
    },
  };
}

export function selectedMemeName() {
  return $("memeName").value.trim() || $("memeSelect").value;
}

export function selectedMemeQuery() {
  return $("memeName").value.trim() || $("memeSelect").value;
}

export function renderMemeSources(sources) {
  $("memeSourceList").innerHTML = "";
  for (const source of Array.isArray(sources) ? sources : []) addMemeSourceRow(source);
}

export function addMemeSourceRow(source = {}) {
  $("memeSourceList").insertAdjacentHTML("beforeend", `
    <div class="meme-source-row">
      <input data-source-field="platform" aria-label="来源平台" placeholder="平台" value="${escapeHtml(source.platform || "manual")}">
      <input data-source-field="title" aria-label="来源标题" placeholder="标题" value="${escapeHtml(source.title || "")}">
      <input data-source-field="url" aria-label="来源链接" placeholder="https://" value="${escapeHtml(source.url || "")}">
      <button type="button" class="icon-button danger-quiet" data-remove-meme-source title="删除来源" aria-label="删除来源">×</button>
    </div>
  `);
  updateMemeDirty();
}

export function readMemeSources() {
  return [...document.querySelectorAll(".meme-source-row")]
    .map((row) => ({
      platform: row.querySelector('[data-source-field="platform"]').value.trim() || "manual",
      title: row.querySelector('[data-source-field="title"]').value.trim(),
      url: row.querySelector('[data-source-field="url"]').value.trim(),
      kind: "manual",
    }))
    .filter((item) => item.title || item.url);
}

export function selectedMemeLocks() {
  const fields = [...document.querySelectorAll("[data-meme-lock]:checked")]
    .map((input) => input.dataset.memeLock);
  if (fields.includes("confidence")) fields.push("semanticConfidence");
  if (fields.includes("status")) fields.push("enabled");
  return [...new Set(fields)];
}

export function setMemeLocks(fields) {
  const selected = new Set(Array.isArray(fields) ? fields : []);
  if (selected.has("semanticConfidence")) selected.add("confidence");
  if (selected.has("enabled")) selected.add("status");
  document.querySelectorAll("[data-meme-lock]").forEach((input) => {
    input.checked = selected.has(input.dataset.memeLock);
  });
}

export function historyActionLabel(action) {
  return ({
    create: "新建前",
    edit: "编辑前",
    enable: "启用前",
    disable: "停用前",
    active: "恢复前",
    quarantined: "隔离前",
    delete: "删除前",
  })[action] || action || "修改前";
}

export function updateMemeScopeInput() {
  const globalScope = $("memeScopeType").value !== "groups";
  $("memeScopeGroups").disabled = globalScope;
  if (globalScope) $("memeScopeGroups").value = "";
}

export function memeStatusLabel(status, enabled) {
  if (status === "quarantined") return "隔离";
  if (status === "stale") return "过期";
  if (status === "disabled" || enabled === false) return "停用";
  if (status === "candidate") return "待审核";
  return "启用";
}

export function memeModeLabel(mode) {
  return ({ steady: "全部词条", shadow: "仅人工词条", off: "关闭" })[mode] || mode || "全部词条";
}

export function formatMemeEntryMeta(entry) {
  const scope = entry.scope?.type === "groups"
    ? `仅来源群（${entry.scope.groupCount || 0} 个）`
    : "全局";
  const evidence = entry.evidence || {};
  const verifiedAt = entry.lastVerifiedAt
    ? new Date(entry.lastVerifiedAt).toLocaleString("zh-CN")
    : "人工维护";
  return [
    `来源：${entry.source || "未知"} · 范围：${scope} · 状态：${memeStatusLabel(entry.status, entry.enabled)}`,
    `资料：${entry.sources?.length || 0} 条 · 查证：${verifiedAt} · 使用记录 ${entry.seenCount || 0} 次`,
    `证据：${evidence.count || 0} 条 · ${evidence.contexts || 0} 个来源域`,
    entry.manualProtected ? `人工保护：${entry.manualFields?.length || 0} 个字段` : "人工保护：未选择",
  ].join("\n");
}

export function formatMemeOperationResult(action, result) {
  const snapshot = result?.snapshot || {};
  const lines = [ACTION_DONE[action] || result?.message || "梗库操作完成"];
  if (Array.isArray(snapshot.entries)) lines.push(`当前词条：${snapshot.entries.length}`);
  if (action === "runMemeWebUpdate" && result.result) {
    lines.push(`新增 ${result.result.accepted || 0} · 更新 ${result.result.updated || 0} · 审核 ${result.result.reviewed || 0}`);
  }
  if (action === "rollbackMemeWebUpdate" && result.result) {
    lines.push(`已恢复 ${result.result.restored || 0} 个词条`);
  }
  return lines.join("\n");
}
