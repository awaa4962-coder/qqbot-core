import { toast } from "../ui/activity.js";
import { $, escapeHtml, splitList } from "../ui/dom.js";
import { CONFIG_FIELDS } from "../ui/metadata.js";
import { uiState } from "../ui/state.js";

export function renderConfig(status, configSnapshot) {
  const config = status.config || {};
  const modules = status.modules || {};
  const modelKeys = status.modelKeys || {};
  const linkPreview = modules.linkPreview || {};
  const wordcloud = modules.wordcloud || {};
  const memeKnowledge = modules.memeKnowledge || {};
  const cognition = modules.cognition || {};
  const imageContext = modules.imageContext || {};
  const files = configSnapshot.files && typeof configSnapshot.files === "object"
    ? Object.values(configSnapshot.files)
    : [];
  const editableFiles = files.filter((file) => file.status === "editable").length;
  const createOnSaveFiles = files.filter((file) => file.status === "editable-create-on-save").length;

  const rows = [
    ["机器人名称", config.botNames || [], "configuration"],
    ["群白名单", config.groupWhitelist || [], "configuration"],
    ["日报群", config.summaryGroupWhitelist || [], "configuration"],
    ["聊天总结群", config.conversationSummaryGroupWhitelist || [], "configuration"],
    ["资源 / JM 群", config.resourceGroupWhitelist || [], "configuration"],
    ["管理员", config.adminUins || [], "configuration"],
    ["功能模块", Object.entries(modules)
      .filter(([, item]) => item && item.enabled)
      .map(([name, item]) => moduleStatusLabel(name, item)), "services"],
    ["短期上下文", [
      cognition.enabled === false ? "未启用" : "已启用",
      `${Number(cognition.groupThreads || 0)} 个群线程`,
      `${Number(cognition.privateThreads || 0)} 个私聊线程`,
      cognition.privatePersistence ? "私聊会保存" : "私聊不落盘",
    ], "services"],
    ["链接预览", [
      linkPreview.enabled ? (linkPreview.mode === "smart" ? "智能模式" : "已启用") : "已关闭",
      `成功 ${linkPreview.hits || 0}`,
      `GitHub ${linkPreview.githubHits || 0}`,
      `跳过 ${linkPreview.skips || 0}`,
      `重复 ${linkPreview.duplicateSkips || 0}`,
      `错误 ${linkPreview.errors || 0}`,
    ], "logs"],
    ["群词云", [wordcloud.enabled ? "已启用" : "已关闭", `${Array.isArray(wordcloud.groups) ? wordcloud.groups.length : 0} 个群`, `最多 ${wordcloud.maxMessages || 0} 条消息`], "configuration"],
    ["梗库", [
      memeKnowledge.enabled ? "已启用" : "已关闭",
      memeKnowledge.mode === "shadow" ? "仅人工" : memeKnowledge.mode === "off" ? "已关闭" : "人工 + 联网",
      `${memeKnowledge.entries || 0} 个词条`,
      `${memeKnowledge.webVerified || 0} 个联网查证`,
    ], "memes"],
    ["图片语境", [imageContext.enabled ? "已启用" : "未启用", `${Number(imageContext.entries || 0)} 个表情包指纹`, `${Number(imageContext.hits || 0)} 次复用`, imageContext.storesImages ? "保存图片" : "不存图片"], "services"],
    ["模型服务", Object.entries(modelKeys).filter(([, enabled]) => enabled).map(([name]) => modelLabel(name)), "services"],
    ["配置文件", files.length > 0 ? [`${editableFiles} 个可直接编辑`, `${createOnSaveFiles} 个保存时创建`] : ["等待配置状态"], "maintenance"],
  ];

  $("configList").innerHTML = rows.map(([label, values, target]) => {
    const list = Array.isArray(values) && values.length > 0 ? values : ["-"];
    return `<div class="config-item"><b>${escapeHtml(label)}</b><div class="chips">${list.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div><button type="button" class="row-link" data-view="${target}">管理</button></div>`;
  }).join("");
}

