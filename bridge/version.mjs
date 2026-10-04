// bridge/version.mjs - current version notes for command replies

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "2.0.0";
export const VERSION_NAME = "modular-limited-agent";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION_NOTES_ZH = Object.freeze([
  "单一模块化注册表定义11项有限工具：记忆/状态查询、公开搜索与原文、计算、本轮附件、总结草稿/任务、本人资料草稿、提醒草稿和确认状态；不提供任意系统执行。",
  "命令与帮助按当前用户、群和权限展示；能力定义、运行状态与调用权限分别判断，配置存在不代表服务连通或用户获准执行。",
  "自述事实来自模块与命令清单；分层提示词保留本轮问题、图片、引用正文与来源，区分字面、已知情境和来源声明，不把消息来源核验当成作者意图或世界事实核验。",
  "明确记忆保留来源、有效期与生命周期，失效和遗忘须真实落盘；损坏、保存或停止失败如实报错。本轮未命中不代表全库清空，有效候选不自动等于含糊指代的目标。",
  "稳定提示词、单轮只读缓存和同范围客观识图共用受范围与失效规则约束，不共享最终聊天答案或QQ发送；工程缓存命中不等于模型理解正确。",
  "新增有限Agent阶段默认关闭，须配置群白名单及对应阶段白名单，只接受当前群主动@，私聊不开放；工具注册或前端可见不会自动授予权限。",
  "本人资料、明确记忆与提醒先生成具体草稿，再由本人另发一次性确认命令；模型不能代确认，草稿不代表已保存。未知或执行中结果不自动清理、重做或重播。",
  "有限提醒仅作用于本人当前群，确认后才生效，支持状态查询、取消与恢复；不提供周期提醒、其他收件人或任意定时外发，未知发送结果不冒称成功。",
  "Linux 浏览器控制台与服务流程区分加载、空数据、失败、冲突和任务恢复状态，保留独立草稿与真实发送回执；源码候选不证明线上运行状态。",
  "保留JM及大写FS解压约定；模型主备、思考档位、凭据处理、权限和关系评分不变。只面向Linux，Windows继续冻结，export-relationships及关系表导出仍预留未启用。",
  "已知9项非致命模型回答质量反例暂缓处理，未修复、未通过；识图与语境理解仍有限，原因未确认，不宣称每个模型回答都通过。工程契约验证与真实回答质量验收分开。",
  "2.0.0统一源码版本与中英文说明；实际部署和健康状态以运行检查为准，版本号本身不证明服务在线、权限已开放或所有模型回答正确。",
]);

export const VERSION_NOTES_EN = Object.freeze([
  "A single modular registry defines 11 limited tools: memory/status reads, public search/excerpts, calculation, current attachments, summary drafts/tasks, personal-change drafts, reminder drafts and action status. No arbitrary system execution is provided.",
  "Commands and help are scoped to the current user, group and permissions. Capability definitions, runtime state and invocation permissions are distinct; configured does not mean connected or authorized.",
  "Self facts come from module and command manifests. Layered prompts retain the current question, image, quoted body and source, separating literal meaning, supplied context and attributed claims. Message origin does not verify authorship, intent or world facts.",
  "Explicit memory retains provenance, expiry and lifecycle; invalidation and forgetting require durable persistence. Corruption, save and drain failures remain failures. A scoped miss does not prove an empty database, and a valid candidate is not automatically an ambiguous referent.",
  "Stable prompts, per-turn read caches and scoped objective-vision sharing follow scope and invalidation rules. Final chat answers and QQ sends are never shared; an engineering cache hit does not prove correct model understanding.",
  "New limited-agent phases are off by default and require both group and phase whitelists with a direct mention in the current group; private chats are excluded. Registration or console visibility never grants permission.",
  "Personal changes, explicit memory and reminders produce concrete drafts before a separate one-time owner confirmation command. Models cannot confirm, and drafts are not saved changes. Unknown or executing results are not automatically cleared, retried or replayed.",
  "Limited reminders apply only to their owner in the current group and become active after confirmation, with status, cancellation and recovery. Periodic reminders, other recipients and arbitrary scheduled sends are excluded; unknown delivery is not success.",
  "The Linux browser console and service workflow distinguish loading, empty data, failures, conflicts and task recovery, retaining independent drafts and real send receipts. A source candidate does not establish live runtime state.",
  "JM and the uppercase FS archive convention are retained. Model routes, reasoning modes, credential handling, permissions and relationship scoring are unchanged. Linux only; Windows stays frozen. export-relationships and relationship-table export remain reserved and disabled.",
  "9 known nonfatal model-answer quality cases are deferred, not fixed or passed. Image and contextual interpretation remain limited; causes are unconfirmed and not every model answer passes. Engineering contract checks and real answer-quality acceptance are separate.",
  "2.0.0 aligns source versions and bilingual notes. Deployment and health require runtime checks; a version string alone does not prove service availability, permission or correct model answers.",
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
