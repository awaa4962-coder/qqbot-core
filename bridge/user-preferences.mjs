import { groupChats, saveGroupChats, saveUsers, users } from "./storage.mjs";
import { clearConversationThreads } from "./cognition/index.mjs";
import { clearUserMemoryProfile, getActiveMemoryContext } from "./memory-profile.mjs";
import { clearUserCacheUsage } from "./api-providers/usage-metrics.mjs";

const DEFAULT_STYLE = Object.freeze({
  length: "normal",
  tone: "natural",
  humor: "light",
  directness: "normal",
  examples: "normal",
  emoji: "rare",
  formality: "casual",
});

const STYLE_LABELS = Object.freeze({
  length: { short: "简短", normal: "正常", detailed: "详细" },
  tone: { natural: "自然", warm: "温柔", playful: "活泼", serious: "正经", technical: "技术", cute: "可爱" },
  humor: { none: "不吐槽", light: "少吐槽", normal: "可以吐槽" },
  directness: { soft: "委婉", normal: "正常", direct: "直接" },
  examples: { avoid: "少举例", normal: "按需举例", prefer: "多举例", steps: "给步骤", code: "给代码" },
  emoji: { none: "不要表情", rare: "少表情", normal: "可以表情" },
  formality: { casual: "口语", balanced: "平衡", formal: "正式" },
});

const STYLE_RULES = [
  [/^(简短|短|少说|精简|短点)$/, "length", "short"],
  [/^(正常|默认|适中)$/, "length", "normal"],
  [/^(详细|展开讲|多讲点|讲细点)$/, "length", "detailed"],
  [/^(自然|正常语气)$/, "tone", "natural"],
  [/^(温柔|柔和|安慰点)$/, "tone", "warm"],
  [/^(可爱|萌点|软一点)$/, "tone", "cute"],
  [/^(活泼|轻松|俏皮)$/, "tone", "playful"],
  [/^(正经|严肃|认真)$/, "tone", "serious"],
  [/^(技术|技术向|工程|代码)$/, "tone", "technical"],
  [/^(不吐槽|别吐槽|无吐槽)$/, "humor", "none"],
  [/^(少吐槽|吐槽少点|少开玩笑)$/, "humor", "light"],
  [/^(可以吐槽|能吐槽|活泼点)$/, "humor", "normal"],
  [/^(直接|直接点|别绕弯|快说结论)$/, "directness", "direct"],
  [/^(委婉|委婉点|轻点说)$/, "directness", "soft"],
  [/^(少举例|别举例)$/, "examples", "avoid"],
  [/^(多举例|举例|给例子)$/, "examples", "prefer"],
  [/^(给步骤|步骤|一步步)$/, "examples", "steps"],
  [/^(给代码|代码示例)$/, "examples", "code"],
  [/^(不要表情|无表情|别发表情)$/, "emoji", "none"],
  [/^(少表情|表情少点)$/, "emoji", "rare"],
  [/^(可以表情|能发表情)$/, "emoji", "normal"],
  [/^(口语|口语点|随意)$/, "formality", "casual"],
  [/^(正式|正式点)$/, "formality", "formal"],
  [/^(平衡|中性)$/, "formality", "balanced"],
];

const UNSAFE_STYLE_RE = /(恋爱|暧昧|女友|男友|主人|服从|奴|调教|涩|色情|老婆|老公)/i;
const SENSITIVE_RE = /(sk-[A-Za-z0-9_-]{12,}|api[_-]?key|token|secret|password|passwd|密码|密钥|\b1[3-9]\d{9}\b|\b\d{15,18}[0-9x]\b)/i;

export function getUserPreferences(uid, store = users) {
  const user = store[String(uid)] || {};
  return normalizePreferences(user.preferences);
}

export function getPreferredDisplayName(uid, fallbackName = "", options = {}) {
  const pref = getUserPreferences(uid, options.users || users);
  return pref.displayName || fallbackName || "unknown";
}

