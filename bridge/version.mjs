// bridge/version.mjs - current version notes for command replies

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.4.49-image-task";
export const VERSION_NAME = "image-task";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION_NOTES_ZH = Object.freeze([
  "图文候选由后端真实图片输入选择聚焦任务提示，保留人设与安全边界；普通文字、私聊及自动插话保持原提示，实际回答质量另验。",
  "图片上传者和引用说话人分别标明消息角色，消息来源核验不代表图片作者、心理意图或世界事实已核验；不改变来源权限或原话。",
  "图文候选将本轮已保留的引用原话和说话人来源一起呈现，不从伪标签、被剪掉的历史或其他层补来源；仍以实际语义验收为准。",
  "确认账本只回收保留满7天的确定终态，未知结果与执行中记录不自动清理或重做；旧确认编号不能重新执行。",
  "模型传输增加白名单状态码和失败阶段/类别，不记录原始异常、正文、凭据或思考内容；不改变重试、超时、主备或权限。",
  "图片解读候选结合本轮问题和已提供原话解释字面与语境，不把上传者当成引用者或原图作者；意图只转述明确的来源声明，实际质量仍须验收。",
  "普通聊天不自动附带记忆或功能命令；本轮称呼可以使用，准备草稿不代表已保存，正式个人变更仍需本人另行确认。",
  "统一包、锁文件和运行版本，修复先前包版本为1.4.46而启动及版本命令仍显示1.4.44的问题；Linux候选不代表正式2.0.0已发布。",
  "本人偏好/明确记忆草稿、一次性确认及提醒恢复工程已验收，新增工具默认关闭；保留JM、既有权限与模型预算。",
  "控制台表情编辑保留独立草稿并校验原值，完整响应须匹配本次提交；日志失败不会被筛选隐藏，手机导航与操作反馈避免遮挡。",
  "表情保存失败关闭目录读写，删除响应不暴露发送凭据或发送者摘要；JM、模型及工具预算不变，正式2.0.0仍待整体验收。",
  "图片v5候选把本轮提问与图片放在同一条输入，标明消息发送人及原消息编号；历史原话和工具协议保持完整，真实解读质量仍待验收。",
  "图片候选只约束图相关解读，不限制普通方案长度；解释字面与语境关系，不固定追加动机免责声明，反话不等于祝贺或安慰。",
  "原生工具探测区分自答、无调用、结构错误、参数不符和截断；保留旧额度与真实结果，不为澄清提示词重置探测机会。",
  "管理员可明确验证当前主备原生工具往返，最多4次合成模型请求；模拟证据与真实证据分开，不在每次聊天中付费探测。",
  "工具验证区分部分通过、失败和未确认；后台任务刷新恢复状态，重新认证不会自动重发付费或写入请求。",
  "损坏记忆不再当作空库覆盖，保存或停止失败如实报错；发送接口报告真实回执，长文本不会切断Unicode字符。",
  "有限工具第一阶段候选：新增计算与本轮公开原文读取，只对白名单群主动@开放，默认关闭；不执行系统操作或自动写入。",
  "图片解读区分画面字面、已提供的原话和结论，只把有明确来源的意图归给发言人；新规则先单群试运行，实际质量仍按样例验收。",
  "控制台补齐加载、空数据、失败和版本冲突反馈，刷新不把未保存的草稿当作已保存。",
  "保留实际有消费者的兼容入口，清理已无调用的重复实现；帮助和既有命令不变。",
  "稳定提示词、单轮只读缓存与同范围客观识图共用继续保留，不共享聊天最终答案或QQ发送。",
  "Linux 进入整体验收，正式2.0.0须在原43项与新增有限Agent验收通过后发布，当前阶段版本不代表全部完成。",
  "JM、模型主备、思考档位与关系评分不变；只更新 Linux，Windows 继续冻结。",
]);

export const VERSION_NOTES_EN = Object.freeze([
  "Candidate group image inputs select a focused task prompt from backend image evidence, retaining persona and safety. Plain text, private and passive prompts are unchanged; actual quality needs separate acceptance.",
  "Image uploaders and quoted speakers carry distinct message roles. Verified message origin does not verify image authorship, intention or world facts; source permissions and original statements remain unchanged.",
  "Candidate image input presents only actually retained quoted statements and their speakers; text labels, pruned history and unrelated layers cannot supply sources. Semantic acceptance is still required.",
  "The confirmation journal reclaims only definite terminal results retained for seven days. Unknown and executing records are not cleared or retried; old confirmation IDs cannot execute again.",
  "Provider transport adds allowlisted status and failure-stage/category metadata without raw errors, content, credentials or reasoning, and without changing retries, deadlines, routes or permissions.",
  "Candidate image interpretation follows the current question and supplied statements. Uploaders, quoted speakers and original authors remain distinct; intent is attributed only to an explicit source claim. Semantic acceptance is still required.",
  "Ordinary replies do not append unsolicited memory or feature commands. Current names may be used; drafts are not saved changes, and personal changes still require separate owner confirmation.",
  "Package, lockfile and runtime versions now agree. The prior package said1.4.46 while startup and version commands still said1.4.44. This Linux candidate is not the final2.0.0 release.",
  "Owned personal-change drafts, one-time confirmation and reminder recovery passed engineering acceptance. New tools remain off by default; JM, permissions and shared model budgets are preserved.",
  "The console preserves independent sticker drafts and checks original values. Confirmations match the submitted edit; log filters retain failure notices, and mobile navigation and feedback avoid overlap.",
  "Failed catalog persistence disables authoritative reads and writes. Removal responses hide send credentials and sender hashes; JM, models and tool limits remain unchanged. Version2.0.0 is not yet released.",
  "The image-v5 candidate keeps the current question beside its image and identifies the message sender and source ID. History and tool transcripts remain intact; semantic acceptance is still pending.",
  "Candidate image rules apply only to image interpretation, not ordinary plan length. Literal/context relations do not imply congratulations or comfort, and no fixed motive disclaimer is required.",
  "Native diagnostics distinguish direct answers, absent calls, malformed structures, wrong arguments and truncation. Prompt clarification never resets quota or reclassifies an unknown old response.",
  "Explicit admin diagnostics test both configured native-tool slots with at most four synthetic requests. QA and live proof are separate; ordinary chats never trigger paid probes.",
  "Tool verification distinguishes partial, failed and unknown outcomes. Task recovery preserves uncertainty, and renewed authentication never automatically replays a write or paid action.",
  "Corrupt memory is never replaced by empty state. Save and drain failures remain failures; reply receipts are accurate and long-text splitting preserves Unicode characters.",
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
