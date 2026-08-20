// bridge/relationship.mjs — v1.2.1 relationship computation + schema

import { wallAgeMs } from "./runtime-clock.mjs";

export const RELATIONSHIP_SCORE_FIELDS = Object.freeze([
  "familiarity",
  "affinity",
  "trustScore",
  "humorTolerance",
  "interactionScore",
  "styleMatch",
]);

export const RELATIONSHIP_EXPORT_FIELDS = Object.freeze([
  "user_id",
  "display_name",
  "nickname",
  "aliases",
  "group_id",
  "group_name",
  "familiarity",
  "affinity",
  "trustScore",
  "humorTolerance",
  "preferredTone",
  "knownMemesCount",
  "knownMemes",
  "avoidTopicsCount",
  "lastActiveAt",
  "firstSeenAt",
  "messageCount",
  "mentionCount",
  "replyCount",
  "positiveInteractionCount",
  "conflictCount",
  "technicalQuestionCount",
  "jokingInteractionCount",
  "confidence",
  "updatedAt",
  "evidenceCount",
  "notes",
]);

export const RESERVED_RELATIONSHIP_COMMANDS = Object.freeze([
  "关系",
  "好感度",
  "熟悉度",
  "my-status",
  "/关系",
  "/好感度",
  "/熟悉度",
  "/my-status",
]);

export const RESERVED_RELATIONSHIP_EXPORT_COMMANDS = Object.freeze([
  "export-relationships",
  "export-relationships csv",
  "export-relationships json",
  "export-relationships md",
  "/export-relationships",
  "/export-relationships csv",
  "/export-relationships json",
  "/export-relationships md",
]);

export function createDefaultRelationship() {
  return {
    familiarity: 0,
    affinity: 0,
    trustScore: 0,
    humorTolerance: 0,
    interactionScore: 0,
    styleMatch: 0,
    preferredTone: "normal",
    confidence: 0,
  };
}

export function createDefaultRelationshipExports() {
  return {
    relationshipRowsAvailable: false,
  };
}

export function normalizeRelationship(input = {}) {
  const base = createDefaultRelationship();
  return {
    ...base,
    ...pickKnownRelationshipFields(input),
    familiarity: clampScore(input.familiarity ?? base.familiarity),
    affinity: clampScore(input.affinity ?? base.affinity),
    trustScore: clampScore(input.trustScore ?? base.trustScore),
    humorTolerance: clampScore(input.humorTolerance ?? base.humorTolerance),
    interactionScore: clampScore(input.interactionScore ?? base.interactionScore),
    styleMatch: clampScore(input.styleMatch ?? base.styleMatch),
    confidence: clampConfidence(input.confidence ?? base.confidence),
  };
}

export function explainRelationshipAlias(text) {
  if (!String(text || "").trim()) return "";
  return "这里的‘好感度’指互动熟悉度，不是恋爱含义。";
}

function pickKnownRelationshipFields(input) {
  return {
    preferredTone: normalizeTone(input.preferredTone),
  };
}

