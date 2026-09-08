import { getActiveMemoryContext } from "./query.mjs";

export function buildMemorySummary(uid, groupId, options = {}) {
  const ctx = getActiveMemoryContext(uid, groupId, options);
  const lines = [];
  if (ctx.userProfile) {
    lines.push("用户画像: " + compactProfile(ctx.userProfile, ["preferredTone", "replyStyle", "commonTopics", "dislikes", "confidence"]));
  }
  if (ctx.groupProfile) {
    lines.push("群画像: " + compactProfile(ctx.groupProfile, ["tone", "activeTopics", "jokeLevel", "interjectionTolerance"]));
  }
  if (ctx.userGroupProfile) {
    lines.push("群内互动画像: " + compactProfile(ctx.userGroupProfile, ["interactionStyle", "recentTopics", "confidence"]));
  }
  return lines.join("\n");
}

export function buildHumanMemorySummary(uid, groupId, options = {}) {
  const ctx = getActiveMemoryContext(uid, groupId, options);
  const lines = [];
  if (ctx.userProfile) lines.push("用户画像：" + describeUserProfile(ctx.userProfile));
  if (ctx.groupProfile) lines.push("群画像：" + describeGroupProfile(ctx.groupProfile));
  if (ctx.userGroupProfile) lines.push("群内互动画像：" + describeUserGroupProfile(ctx.userGroupProfile));
  return lines.join("\n");
}

export function compactProfile(profile, keys) {
  return keys.map(key => {
    const value = profile[key];
    if (Array.isArray(value)) return key + "=" + (value.length ? value.join(",") : "无");
    if (typeof value === "number") return key + "=" + value.toFixed(2);
    return key + "=" + (value || "normal");
  }).join("; ");
}

export function describeUserProfile(profile) {
  return [
    "回复偏好偏 " + toneLabel(profile.preferredTone),
    "表达长度偏 " + toneLabel(profile.replyStyle),
    "常聊主题：" + listLabel(profile.commonTopics),
    "避雷点：" + listLabel(profile.dislikes),
    "可信度：" + confidenceLabel(profile.confidence),
  ].join("；");
}

export function describeGroupProfile(profile) {
  return [
    "群氛围偏 " + toneLabel(profile.tone),
    "活跃主题：" + listLabel(profile.activeTopics),
    "玩笑尺度：" + toneLabel(profile.jokeLevel),
    "插话容忍度：" + toneLabel(profile.interjectionTolerance),
  ].join("；");
}

export function describeUserGroupProfile(profile) {
  return [
    "群内互动风格偏 " + toneLabel(profile.interactionStyle),
    "近期主题：" + listLabel(profile.recentTopics),
    "可信度：" + confidenceLabel(profile.confidence),
  ].join("；");
}

export function listLabel(value) {
  return Array.isArray(value) && value.length ? value.join("、") : "暂无明显记录";
}

export function confidenceLabel(value) {
  const score = Number(value || 0);
  if (score >= 0.75) return "较高";
  if (score >= 0.35) return "中等";
  if (score > 0) return "较低";
  return "暂无";
}

export function toneLabel(value) {
  const labels = {
    normal: "自然",
    concise: "简短",
    serious: "认真",
    technical: "技术",
    playful: "轻松玩笑",
    gentle: "温和",
    quiet: "安静",
    high: "较高",
    low: "较低",
  };
  return labels[value] || "自然";
}
