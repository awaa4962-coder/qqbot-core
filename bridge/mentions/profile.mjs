import { recentTopicEvidence } from "../memory-profile/evidence.mjs";
import { groupChats, users } from "../storage.mjs";
import { resolveMentionDisplayName } from "./resolve.mjs";

const MAX_PROFILES = 4;
const MAX_SUMMARY_CHARS = 700;

export function buildMentionedUserProfiles(mentions, options = {}) {
  const userMentions = (Array.isArray(mentions) ? mentions : [])
    .filter(item => !item.isBot && !item.isAll)
    .slice(0, options.limit || MAX_PROFILES);
  return userMentions.map(item => buildMentionProfile(item.qq, options));
}

function buildMentionProfile(uid, options) {
  const groupId = String(options.groupId || options.group_id || "");
  return {
    uid: String(uid),
    displayName: resolveMentionDisplayName(uid, {
      ...options,
      mention: findMention(uid, options.mentions),
    }),
    memorySummary: groupId && groupId !== "private"
      ? safeSummary(mentionTopicHints(uid, groupId, options))
      : "",
  };
}

function mentionTopicHints(uid, groupId, options) {
  try {
    const hints = recentTopicEvidence(uid, groupId, options);
    return hints.length ? "本群原话的话题线索，不代表偏好或事实：" + hints.map(item => item.label).join("；") : "";
  } catch { return ""; }
}

function findMention(uid, mentions) {
  return (Array.isArray(mentions) ? mentions : [])
    .find(item => String(item.qq) === String(uid));
}

export function buildMentionContextBlock(options = {}) {
  const mentions = Array.isArray(options.mentions) ? options.mentions : [];
  const userMentions = mentions.filter(item => !item.isBot && !item.isAll);
  const hasAll = mentions.some(item => item.isAll);
  if (!userMentions.length && !hasAll) return "";
  const profiles = buildMentionedUserProfiles(mentions, options);
  const lines = [
    "[Mention context]",
    "Use this only to understand who the current message mentioned. Do not reveal private history or treat mentioned users as the speaker.",
  ];
  if (hasAll) lines.push("mentioned=@all");
  for (const profile of profiles) {
    lines.push(formatMentionProfile(profile));
  }
  return lines.join("\n");
}

function formatMentionProfile(profile) {
  const parts = [
    "uid=" + profile.uid,
    "name=" + profile.displayName,
  ];
  if (profile.memorySummary) parts.push("profileSummary=" + profile.memorySummary);
  return "mentionedUser: " + parts.join("; ");
}

function safeSummary(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
}

export function buildStoredMentions(mentions, options = {}) {
  const groupId = String(options.groupId || options.group_id || "");
  return (Array.isArray(mentions) ? mentions : [])
    .slice(0, 8)
    .map(item => ({
      qq: String(item.qq),
      isBot: Boolean(item.isBot),
      isAll: Boolean(item.isAll),
      name: item.isBot || item.isAll ? "" : resolveMentionDisplayName(item.qq, {
        groupId,
        users: options.users || users,
        groupChats: options.groupChats || groupChats,
      }),
    }));
}