function normalizeTone(tone) {
  const value = String(tone || "normal").trim();
  if (["normal", "concise", "playful", "serious", "technical"].includes(value)) return value;
  return "normal";
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ── v1.2.1 关系计算 ──

const MAX_FAMILIARITY_MSG = 45;
const MAX_FAMILIARITY_DAYS = 25;
const MAX_FAMILIARITY_AGE = 15;
const MAX_FAMILIARITY_NICK = 10;
const RECENT_BONUS = 5;

const TECH_KEYWORDS = ['代码','npm','node','error','bug','报错','修复','测试','模型','API','文件','路径','模块','import','config','函数','promise','async','lint','eslint','http','token','key','数据库','sql','json','server','port','路由','render','docker','git','commit','push','branch','merge','pr','ci','cdn','dns','ssl','tls','proxy','runtime','fetch','axios','request','response','header','body','payload','签名','加密','解码','编译','打包','构建','部署','发布'];

const JOKE_KEYWORDS = ['哈哈','哈哈哈','草','笑死','乐','绷','6','太草了','笑不活了','笑死我了','抽象','乐死','草生','搞笑','整活','烂活','好活','顶级理解'];

/**
 * 从用户数据计算关系画像
 * @param {Object} user - users[uid]
 * @param {Object} options
 * @param {string|number} options.currentGroupId
 * @param {Array} [options.currentGroupChats]
 * @param {number} [options.now]
 * @returns {Object} 关系画像
 */
export function computeRelationship(user, options = {}) {
  const now = options.now || Date.now();
  const userObj = user || {};
  const chats = Array.isArray(userObj.chats) ? userObj.chats : [];
  const nicknames = Array.isArray(userObj.nicknames) ? userObj.nicknames : [];
  const memoryContext = options.memoryContext || {};
  const firstSeen = parseFirstSeen(userObj.firstSeen);
  const msgCount = chats.length;

  // 活跃天数
  const activeDays = countActiveDays(chats);

  // 首次见面距今天数
  const daysSinceFirstSeen = calculateDaysSinceFirstSeen(firstSeen, now);

  // 昵称数
  const nicknameCount = nicknames.length;

  // 最近 7 天有发言
  const recentActivity = hasRecentActivity(chats, now);

  // 技术词 / 玩笑词 统计
  const textStats = analyzeRelationshipText(chats);
  const { techScore, jokeScore, totalTextLen, textCount } = textStats;

  // 在群内聊天数
  const gid = String(options.currentGroupId || '');
  const groupChats = gid ? chats.filter(c => String(c.group) === gid) : [];
  const groupChatCount = groupChats.length;
  const groupActiveDays = countActiveDays(groupChats);

  // ── familiarity 熟悉度 ──
  const msgScore = Math.min(msgCount * 1.2, MAX_FAMILIARITY_MSG);
  const activeDayScore = Math.min(activeDays * 4, MAX_FAMILIARITY_DAYS);
  const ageScore = Math.min(daysSinceFirstSeen * 0.3, MAX_FAMILIARITY_AGE);
  const nicknameScore = Math.min(nicknameCount * 3, MAX_FAMILIARITY_NICK);
  const familiarity = clampScore(msgScore + activeDayScore + ageScore + nicknameScore + (recentActivity ? RECENT_BONUS : 0));

  // ── interactionScore 互动分 ──
  const interactionScore = clampScore(Math.min(msgCount * 1.5, 60) + (recentActivity ? 15 : 0) + Math.min(nicknameCount * 4, 12) + Math.min(groupChatCount * 1.2, 13));

  // ── affinity 互动亲近度 ──
  const mentionEstimate = Math.min(nicknameCount * 5 + groupChatCount * 0.5, 40);
  const affinity = clampScore(interactionScore * 0.6 + mentionEstimate * 0.4);

  // ── trustScore 稳定互动分 ──
  const trustScore = clampScore(Math.min((msgCount / 200) * 40, 40) + Math.min((activeDays / 30) * 40, 40) + Math.min((chats.filter(c => c.ts && c.ts < now - 30 * 86400000).length / 5) * 20, 20));

  // ── humorTolerance 玩笑容忍度 ──
  const humorTolerance = calculateHumorTolerance(jokeScore, msgCount);

  // ── preferredTone 偏好语气 ──
  const avgTextLen = textCount > 0 ? totalTextLen / textCount : 0;
  const preferredTone = choosePreferredTone({ techScore, jokeScore, avgTextLen, textCount });

  // ── styleMatch ──
  const styleMatch = clampScore(50 + (techScore * 2) + (jokeScore * 1.5) + (activeDays * 0.5));

  const groupFamiliarity = calculateGroupFamiliarity(groupChats, {
    groupActiveDays,
    now,
    nicknameCount,
  });
  const recentHeat = classifyRecentHeat(chats, now);
  const topics = collectRelationshipTopics(memoryContext, textStats);
  const replyStyle = chooseReplyStyle(memoryContext, preferredTone);
  const groupInteractionStyle = chooseGroupInteractionStyle(memoryContext);
  const relationshipTags = buildRelationshipTags({
    familiarity,
    groupFamiliarity,
    preferredTone,
    groupInteractionStyle,
    techScore,
    jokeScore,
  });
  const profileConfidence = calculateProfileConfidence(memoryContext);

  // ── evidenceCount ──
  const evidenceCount = msgCount + nicknameCount + activeDays + groupChatCount;

  // ── confidence ──
  const confidence = Math.min((msgCount / 200) * 0.75 + profileConfidence * 0.25, 0.95);

  // ── lastActiveAt ──
  const lastActiveAt = getLastActiveAt(chats);

  return {
    familiarity: Math.round(familiarity),
    affinity: Math.round(affinity),
    trustScore: Math.round(trustScore),
    humorTolerance: Math.round(humorTolerance),
    interactionScore: Math.round(interactionScore),
    styleMatch: Math.round(styleMatch),
    preferredTone,
    groupFamiliarity: Math.round(groupFamiliarity),
    groupMessageCount: groupChatCount,
    groupActiveDays,
    recentHeat,
    topics,
    replyStyle,
    groupInteractionStyle,
    relationshipTags,
    impression: buildLocalImpression({
      topics,
      replyStyle,
      relationshipTags,
      preferredTone,
      groupInteractionStyle,
      confidence,
    }),
    confidence: Math.round(confidence * 100) / 100,
    messageCount: msgCount,
    activeDays,
    firstSeenAt: firstSeen ? new Date(firstSeen).toISOString() : null,
    lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
    evidenceCount,
    notes: '',
  };
}

function calculateGroupFamiliarity(groupChats, options) {
  if (!groupChats.length) return 0;
  const recentActivity = hasRecentActivity(groupChats, options.now);
  return clampScore(
    Math.min(groupChats.length * 1.8, 48) +
    Math.min(options.groupActiveDays * 5, 30) +
    Math.min(options.nicknameCount * 2, 7) +
    (recentActivity ? 8 : 0)
  );
}

function calculateDaysSinceFirstSeen(firstSeen, now) {
  if (!firstSeen) return 0;
  const age = wallAgeMs(firstSeen, now);
  return Number.isFinite(age) ? age / 86400000 : 0;
}

function classifyRecentHeat(chats, now) {
  const dayCount = chats.filter(c => wallAgeMs(c.ts, now) <= 86400000).length;
  const weekCount = chats.filter(c => wallAgeMs(c.ts, now) <= 7 * 86400000).length;
  if (dayCount >= 8 || weekCount >= 30) return "高";
  if (dayCount >= 3 || weekCount >= 12) return "较活跃";
  if (weekCount >= 3) return "普通";
  return "安静";
}

function collectRelationshipTopics(memoryContext, textStats) {
  const topics = [];
  appendList(topics, memoryContext.userProfile?.commonTopics);
  appendList(topics, memoryContext.userGroupProfile?.recentTopics);
  appendList(topics, memoryContext.groupProfile?.activeTopics);
  if (!topics.length && textStats.techScore > 0) topics.push("技术讨论");
  if (!topics.length && textStats.jokeScore > 0) topics.push("玩笑整活");
  return topics.slice(0, 5);
}

function appendList(target, values) {
  for (const value of values || []) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function chooseReplyStyle(memoryContext, preferredTone) {
  const explicitStyle = memoryContext.userProfile?.replyStyle;
  if (explicitStyle && explicitStyle !== "normal") return explicitStyle;
  const tone = memoryContext.userProfile?.preferredTone || preferredTone;
  if (tone === "technical") return "偏技术向，可以给结论也给实现细节";
  if (tone === "playful") return "可以轻松一点，允许适度玩笑";
  if (tone === "gentle") return "适合温和一点，少压迫感";
  if (tone === "concise") return "适合直接短句，少绕弯";
  if (tone === "serious") return "适合认真直说，少整活";
  return "正常交流，先给结论再补充";
}

function chooseGroupInteractionStyle(memoryContext) {
  const style = memoryContext.userGroupProfile?.interactionStyle;
  if (style && style !== "normal") return style;
  const tone = memoryContext.groupProfile?.tone;
  if (tone && tone !== "normal") return tone;
  return "normal";
}

function calculateProfileConfidence(memoryContext) {
  const values = [
    memoryContext.userProfile?.confidence,
    memoryContext.userGroupProfile?.confidence,
  ].map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildRelationshipTags(stats) {
  const tags = [];
  if (stats.preferredTone === "technical" || stats.techScore >= 2 || stats.groupInteractionStyle === "technical") {
    tags.push("技术搭子");
  }
  if (stats.preferredTone === "playful" || stats.jokeScore >= 2 || stats.groupInteractionStyle === "playful") {
    tags.push("整活熟人");
  }
  if (stats.groupFamiliarity >= 55) tags.push("本群常客");
  if (stats.familiarity >= 60) tags.push("熟人");
  else if (stats.familiarity >= 40) tags.push("常见群友");
  if (!tags.length) tags.push("正在熟悉");
  return tags.slice(0, 3);
}

function buildLocalImpression(stats) {
  const topics = stats.topics.length ? "最近常聊「" + stats.topics.join("、") + "」" : "互动记录还在积累";
  const tag = stats.relationshipTags[0] || "正在熟悉";
  const caution = stats.confidence < 0.2 ? "这份判断还比较轻量。" : "这份判断已经有一定参考价值。";
  return "我对你的印象更接近「" + tag + "」：" + topics + "，回复你时" + stats.replyStyle + "。" + caution;
}

function countActiveDays(chats) {
  const daySet = new Set();
  for (const c of chats) {
    if (c.ts) daySet.add(new Date(c.ts).toDateString());
  }
  return daySet.size;
}

function hasRecentActivity(chats, now) {
  return chats.some(c => wallAgeMs(c.ts, now) <= 7 * 86400000);
}

function analyzeRelationshipText(chats) {
  const stats = {
    techScore: 0,
    jokeScore: 0,
    totalTextLen: 0,
    textCount: 0,
  };
  for (const c of chats) {
    addTextStats(stats, typeof c.text === 'string' ? c.text : '');
  }
  return stats;
}

function addTextStats(stats, text) {
  if (!text) return;
  const lower = text.toLowerCase();
  stats.totalTextLen += text.length;
  stats.textCount++;
  if (containsAny(lower, TECH_KEYWORDS)) stats.techScore++;
  if (containsAny(lower, JOKE_KEYWORDS)) stats.jokeScore++;
}

function containsAny(text, keywords) {
  return keywords.some(function(keyword) {
    return text.includes(keyword);
  });
}

function calculateHumorTolerance(jokeScore, msgCount) {
  if (jokeScore <= 0 || msgCount <= 0) return 30;
  const jokeRatio = jokeScore / msgCount;
  return Math.min(clampScore(30 + jokeRatio * 100 * 0.4), 50);
}

function choosePreferredTone(stats) {
  if (stats.techScore > stats.jokeScore && stats.techScore > 0) return 'technical';
  if (stats.jokeScore > stats.techScore && stats.jokeScore > 0) return 'playful';
  if (stats.avgTextLen > 0 && stats.avgTextLen < 8 && stats.textCount >= 3) return 'concise';
  return 'normal';
}

function getLastActiveAt(chats) {
  if (!chats.length) return null;
  return chats[chats.length - 1].ts || null;
}

/**
 * 关系等级（中文 + 英文）
 */
export function getRelationshipLevel(score) {
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0) return { cn: '刚认识', en: 'new' };
  if (s < 20) return { cn: '刚认识', en: 'new' };
  if (s < 40) return { cn: '有点眼熟', en: 'familiar' };
  if (s < 60) return { cn: '常见群友', en: 'regular' };
  if (s < 80) return { cn: '熟人', en: 'close' };
  return { cn: '老熟人', en: 'old friend' };
}

function parseFirstSeen(value) {
  if (!value) return null;
  if (typeof value === 'number') return value > 1000000000000 ? value : value * 1000;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