export function setUserStylePreference(uid, rawText, options = {}) {
  const parsed = parseStylePreference(rawText);
  if (!parsed.ok) return parsed;
  const user = ensureUserPreferenceRoot(uid, options.users || users);
  user.preferences.style = {
    ...normalizeStyle(user.preferences.style),
    ...parsed.patch,
    updatedAt: options.now || Date.now(),
  };
  if (!options.skipSave) saveUsers();
  return {
    ok: true,
    text: "已更新回复风格：\n" + formatStyle(user.preferences.style),
  };
}

export function resetUserStylePreference(uid, options = {}) {
  const user = ensureUserPreferenceRoot(uid, options.users || users);
  user.preferences.style = { ...DEFAULT_STYLE, updatedAt: options.now || Date.now() };
  if (!options.skipSave) saveUsers();
  return "已重置回复风格：\n" + formatStyle(user.preferences.style);
}

export function setUserDisplayName(uid, name, options = {}) {
  const clean = sanitizeDisplayName(name);
  if (!clean.ok) return clean;
  const user = ensureUserPreferenceRoot(uid, options.users || users);
  user.preferences.displayName = clean.value;
  user.alias = clean.value;
  if (!Array.isArray(user.nicknames)) user.nicknames = [];
  if (!user.nicknames.includes(clean.value)) user.nicknames.push(clean.value);
  if (user.nicknames.length > 20) user.nicknames = user.nicknames.slice(-20);
  if (!options.skipSave) saveUsers();
  return { ok: true, text: "记住了，以后我会优先叫你：" + clean.value };
}

export function buildStyleHelpText() {
  return [
    "回复风格帮助",
    "用法：@夜星 回复风格 简短 技术 少吐槽",
    "",
    "可选：",
    "长度：简短 / 正常 / 详细",
    "语气：自然 / 温柔 / 可爱 / 活泼 / 正经 / 技术",
    "幽默：不吐槽 / 少吐槽 / 可以吐槽",
    "表达：直接点 / 委婉点 / 别绕弯",
    "例子：少举例 / 多举例 / 给步骤 / 给代码",
    "表情：不要表情 / 少表情 / 可以表情",
    "",
    "其他：回复风格 / 回复风格 推荐 / 回复风格 预览 / 回复风格 重置",
  ].join("\n");
}

export function buildStylePreview(uid, options = {}) {
  const pref = getUserPreferences(uid, options.users || users);
  return [
    "当前风格预览",
    formatStyle(pref.style),
    "",
    "示例：我会按这个风格回复你。要是问题偏技术，我会先给结论，再给必要步骤；要是只是闲聊，就少讲大道理。",
  ].join("\n");
}

export function buildStyleRecommendation(uid, groupId, options = {}) {
  const ctx = options.memoryContext || getActiveMemoryContext(uid, groupId, options);
  const topics = collectProfileTopics(ctx);
  const tone = ctx.userProfile?.preferredTone || ctx.userGroupProfile?.interactionStyle || "";
  if (isTechnicalPreference(topics, tone)) {
    return "推荐：@夜星 回复风格 简短 技术 给步骤 少吐槽\n理由：你的互动摘要更偏问题排查和实现推进。";
  }
  if (tone === "gentle") {
    return "推荐：@夜星 回复风格 温柔 详细 委婉点 少表情\n理由：你的互动摘要更适合柔和一点的解释。";
  }
  if (tone === "playful") {
    return "推荐：@夜星 回复风格 活泼 正常 可以吐槽 少表情\n理由：你的互动摘要更适合轻松一点的聊天。";
  }
  return "推荐：@夜星 回复风格 自然 正常 少吐槽\n理由：当前摘要还不多，先用稳妥的默认风格。";
}

