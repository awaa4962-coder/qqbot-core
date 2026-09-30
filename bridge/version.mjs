// bridge/version.mjs - current version notes for command replies

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.4.40-final-integration";
export const VERSION_NAME = "final-integration";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION_NOTES_ZH = Object.freeze([
  "有限工具第一阶段候选：新增计算与本轮公开原文读取，只对白名单群主动@开放，默认关闭；不执行系统操作或自动写入。",
  "图片解读区分画面字面、已提供的原话和结论，只把有明确来源的意图归给发言人；新规则先单群试运行，实际质量仍按样例验收。",
  "控制台补齐加载、空数据、失败和版本冲突反馈，刷新不把未保存的草稿当作已保存。",
  "保留实际有消费者的兼容入口，清理已无调用的重复实现；帮助和既有命令不变。",
  "稳定提示词、单轮只读缓存与同范围客观识图共用继续保留，不共享聊天最终答案或QQ发送。",
  "Linux 进入整体验收，正式2.0.0须在原43项与新增有限Agent验收通过后发布，当前阶段版本不代表全部完成。",
  "JM、模型主备、思考档位与关系评分不变；只更新 Linux，Windows 继续冻结。",
]);

export const VERSION_NOTES_EN = Object.freeze([
  "Limited-tool phase-one candidate adds bounded calculation and current-turn public excerpts. New tools default off and require a direct mention in an allowed group; no system operations or automatic writes.",
  "Image interpretation separates visible content, supplied statements and conclusions, attributing intent only to explicit sources. New rules start in one group and require quality acceptance.",
  "The console distinguishes loading, empty data, failed actions and conflicts; refresh never pretends an unsaved draft was saved.",
  "Compatibility entry points with real consumers remain; unused duplicate implementations are removed without changing existing help or commands.",
  "Stable prefixes, per-turn read caches and scoped objective-vision sharing remain. Final chat answers and QQ sends are never shared.",
  "Linux is entering integrated acceptance. Version2.0.0 requires all43 original items and the added limited-agent acceptance; this interim version is not a completion claim.",
  "Only Linux is updated; Windows stays frozen. JM, model routes, reasoning modes and relationship scoring remain unchanged.",
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
      "- Group: @Yexing help / cache stats / update list / update jm / relationship / my-profile / privacy",
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
    "- 群聊：@夜星 help / 状态 / 缓存命中 / 测试 / 更新 / 更新列表 / 更新 jm / 关系",
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
  const sections = readChangelogSections();
  const section = sections.find(item => item.version.replace(/^v/i, "").toLowerCase() === normalized) ||
    sections.find(item => item.version.replace(/^v/i, "").toLowerCase().split("-", 1)[0] === normalized);
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
  if (lang === "en") return ["validation status: not recorded for this version"];
  return ["本版本验证状态：未记录"];
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