export function renderConfigEditor(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (uiState.configDirty && !options.force) return;
  const editable = snapshot.editable || {};
  for (const [id, field] of Object.entries(CONFIG_FIELDS)) {
    const values = Array.isArray(editable[field]) ? editable[field] : [];
    $(id).value = field === "botNames" ? values.join(" ") : values.join("\n");
  }
  renderListEditors();
  uiState.configBaseline = configFingerprint();
  setConfigDirty(false);
  $("configStatus").textContent = snapshot.restartRequiredAfterSave
    ? "当前配置已载入，修改后保存并重启 Bridge 生效"
    : "当前配置已载入";
}

export function configFingerprint() {
  return JSON.stringify(Object.keys(CONFIG_FIELDS).map((id) => [id, $(id).value]));
}

export function setConfigDirty(value) {
  uiState.configDirty = Boolean(value);
  const state = $("configDirtyState");
  state.textContent = uiState.configDirty ? "未保存" : "已保存";
  state.classList.toggle("dirty", uiState.configDirty);
  if ($("configSaveHint")) $("configSaveHint").textContent = uiState.configDirty ? "配置有未保存修改" : "没有未保存修改";
  if ($("configSaveBar")) $("configSaveBar").classList.toggle("dirty", uiState.configDirty);
}

export function updateConfigDirty() {
  setConfigDirty(configFingerprint() !== uiState.configBaseline);
}

export function configPayload() {
  return {
    editable: Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([id, field]) => [field, splitList($(id).value)])),
  };
}

export function renderListEditors() {
  document.querySelectorAll("[data-list-editor-for]").forEach((editor) => {
    const source = $(editor.dataset.listEditorFor);
    if (!source) return;
    const values = splitList(source.value);
    const chips = editor.querySelector(".list-editor-chips");
    chips.innerHTML = values.map((value) => `<span class="list-chip">${escapeHtml(value)}<button type="button" data-list-remove="${escapeHtml(value)}" title="移除 ${escapeHtml(value)}" aria-label="移除 ${escapeHtml(value)}">×</button></span>`).join("");
  });
}

export function commitListEditor(editor) {
  const source = $(editor.dataset.listEditorFor);
  const input = editor.querySelector("input:not([type=hidden])");
  const additions = splitList(input.value);
  if (!additions.length) return;
  if (editor.dataset.numeric === "true" && additions.some((value) => !/^\d{5,12}$/.test(value))) {
    toast("QQ 或群号只能填写 5 到 12 位数字。", "error");
    input.focus();
    return;
  }
  source.value = [...new Set([...splitList(source.value), ...additions])].join("\n");
  input.value = "";
  renderListEditors();
  updateConfigDirty();
}

export function removeListEditorValue(editor, value) {
  const source = $(editor.dataset.listEditorFor);
  source.value = splitList(source.value).filter((item) => item !== value).join("\n");
  renderListEditors();
  updateConfigDirty();
}

export function moduleLabel(name) {
  return ({
    commands: "命令中心",
    cognition: "短期上下文",
    groupSummary: "每日群报",
    conversationSummary: "成员聊天总结",
    jm: "JM 下载",
    linkPreview: "链接预览",
    imageContext: "图片语境",
    memeKnowledge: "梗库理解",
    stickers: "收藏表情",
    memory: "用户画像",
    relationship: "互动熟悉度",
    resourceTransfer: "资源转发",
    apiProviders: "模型路由",
    outputSafety: "输出安全",
    wordcloud: "群词云",
  })[name] || name;
}

export function moduleStatusLabel(name, module) {
  const label = moduleLabel(name);
  if (module?.health === "degraded") return `${label}（需处理）`;
  return label;
}

export function modelLabel(name) {
  return ({ mimo: "MiMo", deepseek: "DeepSeek V4 Flash", doubao: "豆包视觉", tavily: "联网搜索" })[name] || name;
}
