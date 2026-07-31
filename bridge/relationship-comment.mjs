// bridge/relationship-comment.mjs - cached MiMo/DeepSeek relationship short comment
import {
  callRelationshipCommentFallback,
  callRelationshipCommentPrimary,
} from "./model-router.mjs";
import { saveUsers } from "./storage.mjs";

const COMMENT_CACHE_MS = 6 * 60 * 60 * 1000;
const COMMENT_CACHE_MESSAGES = 30;
const COMMENT_MAX_CHARS = 120;

export async function getRelationshipShortComment(relation, options = {}) {
  if (!relation) return "";
  const user = options.user || null;
  const groupId = String(options.groupId || "0");
  const now = options.now || Date.now();
  const cache = getCommentCache(user, groupId);
  if (!options.forceRefresh && cache && !shouldRefreshComment(cache, relation, now)) {
    return cache.text || "";
  }

  const prompt = buildRelationshipCommentPrompt(relation);
  const text = await generateRelationshipComment(prompt, options) || buildLocalRelationshipComment(relation);
  const safeText = normalizeRelationshipComment(text) || buildLocalRelationshipComment(relation);
  writeCommentCache(user, groupId, safeText, relation, now, options.source || "auto");
  return safeText;
}

export function buildRelationshipCommentPrompt(relation) {
  return [
    "请用夜星的口吻，基于下面的关系摘要写一段 40-80 字中文短评。",
    "要求：像熟悉这个人的观察，不要像评分报告；禁止恋爱化；禁止说喜欢你、爱你、暧昧；禁止泄露聊天原文；不要输出思考过程。",
    "",
    "关系摘要：",
    "- 关系标签：" + listText(relation.relationshipTags),
    "- 熟悉度：" + relation.familiarity + "/100",
    "- 本群熟悉度：" + Number(relation.groupFamiliarity || 0) + "/100",
    "- 最近热度：" + (relation.recentHeat || "普通"),
    "- 常聊主题：" + listText(relation.topics),
    "- 回复偏好：" + (relation.replyStyle || relation.preferredTone || "normal"),
    "- 本群互动风格：" + (relation.groupInteractionStyle || "normal"),
    "- 置信度：" + Number(relation.confidence || 0).toFixed(2),
  ].join("\n");
}

export function buildLocalRelationshipComment(relation) {
  const tags = listText(relation.relationshipTags);
  const topics = listText(relation.topics);
  const style = relation.replyStyle || "先给结论，再补一点细节";
  if (Number(relation.confidence || 0) < 0.2) {
    return "我现在对你的了解还在积累中，但已经能看出一些互动习惯：你常围绕「" + topics + "」发起话题，回复你时" + style + "会更合适。";
  }
  return "我对你的印象更接近「" + tags + "」：最近常聊「" + topics + "」，互动节奏是" + (relation.recentHeat || "普通") + "，回复你时" + style + "会更顺手。";
}

export function normalizeRelationshipComment(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  if (/(恋爱|暧昧|喜欢你|爱你|心动|伴侣|对象)/.test(value)) return "";
  if (/^(思考过程|分析|推理|我的思路)[:：]/.test(value)) return "";
  return value.slice(0, COMMENT_MAX_CHARS);
}

export function shouldRefreshComment(cache, relation, now = Date.now()) {
  if (!cache?.text) return true;
  if (now - Number(cache.generatedAt || 0) >= COMMENT_CACHE_MS) return true;
  if (Number(relation.messageCount || 0) - Number(cache.messageCount || 0) >= COMMENT_CACHE_MESSAGES) return true;
  if (Number(relation.groupMessageCount || 0) - Number(cache.groupMessageCount || 0) >= COMMENT_CACHE_MESSAGES) return true;
  return false;
}

async function generateRelationshipComment(prompt, options) {
  const mimo = await callMiMoRelationshipComment(prompt, options);
  if (mimo) return mimo;
  return await callDeepSeekRelationshipComment(prompt, options);
}

async function callMiMoRelationshipComment(prompt, options) {
  const call = options.callMiMo || defaultMiMoCall;
  try {
    const raw = await call(prompt);
    return normalizeRelationshipComment(raw);
  } catch {
    return "";
  }
}

async function callDeepSeekRelationshipComment(prompt, options) {
  const call = options.callDeepSeek || defaultDeepSeekCall;
  try {
    const raw = await call(prompt);
    return normalizeRelationshipComment(raw);
  } catch {
    return "";
  }
}

async function defaultMiMoCall(prompt) {
  return await callRelationshipCommentPrimary(prompt);
}

async function defaultDeepSeekCall(prompt) {
  return await callRelationshipCommentFallback(prompt);
}

function getCommentCache(user, groupId) {
  return user?.relationshipComments?.[String(groupId)] || null;
}

function writeCommentCache(user, groupId, text, relation, now, source) {
  if (!user || !text) return;
  if (!user.relationshipComments) user.relationshipComments = {};
  user.relationshipComments[String(groupId)] = {
    text,
    generatedAt: now,
    messageCount: Number(relation.messageCount || 0),
    groupMessageCount: Number(relation.groupMessageCount || 0),
    source,
  };
  saveUsers();
}

function listText(values) {
  if (!Array.isArray(values) || !values.length) return "还在积累";
  return values.slice(0, 4).join("、");
}
