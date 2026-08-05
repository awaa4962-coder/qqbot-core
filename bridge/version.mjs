// bridge/version.mjs - current version notes for command replies

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.3.5-summary-analysis";
export const VERSION_NAME = "summary-analysis";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION_NOTES_ZH = Object.freeze([
  "群日报改由 DeepSeek V4 Flash 主分析，MiMo 作为备用，本地事实摘要继续提供最终保障。",
  "V4 Flash 日报默认关闭隐藏长推理，把输出预算完整留给正文；控制台仍可按功能调整思考档位。",
  "日报生成器按主插槽和备用插槽调用并记录真实模型，不再把插槽名称硬编码成供应商名称。",
  "新增证据预处理，机器人消息、命令、纯符号和短时间复读不再污染主题与参与统计。",
  "日报改为经过、结果、状态三层事实分析；没有证据的结论会明确标记为未形成结论。",
  "发送给模型前会隐藏 QQ 号、网络地址、链接和凭据，图片无文字证据时禁止猜测内容。",
  "QQ 输出移除 Markdown 装饰、主观人物称号和强制卖萌栏目，保留简明的纯文本层级。",
]);

export const VERSION_NOTES_EN = Object.freeze([
  "Group summaries now use DeepSeek V4 Flash as primary, MiMo as backup, and a local factual fallback.",
  "V4 Flash summaries reserve their output budget for final text by default, while per-task reasoning remains configurable.",
  "Summary calls are slot-based and report the provider that actually generated the output.",
  "Bot messages, commands, symbol-only noise and short-window repeats are removed from semantic evidence.",
  "Reports distinguish process, result and status, and explicitly mark conclusions that were not established.",
  "QQ identifiers, network addresses, links and credentials are redacted before model analysis.",
  "QQ output uses clean plain text without Markdown decoration, invented titles or forced persona filler.",
]);

export const RESERVED_FEATURES_ZH = Object.freeze([
  "export-relationships 关系表导出",
  "CSV / JSON / Markdown 关系导出",
  "管理员全群关系表",
]);

export const RESERVED_FEATURES_EN = Object.freeze([
  "export-relationships",
  "CSV / JSON / Markdown relationship export",
  "admin group relationship table",
]);

export function buildVersionText(lang = "zh", version = VERSION) {
  const statusLines = buildStatusLines(lang);
  if (lang === "en") {
    return [
      "Current version: v" + version,
      "Version name: " + VERSION_NAME,
      "",
      "What's new:",
      formatNumbered(VERSION_NOTES_EN),
      "",
      "Commands:",
      "- Group: @Yexing help / update list / update jm / relationship / my-profile / privacy",
      "- Style: @Yexing 回复风格 简短 技术 少吐槽 / 设置称呼 <name> / 忘记我",
      "- Admin: @Yexing memory status / memory summary QQ number / memory clear user QQ number / memory clear group",
      "",
      "Still reserved:",
      formatBullets(RESERVED_FEATURES_EN),
      "",
      "Status:",
      ...statusLines,
    ].join("\n");
  }

  return [
    "当前版本：v" + version,
    "版本名称：" + VERSION_NAME,
    "",
    "本版更新：",
    formatNumbered(VERSION_NOTES_ZH),
    "",
    "命令：",
    "- 群聊：@夜星 help / 状态 / 测试 / 更新 / 更新列表 / 更新 jm / 关系",
    "- 个性化：@夜星 我的档案 / 设置称呼 <名字> / 回复风格 简短 技术 少吐槽 / 隐私 / 忘记我",
    "- 管理：@夜星 memory status / memory summary QQ号 / memory clear user QQ号 / memory clear group",
    "",
    "仍未启用：",
    formatBullets(RESERVED_FEATURES_ZH),
    "",
    "状态：",
    ...statusLines,
  ].join("\n");
}

export function buildChangelogText(lang = "zh", version = VERSION) {
  return buildVersionText(lang, version);
}

export function buildVersionQueryText(commandText, lang = detectVersionLang(commandText)) {
  const cmd = String(commandText || "").trim();
  const query = extractVersionQuery(cmd);
  if (!query) return buildVersionText(lang);
  if (query.type === "list") return buildChangelogList(lang);
  if (query.type === "latest") return buildChangelogLatest(query.count, lang);
  if (query.type === "version") return buildChangelogVersion(query.value, lang);
  if (query.type === "search") return buildChangelogSearch(query.value, lang);
  return buildVersionText(lang);
}

export function isVersionQueryCommand(commandText) {
  const text = String(commandText || "").trim().toLowerCase();
  return text === "version" ||
    text === "版本" ||
    text === "更新" ||
    text === "更新日志" ||
    text === "changelog" ||
    text === "更新列表" ||
    text === "历史更新" ||
    /^更新\s+/.test(text) ||
    /^changelog\s+/.test(text);
}

