import { $, escapeHtml } from "../ui/dom.js";
import { uiState } from "../ui/state.js";

export const RETIRED_MEME_ACTIONS = new Set([
  "newMeme", "addMemeSource", "saveMeme", "enableMeme", "disableMeme", "activateMeme",
  "quarantineMeme", "setMemeMode", "deleteMeme", "runMemeWebUpdate", "researchMemeWeb",
  "rollbackMemeWebUpdate", "restoreMemeHistory",
]);

export function renderMemes(snapshot) {
  uiState.memeSnapshot = snapshot || { entries: [] };
  uiState.memesLoaded = true;
  $("memeStatus").textContent = snapshot?.readError
    ? "归档暂不可读，原文件未修改。"
    : snapshot?.available ? `只读归档 · ${snapshot.count} 条` : "没有旧词条归档。";
  if (snapshot?.truncated) $("memeStatus").textContent += " · 当前只展示部分词条";
  filterMemeArchive();
}

export function filterMemeArchive() {
  const query = String($("memeArchiveSearch").value || "").trim().toLowerCase();
  const entries = uiState.memeSnapshot.entries || [];
  const selected = $("memeSelect").value;
  const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    [entry.name, entry.meaning, entry.usage, ...(entry.aliases || [])].join(" ").toLowerCase().includes(query));
  $("memeSelect").innerHTML = matches.map(({ entry, index }) =>
    `<option value="${index}">${escapeHtml(entry.name || "未命名词条")}</option>`).join("");
  $("memeSelect").value = matches.some(item => String(item.index) === selected) ? selected : String(matches[0]?.index ?? "");
  showMemeArchiveEntry();
}

export function showMemeArchiveEntry() {
  const index = $("memeSelect").value;
  const entry = index === "" ? null : uiState.memeSnapshot.entries?.[Number(index)];
  $("memeArchiveDetail").innerHTML = entry ? [
    `<h3>${escapeHtml(entry.name)}</h3>`,
    `<p>${entry.manualProtected ? "人工记录" : "历史记录"} · 来源 ${Number(entry.sourceCount || 0)}</p>`,
    "<dl>",
    `<dt>旧释义</dt><dd>${escapeHtml(entry.meaning || "无")}</dd>`,
    `<dt>旧用法</dt><dd>${escapeHtml(entry.usage || "无")}</dd>`,
    `<dt>别名</dt><dd>${escapeHtml((entry.aliases || []).join("、") || "无")}</dd>`,
    `<dt>例句</dt><dd>${escapeHtml((entry.examples || []).join("\n") || "无")}</dd>`,
    "</dl>",
  ].join("") : '<p class="empty-state">没有匹配的旧词条</p>';
}