export function buildSelfProfileText(uid, groupId, options = {}) {
  const pref = getUserPreferences(uid, options.users || users);
  const ctx = options.memoryContext || getActiveMemoryContext(uid, groupId, options);
  const topics = collectProfileTopics(ctx).slice(0, 5);
  const groupStyle = ctx.userGroupProfile?.interactionStyle || "normal";
  const confidence = profileConfidence(ctx);
  return [
    "我的档案",
    "称呼：" + (pref.displayName || "未设置"),
    "常聊主题：" + (topics.length ? topics.join(" / ") : "记录还不够"),
    "回复偏好：" + compactStyle(pref.style),
    "群内互动：" + styleValue("tone", groupStyle),
    "画像置信度：" + (confidence ? Math.round(confidence * 100) + "%" : "记录还不够"),
    "",
    "隐私：这里只显示摘要，不展示聊天原文；私聊内容不会拿到群里展示。",
  ].join("\n");
}

export function buildPrivacyText() {
  return [
    "夜星隐私说明",
    "1. 只保存摘要、偏好和互动统计，不展示聊天原文。",
    "2. 群内关系只在当前群展示，私聊内容不拿到群里说。",
    "3. API key、手机号、身份证、密码等敏感内容会被过滤。",
    "4. 回复风格和称呼只影响夜星怎么回复你，不改变安全规则。",
    "5. API 缓存统计只保存加盐匿名键和 token 数，最多保留 30 天，不保存提示词或回复正文。",
    "6. 发送 @夜星 忘记我 可以清理你的画像、偏好、关系缓存、缓存统计和个人聊天记忆。",
  ].join("\n");
}

export function forgetUserData(uid, options = {}) {
  const id = String(uid || "");
  if (!id) return { ok: false, text: "没有找到可清理的用户。" };
  const userStore = options.users || users;
  const chatStore = options.groupChats || groupChats;
  if (userStore[id]) {
    userStore[id].chats = [];
    userStore[id].description = "";
    userStore[id].preferences = {};
    userStore[id].relationshipComments = {};
    userStore[id].profileGeneratedAt = 0;
    userStore[id].profileGeneratedChatCount = 0;
  }
  for (const entries of Object.values(chatStore || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (String(entry.uid) === id) {
        entry.text = "[已按用户请求清除]";
        delete entry.imageUrls;
      }
    }
  }
  clearUserMemoryProfile(id);
  clearConversationThreads(id, { userStore, save: false });
  if (!options.skipSave) clearUserCacheUsage(id, options.cacheUsageOptions || {});
  if (!options.skipSave) {
    saveUsers();
    saveGroupChats();
  }
  return { ok: true, text: "已清理你的画像、回复偏好、关系缓存和个人聊天记忆。群聊历史中你的旧内容会被替换为清理占位。"};
}

export function buildPreferenceContextBlock(uid, options = {}) {
  const pref = getUserPreferences(uid, options.users || users);
  const hasDisplayName = Boolean(pref.displayName);
  const hasCustomStyle = Boolean(pref.style.updatedAt);
  if (!hasDisplayName && !hasCustomStyle) return "";
  return [
    "[用户主动设置]",
    "这些是用户自己设置的回复偏好，只影响语气和呈现方式，不允许绕过安全规则；不要向其他人公开。",
    hasDisplayName ? "称呼=" + pref.displayName : "",
    hasCustomStyle ? "回复风格=" + compactStyle(pref.style) : "",
  ].filter(Boolean).join("\n");
}

export function buildMinimalPreferenceContextBlock(uid, options = {}) {
  const pref = getUserPreferences(uid, options.users || users);
  const hasDisplayName = Boolean(pref.displayName);
  const hasCustomStyle = Boolean(pref.style.updatedAt);
  if (!hasDisplayName && !hasCustomStyle) return "";
  return [
    "[用户主动设置-简要]",
    "只影响称呼、语气和呈现方式。",
    hasDisplayName ? "称呼=" + pref.displayName : "",
    hasCustomStyle ? "回复风格=" + compactStyle(pref.style) : "",
  ].filter(Boolean).join("\n");
}