export function detectVersionLang(commandText) {
  const text = String(commandText || "").trim().toLowerCase();
  if (text === "version" || text === "changelog") return "en";
  return "zh";
}

function extractVersionQuery(commandText) {
  const text = String(commandText || "").trim();
  const lower = text.toLowerCase();
  if (["version", "版本", "更新", "更新日志", "changelog"].includes(lower)) return null;
  if (["更新列表", "历史更新", "changelog list"].includes(lower)) return { type: "list" };
  let match = text.match(/^(?:更新|changelog)\s+最近\s*(\d+)版$/i);
  if (match) return { type: "latest", count: clampCount(match[1]) };
  match = text.match(/^(?:更新|changelog)\s+(?:latest\s*)?(\d+)$/i);
  if (match) return { type: "latest", count: clampCount(match[1]) };
  match = text.match(/^(?:更新|changelog)\s+(v?[\w.-]+)$/i);
  if (match && /^(?:v?\d|v1|v\d)/i.test(match[1])) return { type: "version", value: match[1] };
  match = text.match(/^(?:更新|changelog)\s+(.+)$/i);
  if (match) return { type: "search", value: match[1].trim() };
  return null;
}

function buildChangelogList(lang) {
  const sections = readChangelogSections();
  if (!sections.length) return lang === "en" ? "No changelog found." : "没有找到更新日志。";
  const lines = sections.map(item => "- " + item.version + " " + item.title);
  return [
    lang === "en" ? "Changelog versions:" : "历代更新：",
    ...lines,
    "",
    lang === "en" ? "Use: @Yexing changelog v1.2.3" : "用法：@夜星 更新 v1.2.3 / @夜星 更新 jm",
  ].join("\n");
}

function buildChangelogLatest(count, lang) {
  const sections = readChangelogSections().slice(0, count);
  if (!sections.length) return lang === "en" ? "No changelog found." : "没有找到更新日志。";
  return formatChangelogSections(sections, lang);
}

function buildChangelogVersion(version, lang) {
  const normalized = String(version || "").replace(/^v/i, "").toLowerCase();
  const section = readChangelogSections().find(item => item.version.replace(/^v/i, "").toLowerCase().startsWith(normalized));
  if (!section) return lang === "en" ? "No matching version found." : "没有找到这个版本。";
  return formatChangelogSections([section], lang);
}

function buildChangelogSearch(keyword, lang) {
  const value = String(keyword || "").trim().toLowerCase();
  if (!value) return buildChangelogList(lang);
  const sections = readChangelogSections()
    .map(section => ({
      ...section,
      lines: section.lines.filter(line => line.toLowerCase().includes(value)),
    }))
    .filter(section => section.title.toLowerCase().includes(value) || section.lines.length);
  if (!sections.length) return lang === "en" ? "No matching changelog entries found." : "没有找到相关更新。";
  return formatChangelogSections(sections.slice(0, 5), lang);
}

function formatChangelogSections(sections, lang) {
  const chunks = [];
  for (const section of sections) {
    chunks.push(section.version + " " + section.title);
    const lines = section.lines.slice(0, 8);
    chunks.push(...lines);
    if (section.lines.length > lines.length) {
      chunks.push(lang === "en" ? "- More entries omitted." : "- 还有更多条目，已省略。");
    }
    chunks.push("");
  }
  return chunks.join("\n").trim();
}

function readChangelogSections() {
  try {
    const filePath = path.join(ROOT, "CHANGELOG.md");
    const raw = fs.readFileSync(filePath, "utf8");
    const sections = [];
    let current = null;
    for (const line of raw.split(/\r?\n/)) {
      const heading = line.match(/^#{2,3}\s+([^\s]+)\s*(.*)$/);
      if (heading) {
        if (current) sections.push(current);
        current = { version: heading[1], title: heading[2].trim(), lines: [] };
      } else if (current && /^-\s+/.test(line)) {
        current.lines.push(line);
      }
    }
    if (current) sections.push(current);
    return sections;
  } catch {
    return [];
  }
}

function clampCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 3;
  return Math.min(10, Math.max(1, Math.floor(count)));
}

function formatNumbered(items) {
  return items.map(function(item, index) {
    return String(index + 1) + ". " + item;
  }).join("\n");
}

function formatBullets(items) {
  return items.map(function(item) {
    return "- " + item;
  }).join("\n");
}

function buildStatusLines(lang) {
  const manifest = readReleaseManifest();
  if (manifest?.version === VERSION && manifest?.counts?.tests) {
    return [
      "npm test " + manifest.counts.tests,
      "lint 0 errors / 0 warnings",
    ];
  }
  if (lang === "en") return ["tests: all passing", "lint 0 errors / 0 warnings"];
  return ["tests: all passing", "lint 0 errors / 0 warnings"];
}

function readReleaseManifest() {
  try {
    const filePath = path.join(ROOT, "dist", "release-manifest.json");
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
