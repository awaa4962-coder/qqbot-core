// bridge/relationship-commands.mjs — relationship command entrypoints
import {
  RESERVED_RELATIONSHIP_COMMANDS,
  RESERVED_RELATIONSHIP_EXPORT_COMMANDS,
  explainRelationshipAlias,
  getRelationshipLevel,
} from "./relationship.mjs";

export { RESERVED_RELATIONSHIP_COMMANDS, RESERVED_RELATIONSHIP_EXPORT_COMMANDS };

export function isRelationshipCommand(text) {
  return RESERVED_RELATIONSHIP_COMMANDS.includes(String(text || "").trim());
}

export function isRelationshipExportCommand(text) {
  return RESERVED_RELATIONSHIP_EXPORT_COMMANDS.includes(String(text || "").trim());
}

export function parseRelationshipExportCommand(text) {
  const value = String(text || "").trim();
  if (!isRelationshipExportCommand(value)) return null;
  const [, format = "csv"] = value.split(/\s+/);
  return {
    enabled: false,
    format: format === "/export-relationships" ? "csv" : format,
    adminOnly: true,
    includeEvidenceText: false,
    crossGroup: false,
  };
}

/**
 * 构建关系摘要（v1.2.1 接入真实计算）
 * @param {Object|null} relation - computeRelationship 返回的关系画像
 * @param {string} originalText - 原始命令文本
 * @param {Object} [options]
 * @param {string[]} [options.nicknames] - 用户昵称列表
 * @returns {string}
 */
export function buildRelationshipSummary(relation, originalText = "", options = {}) {
  const aliasNote = explainRelationshipAlias(originalText);
  if (!relation) {
    return buildLowDataRelationshipText(options, aliasNote);
  }

  const view = buildRelationshipView(relation, options, aliasNote);

  return [
    buildRelationshipTitle(options),
    "",
    "关系标签：" + view.tags,
    "熟悉度：" + relation.familiarity + "/100（" + view.level.cn + "）",
    "本群熟悉度：" + Number(relation.groupFamiliarity || 0) + "/100",
    "最近热度：" + (relation.recentHeat || "普通"),
    "互动亲近度：" + relation.affinity + "/100",
    "稳定互动分：" + relation.trustScore + "/100",
    "玩笑容忍度：" + (relation.humorTolerance <= 30 ? "低" : relation.humorTolerance <= 45 ? "中等" : "较高"),
    "",
    "我对你的印象：",
    relation.impression || "互动记录还在积累，我还在慢慢认识你。",
    "常聊：" + view.topics,
    "适合回复方式：" + (relation.replyStyle || relation.preferredTone),
    "本群互动风格：" + formatInteractionStyle(relation.groupInteractionStyle),
    view.aliasLine,
    "互动证据：最近记录 " + relation.messageCount + " 条，活跃 " + relation.activeDays + " 天",
    "本群证据：" + Number(relation.groupMessageCount || 0) + " 条，活跃 " + Number(relation.groupActiveDays || 0) + " 天",
    "置信度：" + relation.confidence.toFixed(2),
  ].filter(Boolean).join("\n") + view.commentLine + view.lowDataNote + view.suffix;
}

function buildRelationshipTitle(options) {
  const name = safeSubjectName(options.subjectName);
  return name ? "我和 " + name + " 的互动状态：" : "你和我的互动状态：";
}

function buildLowDataRelationshipText(options, aliasNote) {
  const name = safeSubjectName(options.subjectName);
  const prefix = name ? "我和 " + name + " 的互动记录还不够，暂时算不出关系状态。" : "互动记录还不够，暂时算不出关系状态。";
  return prefix + (aliasNote ? aliasNote : "");
}

function safeSubjectName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function buildRelationshipView(relation, options, aliasNote) {
  const level = getRelationshipLevel(relation.familiarity);
  return {
    level,
    tags: formatTags(relation.relationshipTags, level.cn),
    topics: formatTopics(relation.topics),
    aliasLine: formatAliasLine(options.nicknames),
    commentLine: formatCommentLine(options.shortComment),
    lowDataNote: relation.confidence < 0.20 ? "\n\n我现在掌握的互动记录还不多，所以这个结果可能不太准确。" : "",
    suffix: aliasNote ? "\n\n" + aliasNote : "",
  };
}

function formatTags(tags, fallback) {
  return Array.isArray(tags) && tags.length ? tags.join(" / ") : fallback;
}

function formatTopics(topics) {
  return Array.isArray(topics) && topics.length ? topics.join("、") : "还在积累";
}

function formatAliasLine(nicknames) {
  const values = Array.isArray(nicknames) ? nicknames : [];
  return values.length ? "\n我记得的称呼：" + values.slice(0, 8).join("、") : "";
}

function formatCommentLine(shortComment) {
  const value = String(shortComment || "").trim();
  return value ? "\n\n夜星短评：\n" + value : "";
}

function formatInteractionStyle(style) {
  if (style === "technical") return "偏技术讨论";
  if (style === "playful") return "偏轻松整活";
  if (style === "quiet") return "偏安静，少插话更好";
  if (style === "serious") return "偏认真";
  if (style === "gentle") return "适合温和一点";
  return "正常";
}