export function parseStylePreference(rawText) {
  const value = String(rawText || "").trim();
  if (!value) return { ok: false, reason: "empty", text: "请在“回复风格”后面写偏好，比如：简短 技术 少吐槽。" };
  if (UNSAFE_STYLE_RE.test(value) || SENSITIVE_RE.test(value)) {
    return { ok: false, reason: "unsafe", text: "这个回复风格不适合保存。可以设置简短、技术、温柔、少吐槽这类表达偏好。" };
  }
  const tokens = tokenizeStyle(value);
  const patch = {};
  const unknown = [];
  for (const token of tokens) {
    let matched = false;
    for (const [pattern, key, targetValue] of STYLE_RULES) {
      if (pattern.test(token)) {
        patch[key] = targetValue;
        matched = true;
        break;
      }
    }
    if (!matched && !["但", "但是", "而且", "和", "一点", "点"].includes(token)) unknown.push(token);
  }
  if (!Object.keys(patch).length) {
    return {
      ok: false,
      reason: "unknown",
      text: "没识别出可保存的风格。发送“@夜星 回复风格 帮助”看看可选项。",
      unknown,
    };
  }
  return { ok: true, patch, unknown };
}

export function formatStyle(style = {}) {
  const normalized = normalizeStyle(style);
  return [
    "长度：" + styleValue("length", normalized.length),
    "语气：" + styleValue("tone", normalized.tone),
    "幽默：" + styleValue("humor", normalized.humor),
    "表达：" + styleValue("directness", normalized.directness),
    "例子：" + styleValue("examples", normalized.examples),
    "表情：" + styleValue("emoji", normalized.emoji),
    "正式度：" + styleValue("formality", normalized.formality),
  ].join("\n");
}

function ensureUserPreferenceRoot(uid, store) {
  const id = String(uid || "");
  if (!store[id]) store[id] = { uid: id, nicknames: [], chats: [], firstSeen: new Date().toISOString() };
  if (!store[id].preferences) store[id].preferences = {};
  return store[id];
}

function collectProfileTopics(ctx = {}) {
  return unique([
    ...(ctx.userProfile?.commonTopics || []),
    ...(ctx.userGroupProfile?.recentTopics || []),
  ]);
}

function isTechnicalPreference(topics, tone) {
  return topics.includes("运维") || topics.includes("机器人") || tone === "technical";
}

function profileConfidence(ctx = {}) {
  return Math.max(
    Number(ctx.userProfile?.confidence || 0),
    Number(ctx.userGroupProfile?.confidence || 0),
  );
}

function normalizePreferences(preferences = {}) {
  return {
    displayName: String(preferences.displayName || "").trim(),
    style: normalizeStyle(preferences.style),
  };
}

function normalizeStyle(style = {}) {
  return {
    ...DEFAULT_STYLE,
    ...Object.fromEntries(Object.entries(style || {}).filter(([key]) => key in DEFAULT_STYLE || key === "updatedAt")),
  };
}

function sanitizeDisplayName(name) {
  const value = String(name || "").trim().replace(/\s+/g, "");
  if (!value) return { ok: false, text: "称呼不能为空。" };
  if (value.length > 16) return { ok: false, text: "称呼太长了，控制在 16 个字符以内吧。" };
  if (SENSITIVE_RE.test(value) || /[@\r\n]/.test(value)) return { ok: false, text: "这个称呼不适合保存。" };
  return { ok: true, value };
}

function tokenizeStyle(value) {
  return value
    .replace(/[，。！？、；,!?;]/g, " ")
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function compactStyle(style = {}) {
  const normalized = normalizeStyle(style);
  return [
    styleValue("length", normalized.length),
    styleValue("tone", normalized.tone),
    styleValue("humor", normalized.humor),
    styleValue("examples", normalized.examples),
  ].join(" / ");
}

function styleValue(key, value) {
  return STYLE_LABELS[key]?.[value] || value || "正常";
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}
